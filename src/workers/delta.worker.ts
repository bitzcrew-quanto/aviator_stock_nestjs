import { parentPort } from 'node:worker_threads';
import { SymbolSnapshot } from 'src/redis/dto/market-data.dto';


/** What the worker receives: market-level snapshots with raw per-symbol readings */
type IncomingSymbol = {
    price: number;
    previousPrice?: number; 
    lastUpdatedAt?: number;
};

type IncomingMarketSnapshot = {
    market: string;
    // Allow incoming timestamp as number (unix seconds) or ISO string; we'll normalize
    timestamp: number | string;
    symbols: Record<string, IncomingSymbol>;
};

type WorkMsg = {
    __id: number;
    // (market is derivable from current.market; keep both for flexibility)
    market?: string;
    current: IncomingMarketSnapshot;
    previous?: IncomingMarketSnapshot;
};

/** The enriched payload we return to the main thread */
type EnrichedMarketSnapshot = {
    market: string;
    // Output as ISO string to match backend MarketDataPayload type
    timestamp: string;
    symbols: Record<string, SymbolSnapshot>;
};

function isIncomingMarketSnapshot(x: any): x is IncomingMarketSnapshot {
    return (
        x &&
        typeof x === 'object' &&
        typeof x.market === 'string' &&
        (typeof x.timestamp === 'number' || typeof x.timestamp === 'string') &&
        x.symbols &&
        typeof x.symbols === 'object'
    );
}

function toUnixSeconds(ts: number | string): number {
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    // Attempt parse: numeric string or ISO date
    if (typeof ts === 'string') {
        const num = Number(ts);
        if (Number.isFinite(num)) {
            // If it looks like milliseconds (13 digits), convert to seconds
            return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
        }
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    // Fallback: now
    return Math.floor(Date.now() / 1000);
}

function toUnixSecondsOptional(ts: unknown): number | undefined {
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (typeof ts === 'string') {
        const num = Number(ts);
        if (Number.isFinite(num)) return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
        const parsed = Date.parse(ts);
        if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    return undefined;
}

parentPort?.on('message', (raw: unknown) => {
    // Strongly type/narrow the message
    if (!raw || typeof raw !== 'object') {
        return parentPort?.postMessage({ error: 'invalid_message' });
    }

    const msg = raw as Partial<WorkMsg>;
    const id = msg.__id;

    try {
        if (!isIncomingMarketSnapshot(msg.current)) {
            throw new Error('current_snapshot_missing_or_invalid');
        }
        // previous is optional
        const prev = isIncomingMarketSnapshot(msg.previous)
            ? msg.previous
            : undefined;

        // Normalize timestamps to seconds for calculations
        const currentTs = toUnixSeconds(msg.current.timestamp);
        const prevSymbols: Record<string, IncomingSymbol> = prev?.symbols ?? {};
        const currSymbols: Record<string, IncomingSymbol> = msg.current.symbols ?? {};

        const enriched: EnrichedMarketSnapshot = {
            market: msg.current.market,
            timestamp: new Date(currentTs * 1000).toISOString(),
            symbols: Object.create(null),
        };

        for (const [symbol, snap] of Object.entries(currSymbols)) {
         
            const before = snap.previousPrice ?? prevSymbols[symbol]?.price;

            const previousPrice =
                typeof before === 'number' && Number.isFinite(before) ? before : null;

            const price = snap.price;
            const lastUpdatedAt =
                toUnixSecondsOptional((snap as any).lastUpdatedAt) ?? currentTs;

            let delta = (snap as any).delta || 0; // Prefer incoming delta

            // If incoming delta is 0 or missing, calculate our own (Percentage Change)
            if (delta === 0 && previousPrice !== null && previousPrice !== 0 && Number.isFinite(price)) {
                // Calculate Percentage Change: ((Current - Baseline) / Baseline) * 100
                const change = price - previousPrice;
                const rawPct = (change / previousPrice) * 100;
                delta = Number(rawPct.toFixed(4));
            }

            enriched.symbols[symbol] = {
                price,
                previousPrice,
                lastUpdatedAt,
                delta,
            };
        }

        parentPort?.postMessage({ __id: id, ...enriched });
    } catch (err) {
        const message =
            err instanceof Error ? err.message : typeof err === 'string' ? err : 'worker_error';
        parentPort?.postMessage({ __id: id, error: message });
    }
});
