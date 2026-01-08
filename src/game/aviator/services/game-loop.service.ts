import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import appConfig from '../../../config/app.config';
import type { ConfigType } from '@nestjs/config';
import { EventsGateway } from '../../../events/events.gateway';
import { RedisService } from '../../../redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { MarketStatusService } from 'src/markets/market-status.service';
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
    startPrice?: number;
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
    private readonly TICK_RATE_MS = 200;
    private readonly GROWTH_RATE = 0.00006;
    private readonly CRASH_TOLERANCE = -0.0005;
    private readonly GRACE_PERIOD_MS = 2000;
    private readonly STALE_DATA_THRESHOLD_MS = 5000;

    constructor(
        private readonly redisService: RedisService,
        private readonly eventsGateway: EventsGateway,
        private readonly httpService: HttpService,
        private readonly marketStatusService: MarketStatusService,
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

        // Check Market Status
        if (!this.marketStatusService.isMarketOpen(room)) {
            // Market is Closed. Sleep for 60s and retry.
            // this.logger.debug(`Market ${room} is CLOSED. Waiting...`);
            this.eventsGateway.broadcastMarketStatus(room, 'CLOSED');
            this.scheduleNext(room, 60000, () => this.runGameLoop(room));
            return;
        }

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
        let startPrice = 0;
        const marketData = this.redisService.getLastMarketPayload(room);
        const currentState = await this.redisService.get(getAviatorStateKey(room));
        if (marketData && currentState) {
            const stateObj = JSON.parse(currentState);
            const activeStock = stateObj.activeStock;
            if (activeStock && marketData.symbols && marketData.symbols[activeStock]) {
                startPrice = marketData.symbols[activeStock].price;
            }
        }

        const state: AviatorState = {
            phase: GamePhase.FLYING,
            roundId,
            startTime: Date.now(),
            multiplier: 1.00,
            // Carry over stock info so we don't lose it
            activeStock: marketData?.symbols ? (JSON.parse(currentState!).activeStock) : undefined,
            // Ideally we should just update the existing state object instead of recreating it entirely, 
            // but to be safe let's just grab activeStock from Redis state if possible or rely on the fact that updateFlying reads it? 
            // Actually updateFlying reads 'currentState' passed to it. 
            // Let's ensure 'activeStock' is preserved.
            // BETTER: Read Full Previous State
        };

        // Let's refactor slightly to be safer
        const rawPrev = await this.redisService.get(getAviatorStateKey(room));
        const prev = rawPrev ? JSON.parse(rawPrev) : {};

        const flyingState: AviatorState = {
            ...prev,
            phase: GamePhase.FLYING,
            startTime: Date.now(),
            multiplier: 1.00,
            startPrice: startPrice > 0 ? startPrice : undefined
        };

        this.logger.log(`[${room}] Took Off! Stock: ${flyingState.activeStock} @ ${startPrice}`);
        await this.saveAndBroadcastState(room, flyingState);

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

            // --- STALE DATA CHECK ---
            const dataAge = now - Number(marketData.timestamp || 0);
            if (dataAge > this.STALE_DATA_THRESHOLD_MS) {
                shouldCrash = true;
                this.logger.warn(`[${room}] Market Data STALE (Age: ${dataAge}ms). Safety Crash.`);
            } else {
                const activeStock = currentState.activeStock;

                if (activeStock && marketData.symbols[activeStock]) {
                    const stockInfo = marketData.symbols[activeStock];
                    const currentPrice = stockInfo.price;
                    const startPrice = currentState.startPrice || currentPrice; // Fallback if missing

                    // --- CUMULATIVE DELTA LOGIC ---
                    // Compare Current Price vs Takeoff Price
                    // Formula: (Current - Start) / Start
                    const drift = (currentPrice - startPrice) / startPrice;

                    // Crash if Total Drift is below tolerance (Net Negative)
                    if (drift < this.CRASH_TOLERANCE) {
                        shouldCrash = true;
                        this.logger.log(`[${room}] Stock ${activeStock} Tanked! Drift: ${(drift * 100).toFixed(4)}% (Price: ${startPrice} -> ${currentPrice}). Crashing...`);
                    }
                } else {
                    // Active stock missing from payload? Maybe market closed or API issue.
                    // We can either crash (safe) or ignore (ride). 
                    // Let's safe crash to prevent issues.
                    shouldCrash = true;
                    this.logger.warn(`[${room}] Active Stock ${activeStock} missing from market feed. Safety Crash.`);
                }
            }

        } else {
            // No market data at all
            shouldCrash = true;
            this.logger.warn(`[${room}] No Market Data available. Safety Crash.`);
        }

        // --- GRACE PERIOD LOGIC ---
        // If we represent a "Real Stock", we shouldn't crash on the runway.
        // Ignore all crashes (except manual force/safety?) for the first 2 seconds.
        if (shouldCrash && timeElapsed < this.GRACE_PERIOD_MS) {
            this.logger.debug(`[${room}] Saved by Grace Period (${timeElapsed}ms)`);
            shouldCrash = false;
        }

        // Hard Cap at 1000x remains a system necessity to prevent overflows/floating point errors,

        // Hard Cap at 1000x remains a system necessity to prevent overflows/floating point errors, 
        // but functionally it's "Pure Delta" below that.
        if (newMultiplier >= 1000.00) shouldCrash = true;

        if (shouldCrash) {
            await this.crash(room, currentState.roundId, newMultiplier);
        } else {
            // Update state
            currentState.multiplier = newMultiplier;
            await this.redisService.set(getAviatorStateKey(room), JSON.stringify(currentState), 30);

            // VERIFICATION LOGGING: Show drift while flying
            const activeStock = currentState.activeStock;
            if (activeStock && marketData && marketData.symbols && marketData.symbols[activeStock]) {
                const stockInfo = marketData.symbols[activeStock];
                const currentPrice = stockInfo.price;
                // Ensure startPrice is valid, fallback to current if 0 or undefined
                const startPrice = (currentState.startPrice && currentState.startPrice > 0) ? currentState.startPrice : currentPrice;

                let drift = 0;
                if (startPrice > 0) {
                    drift = (currentPrice - startPrice) / startPrice;
                }

                this.logger.log(`[${room}] ✈️ ${newMultiplier}x | Stock: ${activeStock} | ${startPrice} -> ${currentPrice} | Drift: ${(drift * 100).toFixed(4)}%`);
            } else {
                if (!activeStock) {
                    this.logger.error(`[${room}] MISSING ACTIVE STOCK in Flight State. Aborting Log. State: ${JSON.stringify(currentState)}`);
                } else if (!marketData || !marketData.symbols || !marketData.symbols[activeStock]) {
                    // this.logger.warn(`[${room}] Active Stock ${activeStock} not found in market payload.`);
                }
            }

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
