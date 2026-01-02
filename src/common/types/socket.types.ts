import type { Socket } from 'socket.io';

/**
 * Defines the structure of the session object retrieved from Redis.
 */
export interface SessionData {
    id: number; // Session database ID (not player ID)
    sessionToken: string;
    token: string; // Alias for sessionToken for HQ service compatibility (added by our server)
    tenantPublicId: string; // Tenant public UUID
    gamePublicId: string; // Game public UUID
    tenantPlayerId: string; // Player ID within the tenant (this is what we use for player identification)
    gameId: number; // Game database ID
    createdAt: string; // ISO string
    expiresAt: string; // ISO string
    currency: string;
    mode: string; // 'real' | 'demo' | etc.
    room: string;
    language: string;
    lobbyUrl?: string; // Optional lobby URL
    initialBalance: string; // Initial balance for the session
    currentBalance: string;
}

/**
 * Extends the base Socket type to include our strongly-typed session data.
 */
export interface AuthenticatedSocket extends Socket {
    session: SessionData;
}
