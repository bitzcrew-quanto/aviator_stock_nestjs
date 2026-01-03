import { forwardRef, Inject, Logger } from '@nestjs/common';
import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { MarketDataPayload } from 'src/redis/dto/market-data.dto';
import type { AuthenticatedSocket } from 'src/common/types/socket.types';
import { RedisService } from 'src/redis/redis.service';
import { BalanceUpdateService } from 'src/redis/balance-update.service';
import { MarketStatusService } from 'src/markets/market-status.service';
import { getKeyForPlayerSession, getKeyForLastMarketSnapshot } from 'src/redis/redis.keys';

@WebSocketGateway({
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        credentials: true
    }
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer() server: Server;
    private readonly logger = new Logger(EventsGateway.name);

    constructor(
        @Inject(forwardRef(() => RedisService))
        private readonly redisService: RedisService,

        @Inject(forwardRef(() => BalanceUpdateService))
        private readonly balanceUpdateService: BalanceUpdateService,

        private readonly marketStatus: MarketStatusService,
    ) { }

    async handleConnection(client: AuthenticatedSocket) {
        try {
            const token = client.handshake.auth.token;

            if (!token) {
                this.logger.warn(`Connection rejected: No token provided by socket ${client.id}`);
                // Inform frontend before disconnecting
                try {
                    client.emit('error', {
                        type: 'auth',
                        code: 'NO_TOKEN',
                        message: 'Authentication required. Please open the game from your lobby.'
                    });
                } catch { }
                client.disconnect(true);
                return;
            }

            const sessionKey = getKeyForPlayerSession(token);
            const sessionDataString = await this.redisService.get(sessionKey);

            if (!sessionDataString) {
                this.logger.warn(`Invalid session token for socket ${client.id}. Terminating.`);
                try {
                    client.emit('error', {
                        type: 'auth',
                        code: 'INVALID_SESSION',
                        message: 'Invalid session. Please reopen the game from your lobby.'
                    });
                } catch { }
                client.disconnect(true);
                return;
            }


            const session = JSON.parse(sessionDataString);
            client.session = session;

            client.emit('updated_balance', { playerUpdatedBalance: parseFloat(client.session.currentBalance), currency: client.session.currency });

            // Join market data room directly
            const roomToJoin = client.session.room;

            // Check if market is open
            const isOpen = this.marketStatus.isMarketOpen(roomToJoin);
            if (!isOpen) {
                this.logger.warn(`Connection rejected: Market ${roomToJoin} is closed for socket ${client.id}`);
                try {
                    client.emit('error', {
                        type: 'game',
                        code: 'MARKET_CLOSED',
                        message: 'Market is closed'
                    });
                } catch { }
                client.disconnect(true);
                return;
            }

            client.join(roomToJoin);

            try {
                const last = this.redisService.getLastMarketPayload(roomToJoin);
                if (last) {
                    client.emit('market-update', last);
                } else {
                    const lastKey = getKeyForLastMarketSnapshot(roomToJoin);
                    const raw = await this.redisService.get(lastKey);
                    if (raw) {
                        client.emit('market-update', JSON.parse(raw));
                    }
                }
            } catch (e) {
                this.logger.debug(`No initial market snapshot available for room ${roomToJoin}`);
            }

            const tenantId = client.session.tenantPublicId;
            const playerId = client.session.tenantPlayerId;
            const playerBalanceRoom = this.balanceUpdateService.getPlayerBalanceRoom(tenantId, playerId);
            client.join(playerBalanceRoom);

            const updateSessionTimestamp = async () => {
                try {
                    const currentSessionString = await this.redisService.get(sessionKey);

                    if (currentSessionString) {
                        const currentSession = JSON.parse(currentSessionString);
                        currentSession.updatedAt = new Date().toISOString();

                        await this.redisService.set(
                            sessionKey,
                            JSON.stringify(currentSession)
                        );
                    } else {
                        // The session has expired or was removed from Redis.
                        this.logger.warn(`Session ${sessionKey} expired during heartbeat check. Disconnecting client ${client.id}.`);
                        client.disconnect(true);
                    }
                } catch (error) {
                    this.logger.error(`Error refreshing session TTL for ${sessionKey}:`, error);
                }
            };

            // Piggyback on the engine.io's heartbeat mechanism
            client.conn.on('heartbeat', updateSessionTimestamp);

            this.logger.log(`Client connected: ${client.id}, PlayerID: ${client.session.tenantPlayerId}, Tenant: ${tenantId}, Market Room: ${roomToJoin}, Balance Room: ${playerBalanceRoom}`);

            // TODO: Restore Active Game State logic if applicable to Plinko

        } catch (err) {
            this.logger.error('Error during handleConnection authentication:', (err).message);
            try {
                client.emit('error', {
                    type: 'auth',
                    code: 'AUTH_ERROR',
                    message: 'Authentication error. Please try again from your lobby.'
                });
            } catch { }
            client.disconnect(true);
        }
    }

    handleDisconnect(client: AuthenticatedSocket) {
        if (client.session) {
            const tenantId = client.session.tenantPublicId;
            const playerId = client.session.tenantPlayerId;
            const playerBalanceRoom = this.balanceUpdateService.getPlayerBalanceRoom(tenantId, playerId);

            client.leave(client.session.room);
            client.leave(playerBalanceRoom);
            this.logger.log(`Client disconnected: ${client.id}, PlayerID: ${client.session.tenantPlayerId}, Tenant: ${tenantId}, Left Rooms: ${client.session.room}, ${playerBalanceRoom}`);
        } else {
            this.logger.log(`Client disconnected: ${client.id} (was unauthenticated)`);
        }
    }

    broadcastMarketDataToRoom(room: string, payload: MarketDataPayload): void {
        if (!this.server) { this.logger.error('server not intialized'); return; }

        this.server.to(room).compress(false).emit('market-update', payload);
    }

    broadcastMarketStatus(room: string, status: 'OPEN' | 'CLOSED', reason?: string): void {
        if (!this.server) return;
        this.server.to(room).emit('market-status', { status, reason, timestamp: new Date().toISOString() });
    }

    hasSubscribers(room: string): boolean {
        try {
            const size = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
            return size > 0;
        } catch {
            return true; // default to broadcasting if unsure
        }
    }

    /**
     * Emit balance update to a specific player's room (STATELESS approach)
     * Only the player in that specific room receives the update
     */
    emitBalanceUpdateToPlayerRoom(room: string, balanceData: {
        playerId: string;
        balance: number;
        currency: string
    }): void {
        if (!this.server) {
            this.logger.error('Server not initialized');
            return;
        }

        this.server.to(room).emit('updated_balance', {
            playerUpdatedBalance: balanceData.balance,
            currency: balanceData.currency
        });
        this.logger.debug(`Sent balance update to player ${balanceData.playerId} in room ${room}: ${balanceData.balance}`);
    }

    /**
     * Emit error to a specific player's room (STATELESS approach)
     * Only the player in that specific room receives the error
     */
    emitErrorToPlayerRoom(room: string, errorData: {
        playerId: string;
        type: string;
        code?: string;
        message: string
    }): void {
        if (!this.server) {
            this.logger.error('Server not initialized');
            return;
        }

        this.server.to(room).emit('error', {
            type: errorData.type,
            code: errorData.code,
            message: errorData.message
        });
        this.logger.debug(`Sent error to player ${errorData.playerId} in room ${room}: ${errorData.message}`);
    }
}
