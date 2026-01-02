// This represents the data for a single stock symbol at a moment in time.
export type SymbolSnapshot = {
    price: number;
    previousPrice: number | null;
    lastUpdatedAt: number; // Unix timestamp in seconds
    delta: number
};

export type Market = 'usa-channel' | 'crypto-channel' | 'nse-channel' | 'mcx-channel' | 'comex-channel';

// This is the main payload for our internal 'market-data.updated' event.
export interface MarketDataPayload {
    market: Market; // The Redis channel name from which this data was received (e.g., 'crypto-channel')
    timestamp: string; // ISO 8601 timestamp of when the snapshot was generated
    symbols: Record<string, SymbolSnapshot>; // A dictionary mapping symbol names to their data
}
