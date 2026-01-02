import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';

@Injectable()
export class MarketStatusService {
    /**
     * For MVP/Mines, we might assume markets are always "open" or check Redis.
     * Currently, the mines implementation uses a hardcoded check or Redis config.
     * We will implement a basic "Open" check for now.
     */

    isMarketOpen(market: string): boolean {
        // Implement logic or return true by default if no strict schedule
        return true;
    }
}
