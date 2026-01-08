import {
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    ConnectedSocket,
    MessageBody
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import type { AuthenticatedSocket } from 'src/common/types/socket.types';
import { Logger } from '@nestjs/common';
import { AviatorBetService } from './services/bet.service';

@WebSocketGateway({
    cors: { origin: '*' },
    namespace: '/'
})
export class AviatorGateway {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(AviatorGateway.name);

    constructor(
        private readonly betService: AviatorBetService
    ) { }

    @SubscribeMessage('game:bet')
    async handleBet(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() body: { amount: number; side?: 'LEFT' | 'RIGHT'; autoCashOut?: number }
    ) {
        try {
            if (!client.session) {
                return { status: 'error', message: 'Unauthorized' };
            }

            const room = client.session.room;
            const side = body.side || 'LEFT';

            const sessionWithToken = {
                ...client.session,
                token: client.session.token || client.handshake.auth.token
            };

            await this.betService.placeBet(
                room,
                client.session.tenantPlayerId,
                sessionWithToken,
                body.amount,
                side,
                body.autoCashOut
            );
            return { status: 'ok', message: 'Bet placed' };
        } catch (error) {
            this.logger.error(`Bet failed: ${error.message}`);
            return { status: 'error', message: error.message };
        }
    }

    @SubscribeMessage('game:cashout')
    async handleCashout(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() body: { side?: 'LEFT' | 'RIGHT' }
    ) {
        try {
            if (!client.session) {
                return { status: 'error', message: 'Unauthorized' };
            }
            const room = client.session.room;
            const side = body?.side || 'LEFT';

            // BetService signature: (room, playerId, betType)
            const result = await this.betService.cashOut(room, client.session.tenantPlayerId, side);
            return { status: 'ok', winAmount: result.winAmount, multiplier: result.multiplier, side };
        } catch (error) {
            // this.logger.error(`Cashout failed: ${error.message}`);
            return { status: 'error', message: error.message };
        }
    }

    @SubscribeMessage('game:cancel')
    async handleCancel(
        @ConnectedSocket() client: AuthenticatedSocket,
        @MessageBody() body: { side?: 'LEFT' | 'RIGHT' }
    ) {
        try {
            if (!client.session) {
                return { status: 'error', message: 'Unauthorized' };
            }
            const room = client.session.room;
            const side = body?.side || 'LEFT';

            await this.betService.cancelBet(room, client.session.tenantPlayerId, side);
            return { status: 'ok', message: 'Bet cancelled' };
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    }

    @SubscribeMessage('game:join')
    async handleJoin(
        @ConnectedSocket() client: AuthenticatedSocket
    ) {
        if (!client.session) return;
        const room = client.session.room;
        const userId = client.session.tenantPlayerId;

        await client.join(room);

        // Restore Active Bets if exists
        const activeBets = await this.betService.getActiveBets(room, userId);
        if (activeBets && activeBets.length > 0) {
            client.emit('game:restore', activeBets);
        }

        // Send History
        const historyKey = `aviator:${room}:history`; // Or import helper
        // Use redisService from gateway? Gateway doesn't have direct access to redisService usually, 
        // but it injects BetService. Let's add getHistory to BetService?
        // OR inject RedisService into Gateway.

        // Let's add getHistory to BetService for cleanliness.
        // Let's add getHistory to BetService for cleanliness.
        const history = await this.betService.getHistory(room);
        client.emit('game:history', history);

        // Send Current Game State (Phase/Timer) ---
        const currentState = await this.betService.getCurrentState(room);
        if (currentState) {
            const payload = { ...currentState, timestamp: Date.now() };
            client.emit('game:phase', payload);
        }


        return { status: 'ok', joined: room };
    }
}