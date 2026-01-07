import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import appConfig from '../../../config/app.config';
import type { ConfigType } from '@nestjs/config';
import { EventsGateway } from '../../../events/events.gateway';
import { RedisService } from '../../../redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { getAviatorStateKey, getAviatorRoundBetsKey, getAviatorCrashPointKey, getAviatorMarketFilterKey, getAviatorHistoryKey } from '../../../redis/redis.keys';
import { v4 as uuidv4 } from 'uuid';

export enum GamePhase {
    BETTING = 'BETTING',
    FLYING = 'FLYING',
    CRASHED = 'CRASHED',
}

export interface AviatorState {
    phase: GamePhase;
    roundId: string;
    startTime: number;
    multiplier: number;
    nextPhaseTime?: number;
    activeStock?: string;
    futureStocks?: string[];
}

import * as os from 'os';

@Injectable()
export class AviatorGameLoopService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AviatorGameLoopService.name);
    private loops: Map<string, NodeJS.Timeout> = new Map();
    private active = false;
    private readonly instanceId = os.hostname() + '-' + uuidv4();

    private readonly BETTING_DURATION_MS: number;
    private readonly POST_CRASH_DURATION_MS: number;
    private readonly TICK_RATE_MS = 200; // 5Hz updates (Optimized for CPU)
    private readonly GROWTH_RATE = 0.00006;

    constructor(
        private readonly redisService: RedisService,
        private readonly eventsGateway: EventsGateway,
        private readonly httpService: HttpService,
        @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    ) {
        this.BETTING_DURATION_MS = this.config.aviator.bettingDurationMs;
        this.POST_CRASH_DURATION_MS = this.config.aviator.postCrashDurationMs;
    }

    onModuleInit() {
        this.active = true;
        this.logger.log(`Starting Aviator Game Loops (Instance: ${this.instanceId})...`);
        const markets = this.config.subscribeChannels;
        markets.forEach(room => this.runGameLoop(room));
    }

    onModuleDestroy() {
        this.active = false;
        this.loops.forEach(timeout => clearTimeout(timeout));
    }

    private async runGameLoop(room: string) {
        if (!this.active) return;

        // Leader Election: Try to acquire lock for 10 seconds (TTL)
        // If we get it, we are the leader for this tick.
        const lockKey = `lock:gameloop:${room}`;
        const isLeader = await this.acquireOrExtendLock(lockKey, this.instanceId, 10000);

        if (!isLeader) {
            // Not the leader? Sleep for 5s and check again.
            // If the leader dies, the lock expires and we take over.
            this.scheduleNext(room, 5000, () => this.runGameLoop(room));
            return;
        }

        try {
            await this.processGameTick(room);
        } catch (error) {
            this.logger.error(`Critical Error in Game Loop (${room}): ${error.message}`, error.stack);
            this.scheduleNext(room, 5000, () => this.runGameLoop(room));
        }
    }

    /**
     * Atomic Leader Election Script (Lua)
     * - Returns true if lock acquired or extended.
     * - Returns false if locked by another instance.
     */
    private async acquireOrExtendLock(key: string, value: string, ttlMs: number): Promise<boolean> {
        const client = this.redisService.getStateClient();

        // Lua script:
        // If key == my_value OR key does not exist:
        //    Set key = my_value with TTL
        //    Return 1 (Success)
        // Else:
        //    Return 0 (Failed)
        const script = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("pexpire", KEYS[1], ARGV[2])
            elseif redis.call("set", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
                return 1
            else
                return 0
            end
        `;

        try {
            const result = await client.eval(script, {
                keys: [key],
                arguments: [value, String(ttlMs)]
            });
            return result === 1 || result === 'OK';
        } catch (e) {
            this.logger.warn(`Redis Lock Error: ${e.message}`);
            return false;
        }
    }

    private async processGameTick(room: string) {
        const stateKey = getAviatorStateKey(room);
        const rawState = await this.redisService.get(stateKey);

        if (!rawState) {
            await this.startBettingPhase(room);
            return;
        }

        const state: AviatorState = JSON.parse(rawState);
        const now = Date.now();

        switch (state.phase) {
            case GamePhase.BETTING:
                if (now >= state.nextPhaseTime!) {
                    await this.startFlyingPhase(room, state.roundId);
                } else {
                    this.scheduleNext(room, 200, () => this.runGameLoop(room));
                }
                break;

            case GamePhase.FLYING:
                await this.updateFlyingState(room, state);
                break;

            case GamePhase.CRASHED:
                if (now >= state.nextPhaseTime!) {
                    await this.startBettingPhase(room);
                } else {
                    this.scheduleNext(room, 500, () => this.runGameLoop(room));
                }
                break;
        }
    }

    private async startBettingPhase(room: string) {
        const roundId = uuidv4();
        const endTime = Date.now() + this.BETTING_DURATION_MS;

        // --- Stock Queue Logic ---
        const queueKey = `aviator:queue:${room}`;
        const marketData = this.redisService.getLastMarketPayload(room);
        let availableStocks: string[] = [];

        if (marketData && marketData.symbols) {
            availableStocks = Object.keys(marketData.symbols);
        }

        // 1. Ensure Queue has 5 items
        const currentQueueLen = await this.redisService.getStateClient().lLen(queueKey);
        const needed = 5 - currentQueueLen;

        if (needed > 0 && availableStocks.length > 0) {
            for (let i = 0; i < needed; i++) {
                const randomStock = availableStocks[Math.floor(Math.random() * availableStocks.length)];
                await this.redisService.getStateClient().rPush(queueKey, randomStock);
            }
        }

        // 2. Pop the Active Stock for this round
        let activeStock = await this.redisService.getStateClient().lPop(queueKey);

        // Fallback if queue failed or empty (e.g. no market data yet)
        if (!activeStock) {
            activeStock = availableStocks.length > 0 ? availableStocks[0] : 'BTC'; // Default fallback
        }

        // 3. Peek at future stocks for UI
        const futureStocks = await this.redisService.getStateClient().lRange(queueKey, 0, 4);

        // 4. Update Filter Key for RedisService to reduce bandwidth
        const interestList = [activeStock, ...futureStocks].filter(Boolean);
        await this.redisService.set(getAviatorMarketFilterKey(room), JSON.stringify(interestList));

        this.logger.log(`[${room}] Round ${roundId} Started. Stock: ${activeStock} (Queue: ${futureStocks.join(',')})`);

        const state: AviatorState = {
            phase: GamePhase.BETTING,
            roundId,
            startTime: Date.now(),
            multiplier: 1.00,
            nextPhaseTime: endTime,
            activeStock,
            futureStocks
        };

        await this.saveAndBroadcastState(room, state);
        this.scheduleNext(room, this.BETTING_DURATION_MS, () => this.runGameLoop(room));
    }

    private async startFlyingPhase(room: string, roundId: string) {
        const state: AviatorState = {
            phase: GamePhase.FLYING,
            roundId,
            startTime: Date.now(),
            multiplier: 1.00
        };

        this.logger.log(`[${room}] Took Off! Watching for negative delta...`);
        await this.saveAndBroadcastState(room, state);

        this.runGameLoop(room);
    }

    private async updateFlyingState(room: string, currentState: AviatorState) {
        const now = Date.now();
        const timeElapsed = now - currentState.startTime;

        // The multiplier increases with time, but validity depends on Stock Delta.
        let newMultiplier = parseFloat(Math.exp(this.GROWTH_RATE * timeElapsed).toFixed(2));

        const marketData = this.redisService.getLastMarketPayload(room);

        let shouldCrash = false;

        if (marketData && marketData.symbols) {
            const activeStock = currentState.activeStock;

            if (activeStock && marketData.symbols[activeStock]) {
                const stockInfo = marketData.symbols[activeStock];
                // Crash ONLY if the Active Stock drops
                if (stockInfo.delta < 0) {
                    shouldCrash = true;
                    this.logger.log(`[${room}] Stock ${activeStock} Dropped! Delta ${stockInfo.delta}. Crashing...`);
                }
            } else {
                // Active stock missing from payload? Maybe market closed or API issue.
                // We can either crash (safe) or ignore (ride). 
                // Let's safe crash to prevent issues.
                shouldCrash = true;
                this.logger.warn(`[${room}] Active Stock ${activeStock} missing from market feed. Safety Crash.`);
            }

        } else {
            shouldCrash = true;
            this.logger.warn(`[${room}] No Market Data available. Safety Crash.`);
        }

        // Hard Cap at 1000x remains a system necessity to prevent overflows/floating point errors, 
        // but functionally it's "Pure Delta" below that.
        if (newMultiplier >= 1000.00) shouldCrash = true;

        if (shouldCrash) {
            await this.crash(room, currentState.roundId, newMultiplier);
        } else {
            // Update state
            currentState.multiplier = newMultiplier;
            await this.redisService.set(getAviatorStateKey(room), JSON.stringify(currentState), 30);

            this.eventsGateway.server.to(room).emit('game:fly', {
                multiplier: newMultiplier
            });

            this.scheduleNext(room, this.TICK_RATE_MS, () => this.runGameLoop(room));
        }
    }

    private async crash(room: string, roundId: string, finalMultiplier: number) {
        this.logger.log(`[${room}] CRASHED at ${finalMultiplier}x`);

        const state: AviatorState = {
            phase: GamePhase.CRASHED,
            roundId,
            startTime: Date.now(),
            multiplier: finalMultiplier,
            nextPhaseTime: Date.now() + this.POST_CRASH_DURATION_MS
        };

        await this.saveAndBroadcastState(room, state);
        await this.processRoundResults(room, roundId, finalMultiplier);

        this.scheduleNext(room, this.POST_CRASH_DURATION_MS, () => this.runGameLoop(room));
    }

    private async processRoundResults(room: string, roundId: string, crashPoint: number) {
        // Here we would handle any bets that HAVEN'T cashed out and mark them as lost.
        // Bets that cashed out were handled immediately in the cashOut method (in BetService).

        const betsKey = getAviatorRoundBetsKey(room, roundId);

        // Cleanup: Delete the bets key to prevent storage leaks
        // If we need history, we should push to a separate list/DB before deleting, 
        // or set a short expiration (e.g. 1 hour) instead of immediate delete.

        // For now, expire in 1 hour to allow for debugging/history inspection if needed, then auto-delete.
        await this.redisService.expire(betsKey, 3600);

        // --- History Logic ---
        const historyKey = getAviatorHistoryKey(room);
        const historyItem = {
            roundId,
            crashPoint,
            timestamp: Date.now()
        };
        // Push new result to HEAD of list
        await this.redisService.getStateClient().lPush(historyKey, JSON.stringify(historyItem));
        // Keep only last 50 rounds
        await this.redisService.getStateClient().lTrim(historyKey, 0, 49);

    }

    private async saveAndBroadcastState(room: string, state: AviatorState) {
        await this.redisService.set(getAviatorStateKey(room), JSON.stringify(state));
        // Inject server time for client synchronization
        const payload = { ...state, timestamp: Date.now() };
        this.eventsGateway.server.to(room).emit('game:phase', payload);
    }

    private scheduleNext(room: string, delay: number, callback: () => void) {
        if (this.loops.has(room)) clearTimeout(this.loops.get(room));
        const timeout = setTimeout(callback, delay);
        this.loops.set(room, timeout);
    }


}
