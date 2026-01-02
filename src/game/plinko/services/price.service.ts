import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { MarketDataPayload } from 'src/redis/dto/market-data.dto';
import { getKeyForLastMarketSnapshot } from 'src/redis/redis.keys';

@Injectable()
export class PlinkoPriceService {
  private readonly logger = new Logger(PlinkoPriceService.name);

  constructor(
    @Inject(forwardRef(() => RedisService))
    private readonly redisService: RedisService,
  ) { }

  /**
   * Retrieves the latest available market snapshot for a given room (channel).
   * This is used by the Plinko Game Loop to capture:
   * 1. Start Price (at T=0 of Locked Phase)
   * 2. End Price (at T=5 of Locked Phase)
   */
  async getMarketSnapshot(room: string): Promise<MarketDataPayload | null> {
    const startTime = performance.now();

    try {

      const memorySnapshot = this.redisService.getLastMarketPayload(room);

      if (memorySnapshot) {

        return memorySnapshot;
      }

      this.logger.debug(`[Memory Miss] No in-memory snapshot for ${room}. Fallback to Redis fetch.`);

      const redisKey = getKeyForLastMarketSnapshot(room);
      const rawData = await this.redisService.get(redisKey);

      if (rawData) {
        const parsedSnapshot = JSON.parse(rawData) as MarketDataPayload;
        return parsedSnapshot;
      }

      this.logger.warn(`[Critical Miss] No market data found for ${room} in Memory or Redis.`);
      return null;

    } catch (error) {
      this.logger.error(`Failed to get market snapshot for ${room}: ${error.message}`, error.stack);
      return null;
    } finally {
      const duration = performance.now() - startTime;
      if (duration > 50) {
        this.logger.warn(`Slow snapshot fetch for ${room}: ${duration.toFixed(2)}ms`);
      }
    }
  }

  /**
   * Helper to validate if a snapshot is "fresh" enough for the game.
   * If data is stale (e.g., ingestion service died), we might want to pause the game.
   */
  isSnapshotFresh(snapshot: MarketDataPayload, maxAgeSeconds: number = 10): boolean {
    if (!snapshot || !snapshot.timestamp) return false;

    const snapshotTime = new Date(snapshot.timestamp).getTime();
    const now = Date.now();
    const ageSeconds = (now - snapshotTime) / 1000;

    return ageSeconds <= maxAgeSeconds;
  }
}