import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import appConfig from '../../../config/app.config';
import type { ConfigType } from '@nestjs/config';
import { EventsGateway } from '../../../events/events.gateway';
import { PlinkoPriceService } from './price.service';
import { RedisService } from '../../../redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { getPlinkoStateKey, getPlinkoRoundBetsKey } from '../../../redis/redis.keys';
import { v4 as uuidv4 } from 'uuid';

export enum GamePhase {
    BETTING = 'BETTING',       // 10s
    ACCUMULATION = 'LOCKED',   // 5s
    DROPPING = 'DROPPING',     // 10s
    PAUSED = 'PAUSED'          // Circuit Breaker
}

@Injectable()
export class PlinkoGameLoopService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PlinkoGameLoopService.name);
    private loops: Map<string, NodeJS.Timeout> = new Map();
    private active = false;

    constructor(
        private readonly priceService: PlinkoPriceService,
        private readonly redisService: RedisService,
        private readonly eventsGateway: EventsGateway,
        private readonly httpService: HttpService,
        @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    ) { }

    onModuleInit() {
        this.active = true;
        this.logger.log('Starting Plinko Game Loops...');
        const markets = this.config.subscribeChannels;
        markets.forEach(market => this.runGameLoop(market));
    }

    onModuleDestroy() {
        this.active = false;
        this.loops.forEach(timeout => clearTimeout(timeout));
    }

    /**
     * The Main Recursive Loop
     * This replaces your setInterval to prevent drift and overlapping executions.
     */
    private async runGameLoop(market: string) {
        if (!this.active) return;

        try {
            const isHealthy = await this.checkMarketHealth(market);
            if (!isHealthy) {
                this.scheduleNext(market, 2000, () => this.runGameLoop(market));
                return;
            }

            await this.processGameTick(market);

        } catch (error) {
            this.logger.error(`Critical Error in Game Loop (${market}): ${error.message}`, error.stack);
            this.scheduleNext(market, 5000, () => this.runGameLoop(market));
        }
    }

    /**
     * Checks data freshness. Pauses game if stale.
     * Returns TRUE if healthy, FALSE if paused.
     */
    private async checkMarketHealth(market: string): Promise<boolean> {
        const snapshot = await this.priceService.getMarketSnapshot(market);

        const isFresh = snapshot && this.priceService.isSnapshotFresh(snapshot, 5);

        if (!isFresh) {
            const stateKey = getPlinkoStateKey(market);
            const rawState = await this.redisService.get(stateKey);
            const state = rawState ? JSON.parse(rawState) : {};

            if (state.phase !== GamePhase.PAUSED) {
                this.logger.warn(`[Circuit Breaker] Market ${market} stale. Triggering Emergency Stop.`);
                await this.handleEmergencyClose(market);

                await this.redisService.set(stateKey, JSON.stringify({
                    phase: GamePhase.PAUSED,
                    message: 'Market data unstable',
                    nextCheck: Date.now() + 2000
                }));

                this.eventsGateway.broadcastMarketStatus(market, 'CLOSED', 'Market data unavailable');
            }
            return false;
        }

        const stateKey = getPlinkoStateKey(market);
        const rawState = await this.redisService.get(stateKey);
        const state = rawState ? JSON.parse(rawState) : {};

        if (state.phase === GamePhase.PAUSED) {
            this.logger.log(`[Circuit Breaker] Market ${market} recovered. Resuming.`);
            this.eventsGateway.broadcastMarketStatus(market, 'OPEN');
            await this.startBettingPhase(market);
            return false;
        }

        return true;
    }

    /**
     * Determines what to do based on current Redis state
     */
    private async processGameTick(market: string) {
        const stateKey = getPlinkoStateKey(market);
        const rawState = await this.redisService.get(stateKey);

        if (!rawState) {
            await this.startBettingPhase(market);
            return;
        }

        const state = JSON.parse(rawState);
        const now = Date.now();
        const timeLeft = state.endTime - now;

        if (timeLeft <= 0) {
            switch (state.phase) {
                case GamePhase.BETTING:
                    await this.startAccumulationPhase(market, state.roundId);
                    break;
                case GamePhase.ACCUMULATION:
                    await this.startDroppingPhase(market, state.roundId);
                    break;
                case GamePhase.DROPPING:
                    await this.startBettingPhase(market);
                    break;
                default:
                    await this.startBettingPhase(market);
            }
        } else {
            const nextTick = Math.min(timeLeft, 1000);
            this.scheduleNext(market, nextTick, () => this.runGameLoop(market));
        }
    }


    private async startBettingPhase(market: string) {
        const roundId = uuidv4();
        const duration = 10000;

        const state = {
            phase: GamePhase.BETTING,
            roundId,
            startTime: Date.now(),
            endTime: Date.now() + duration,
        };

        await this.redisService.set(getPlinkoStateKey(market), JSON.stringify(state));
        this.eventsGateway.server.to(market).emit('game:phase', state);

        this.scheduleNext(market, duration, () => this.runGameLoop(market));
    }

    private async startAccumulationPhase(market: string, roundId: string) {
        const duration = 5000;

        const snapshot = await this.priceService.getMarketSnapshot(market);
        await this.redisService.set(`plinko:${market}:${roundId}:start_price`, JSON.stringify(snapshot), 600);

        const state = {
            phase: GamePhase.ACCUMULATION,
            roundId,
            startTime: Date.now(),
            endTime: Date.now() + duration,
        };

        await this.redisService.set(getPlinkoStateKey(market), JSON.stringify(state));
        this.eventsGateway.server.to(market).emit('game:phase', state);

        this.scheduleNext(market, duration, () => this.runGameLoop(market));
    }

    private async startDroppingPhase(market: string, roundId: string) {
        const duration = 10000;

        const state = {
            phase: GamePhase.DROPPING,
            roundId,
            startTime: Date.now(),
            endTime: Date.now() + duration,
        };

        await this.redisService.set(getPlinkoStateKey(market), JSON.stringify(state));
        this.eventsGateway.server.to(market).emit('game:phase', state);

        this.scheduleNext(market, duration, () => this.runGameLoop(market));
    }



    private async handleEmergencyClose(market: string) {
        const stateKey = getPlinkoStateKey(market);
        const rawState = await this.redisService.get(stateKey);
        if (!rawState) return;

        const state = JSON.parse(rawState);

        if (state.phase === GamePhase.BETTING || state.phase === GamePhase.ACCUMULATION) {
            this.logger.warn(`[Emergency] Cancelling Round ${state.roundId} on ${market}. Refunding bets.`);

            this.eventsGateway.server.to(market).emit('game:error', {
                code: 'ROUND_CANCELLED',
                message: 'Round cancelled due to market instability. Bets refunded.'
            });

            await this.triggerRefunds(market, state.roundId);
        }
    }

    private async triggerRefunds(market: string, roundId: string) {
        const betsKey = getPlinkoRoundBetsKey(market, roundId);
        const allBets = await this.redisService.getStateClient().hGetAll(betsKey);

        if (!allBets || Object.keys(allBets).length === 0) return;

        this.logger.log(`Processing ${Object.keys(allBets).length} refunds for ${market}:${roundId}`);

        for (const [playerId, betJson] of Object.entries(allBets)) {
            try {
                const bet = JSON.parse(betJson);

                await this.httpService.creditWin({
                    sessionToken: bet.sessionToken,
                    winAmount: bet.amount,
                    currency: 'USD',
                    transactionId: uuidv4(),
                    type: 'refund',
                    metadata: { reason: 'market_outage', originalRound: roundId }
                });
            } catch (err) {
                this.logger.error(`Failed to refund player ${playerId}: ${err.message}`);
            }
        }

        await this.redisService.del(betsKey);
    }

    private scheduleNext(market: string, delay: number, callback: () => void) {
        if (this.loops.has(market)) clearTimeout(this.loops.get(market));
        const timeout = setTimeout(callback, delay);
        this.loops.set(market, timeout);
    }
}