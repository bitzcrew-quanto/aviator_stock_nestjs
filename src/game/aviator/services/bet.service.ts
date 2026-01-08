import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { HttpService } from 'src/http/http.service';
import { getAviatorRoundBetsKey, getAviatorStateKey, getAviatorHistoryKey } from 'src/redis/redis.keys';
import { GamePhase, AviatorState } from './game-loop.service';
import { SessionData } from 'src/common/types/socket.types';
import { v4 as uuidv4 } from 'uuid';
import { HqBetRequest } from 'src/http/interfaces';

export interface AviatorBet {
    playerId: string;
    amount: number;
    betType: string; 
    autoCashout?: number;
    cashedOutAt?: number;
    winAmount?: number;
    currency: string;
    sessionToken: string;
    roundId: string;
}

@Injectable()
export class AviatorBetService {
    private readonly logger = new Logger(AviatorBetService.name);

    constructor(
        private readonly redisService: RedisService,
        private readonly httpService: HttpService
    ) { }

    async placeBet(room: string, playerId: string, session: SessionData, amount: number, betType: string = 'LEFT', autoCashout?: number) {
        if (amount <= 0) throw new BadRequestException('Invalid bet amount');

        const stateKey = getAviatorStateKey(room);
        const rawState = await this.redisService.get(stateKey);
        if (!rawState) throw new BadRequestException('Game not active');

        const state: AviatorState = JSON.parse(rawState);

        if (state.phase !== GamePhase.BETTING) {
            throw new BadRequestException('Betting is closed for this round');
        }

        const betsKey = getAviatorRoundBetsKey(room, state.roundId);
        const compositeField = `${playerId}::${betType}`;

        // Check internal idempotency (prevent double bet on same button)
        const exists = await this.redisService.getStateClient().hExists(betsKey, compositeField);
        if (exists) throw new BadRequestException('Bet already placed on this side');

        // 1. Call HQ to deduct balance
        try {
            await this.httpService.placeBet({
                sessionToken: session.token,
                betAmount: amount,
                currency: session.currency || 'USD',
                transactionId: uuidv4(),
            });
        } catch (err) {
            this.logger.error(`Bet placement failed at HQ: ${err.message}`);
            throw new BadRequestException('Failed to place bet: Insufficient funds or service error');
        }

        const bet: AviatorBet = {
            playerId,
            amount,
            betType,
            autoCashout: (autoCashout || 0) > 0 ? autoCashout : undefined,
            currency: session.currency || 'USD',
            sessionToken: session.token,
            roundId: state.roundId
        };

        await this.redisService.getStateClient().hSet(betsKey, compositeField, JSON.stringify(bet));

        this.logger.log(`Bet placed: ${playerId} (Side ${betType}) - ${amount} on ${room}:${state.roundId}`);
        return bet;
    }

    async cashOut(room: string, playerId: string, betType: string) {
        const stateKey = getAviatorStateKey(room);
        const rawState = await this.redisService.get(stateKey);
        if (!rawState) throw new BadRequestException('Game not active');

        const state: AviatorState = JSON.parse(rawState);

        if (state.phase !== GamePhase.FLYING) {
            throw new BadRequestException('Round is not active or already crashed');
        }

        const currentMultiplier = state.multiplier;

        const betsKey = getAviatorRoundBetsKey(room, state.roundId);
        const compositeField = `${playerId}::${betType}`;
        const betJson = await this.redisService.getStateClient().hGet(betsKey, compositeField);

        if (!betJson) throw new BadRequestException('No active bet found for this side');

        const bet: AviatorBet = JSON.parse(betJson);

        if (bet.cashedOutAt) {
            throw new BadRequestException('Already cashed out');
        }

        const winAmount = parseFloat((bet.amount * currentMultiplier).toFixed(2));
        bet.cashedOutAt = currentMultiplier;
        bet.winAmount = winAmount;

        await this.redisService.getStateClient().hSet(betsKey, compositeField, JSON.stringify(bet));

        try {
            await this.httpService.creditWin({
                sessionToken: bet.sessionToken,
                winAmount: winAmount,
                currency: bet.currency,
                transactionId: uuidv4(),
                type: 'win',
                metadata: { multiplier: currentMultiplier, roundId: state.roundId, betType }
            });
        } catch (err) {
            this.logger.error(`Failed to credit win ${winAmount} to ${playerId}: ${err.message}`);
        }

        this.logger.log(`Cashout success: ${playerId} (${betType}) at ${currentMultiplier}x - Win: ${winAmount}`);

        return { winAmount, multiplier: currentMultiplier, betType };
    }

    async getActiveBets(room: string, playerId: string): Promise<AviatorBet[]> {
        // 1. Get current state to know the roundId
        const stateKey = getAviatorStateKey(room);
        const rawState = await this.redisService.get(stateKey);
        if (!rawState) return [];

        const state: AviatorState = JSON.parse(rawState);
        const roundId = state.roundId;

        // 2. Scan for user bets
        const betsKey = getAviatorRoundBetsKey(room, roundId);
        const pattern = `${playerId}::*`;

        const activeBets: AviatorBet[] = [];

        try {
            // Using HSCAN is safer for large keys, but since we just want user specific fields...
            // Actually, HSCAN scans the WHOLE hash. That is inefficient if Hash is Huge (10k players).
            // BUT, strictly speaking, we don't have a reliable "getUserBets" without an auxiliary index.

            // OPTIMIZATION:
            // Since we know the betTypes are limited (likely '1' and '2'),
            // we can just parallel fetch them instead of scanning!

            const potentialFields = [`${playerId}::1`, `${playerId}::2`];
            // If you support dynamic betTypes, scanning is needed, but for "Left/Right", direct get is O(1).

            // Let's assume standard '1' and '2' are the only keys for now.
            // If the frontend sends arbitrary strings, this fails.
            // Let's probe '1', '2' and maybe '0' or 'left', 'right'.

            // Safe approach: Multi-Get known slots.
            // If user uses custom betType, we miss it.
            // For now, let's look for '1' and '2'.

            // BETTER: Use SCAN? No, HSCAN iterates the whole hash.
            // BEST: Maintain a specific key `aviator:active_bets:{round}:{user}` -> List of betTypes.

            // COMPROMISE: We will check `playerId::1` and `playerId::2`.

            const [betLeft, betRight] = await Promise.all([
                this.redisService.getStateClient().hGet(betsKey, `${playerId}::LEFT`),
                this.redisService.getStateClient().hGet(betsKey, `${playerId}::RIGHT`)
            ]);

            if (betLeft) activeBets.push(JSON.parse(betLeft));
            if (betRight) activeBets.push(JSON.parse(betRight));

        } catch (e) {
            this.logger.warn(`Error fetching active bets: ${e.message}`);
        }

        return activeBets;
    }

    async getHistory(room: string) {
        const historyKey = getAviatorHistoryKey(room);
        const rawHistory = await this.redisService.getStateClient().lRange(historyKey, 0, 19); // Last 20
        return rawHistory.map(item => JSON.parse(item));
    }

    async getCurrentState(room: string): Promise<AviatorState | null> {
        const stateKey = getAviatorStateKey(room);
        const raw = await this.redisService.get(stateKey);
        return raw ? JSON.parse(raw) : null;
    }

    async processAutoCashouts(room: string, currentMultiplier: number) {
        const stateKey = getAviatorStateKey(room);
        const rawState = await this.redisService.get(stateKey);
        if (!rawState) return;
        const state: AviatorState = JSON.parse(rawState);

        if (state.phase !== GamePhase.FLYING) return;

        const betsKey = getAviatorRoundBetsKey(room, state.roundId);

        const allBetsRaw = await this.redisService.getStateClient().hGetAll(betsKey);

        for (const [field, rawBet] of Object.entries(allBetsRaw)) {
            try {
                const bet: AviatorBet = JSON.parse(rawBet);

                if (bet.cashedOutAt) continue;
                if (!bet.autoCashout || bet.autoCashout <= 1.0) continue;

                if (currentMultiplier >= bet.autoCashout) {
                    this.logger.log(`Auto-Cashout Triggered: ${bet.playerId} @ ${bet.autoCashout}x`);

                    // Re-use logic: We can call this.cashOut but we need to pass params.
                    // Or purely simpler: update bet here to avoid re-fetching state.
                    // Let's call this.cashOut to reuse event logic etc.
                    // But cashOut does extra checks. Let's do direct implementation for speed?
                    // No, stick to reusing cashOut to ensure consistency (HTTP calls etc).

                    await this.cashOut(room, bet.playerId, bet.betType);
                }
            } catch (e) {
                this.logger.error(`Error processing auto-cashout for bet ${field}: ${e.message}`);
            }
        }
    }
}