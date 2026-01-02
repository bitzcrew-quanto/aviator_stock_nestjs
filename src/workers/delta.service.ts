import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { MarketDataPayload } from 'src/redis/dto/market-data.dto';

@Injectable()
export class DeltaWorkerService implements OnModuleDestroy {
    private readonly logger = new Logger(DeltaWorkerService.name);
    private worker?: Worker;
    private pending: { [id: number]: (value: MarketDataPayload & { symbols: Record<string, any> } | { error: string }) => void } = Object.create(null);
    private seq = 0;
    private healthy = false;

    private ensureWorker() {
        if (this.worker) return;
        const workerPath = join(__dirname, 'delta.worker.js');
        this.worker = new Worker(workerPath);
        this.worker.on('message', (msg: any) => {
            const id = msg?.__id as number | undefined;
            if (id != null && this.pending[id]) {
                const resolve = this.pending[id];
                delete this.pending[id];
                const { __id, ...rest } = msg;
                resolve(rest);
            }
        });
        this.worker.on('error', (err) => { this.logger.error('Delta worker error', err); this.healthy = false; });
        this.worker.on('online', () => { this.healthy = true; });
        this.worker.on('exit', (code) => {
            this.logger.warn(`Delta worker exited with code ${code}`);
            this.worker = undefined;
            this.healthy = false;
            // flush all pending with error
            const callbacks = this.pending;
            this.pending = Object.create(null);
            for (const key in callbacks) {
                try { callbacks[key]({ error: 'worker_exit' }); } catch { }
            }
        });
    }

    async enrichWithDelta(current: MarketDataPayload, previous?: MarketDataPayload): Promise<MarketDataPayload | { error: string }> {
        this.ensureWorker();
        const id = ++this.seq;
        return new Promise((resolve) => {
            this.pending[id] = resolve;
            this.worker!.postMessage({ __id: id, market: current.market, current, previous });
        });
    }

    async onModuleDestroy() {
        if (this.worker) {
            try { await this.worker.terminate(); } catch { }
        }
    }

    isHealthy(): boolean {
        return !!this.worker && this.healthy;
    }
}
