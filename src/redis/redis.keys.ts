// --- Core Session Keys ---
export const getKeyForPlayerSession = (sessionToken: string): string => {
    return `session:${sessionToken}`;
};

// --- Market Data Keys ---
/**
 * Key for storing the latest enriched market snapshot per market/room.
 */
export const getKeyForLastMarketSnapshot = (market: string): string => {
    const safe = market.toLowerCase();
    return `market:last:${safe}`;
};

export const getMarketConfigsKey = (): string => {
    return 'markets';
};

// --- Tenant/Balance Keys ---
export const getTenantUpdatesChannel = (tenantId: string): string => {
    return `tenant:${tenantId}:updates`;
};

// --- Aviator Game Keys ---

export const getAviatorStateKey = (room: string): string => {
    return `aviator:${room}:state`;
};

/**
 * Hash storing all bets for a round.
 * Key: "${userId}" -> Value: JSON Bet Object
 */
export const getAviatorRoundBetsKey = (room: string, roundId: string): string => {
    return `aviator:${room}:bets:${roundId}`;
};

export const getAviatorHistoryKey = (room: string): string => {
    return `aviator:${room}:history`;
};

export const getAviatorCrashPointKey = (room: string, roundId: string): string => {
    return `aviator:${room}:crash:${roundId}`;
};

export const getAviatorMarketFilterKey = (room: string): string => {
    return `aviator:${room}:filter`;
};