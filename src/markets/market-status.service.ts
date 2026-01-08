import { Inject, Injectable, Logger, OnApplicationBootstrap, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import type { ConfigType } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { RedisService } from '../redis/redis.service';
import appConfig from '../config/app.config';
import { getMarketConfigsKey } from '../redis/redis.keys';

interface MarketConfig {
    slug: string;
    timezone: string;
    openTime?: string;
    closeTime?: string;
    daysOpen: number[];
    exceptions?: {
        date: string;
        isClosed: boolean;
        openTime?: string;
        closeTime?: string;
    }[];
    isActive: boolean;
}

@Injectable()
export class MarketStatusService implements OnApplicationBootstrap {
    private readonly logger = new Logger(MarketStatusService.name);
    private markets: Map<string, MarketConfig> = new Map();
    private updateInterval: NodeJS.Timeout;

    constructor(
        private readonly httpService: HttpService,
        @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
        @Inject(forwardRef(() => RedisService)) private readonly redisService: RedisService,
    ) { }

    async onApplicationBootstrap() {
        await this.updateMarketConfigs();
        // Update every 30 seconds to check Redis cache
        this.updateInterval = setInterval(() => {
            void this.updateMarketConfigs();
        }, 30 * 1000);
    }

    async updateMarketConfigs() {
        try {
            const cacheKey = getMarketConfigsKey();
            // Try fetching from Redis first (Hash)
            if (!this.redisService.getStateClient()) {
                this.logger.warn('Redis client not ready yet, skipping config update');
                return;
            }
            const cached = await this.redisService.hGetAll(cacheKey);
            if (cached && Object.keys(cached).length > 0) {
                this.markets.clear();
                let loadedCount = 0;
                for (const [slug, configStr] of Object.entries(cached)) {
                    try {
                        const config: MarketConfig = JSON.parse(configStr);
                        this.markets.set(slug, config);
                        loadedCount++;
                    } catch (e) {
                        this.logger.warn(`Failed to parse cached config for ${slug}`);
                    }
                }
                // this.logger.debug(`Loaded configurations for ${loadedCount} markets from Redis cache`);
                return;
            }

            // Fallback to HQ if cache miss
            // this.logger.log('Cache miss or empty. Fetching market configs from HQ...');
            const hqUrl = this.config.hqServiceUrl;
            if (!hqUrl) {
                this.logger.warn('HQ URL not configured, cannot fetch market status');
                return;
            }

            try {
                const { data: responseBody } = await firstValueFrom(this.httpService.get<{ data: MarketConfig[] }>(`${hqUrl}/api/markets`));
                const data = responseBody.data || [];
                // this.logger.debug("Market configs fetched from HQ: " + data.length);

                if (data.length > 0) {
                    const hashData: Record<string, string> = {};
                    for (const market of data) {
                        this.markets.set(market.slug, market);
                        hashData[market.slug] = JSON.stringify(market);
                    }

                    // Cache in Redis (Hash)
                    // We delete first to ensure removed markets are cleared
                    await this.redisService.del(cacheKey);
                    await this.redisService.hSet(cacheKey, hashData);
                    await this.redisService.expire(cacheKey, 3600); // 1 hour TTL

                    this.logger.log(`Updated configurations for ${this.markets.size} markets from HQ`);
                } else {
                    this.logger.warn('No markets returned from HQ');
                }
            } catch (httpError) {
                this.logger.error(`HTTP fetch failed for markets: ${httpError.message}`);
            }

        } catch (e) {
            this.logger.error(`Failed to update market configs: ${(e as Error).message}`);
        }
    }

    isMarketOpen(slug: string): boolean {
        // Compatibility: CryptoStream is always open
        if (slug === 'CryptoStream') return true;

        const market = this.markets.get(slug);
        if (!market) {
            // Default to CLOSED if config is missing (safety)
            // UNLESS it's a known always-open market? 
            // Better safe: Closed.
            return false;
        }

        if (!market.isActive) return false;

        const timeZone = market.timezone || 'Asia/Kolkata';
        const now = new Date();

        // Get current time in market's timezone
        const localDateString = now.toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD
        const localTimeString = now.toLocaleTimeString('en-GB', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }); // HH:mm

        // Check for exceptions
        const exception = market.exceptions?.find((e) => e.date === localDateString);
        if (exception) {
            if (exception.isClosed) return false;
            if (exception.openTime && exception.closeTime) {
                return this.checkTimeRange(localTimeString, exception.openTime, exception.closeTime);
            }
        }

        // Check day of week
        const dayOfWeek = new Date(now.toLocaleString('en-US', { timeZone })).getDay();

        if (!market.openTime || !market.closeTime) {
            if (!market.daysOpen.includes(dayOfWeek)) return false;
            return true; // 24/7 on open days
        }

        return this.checkTimeRange(localTimeString, market.openTime, market.closeTime, market.daysOpen, dayOfWeek);
    }

    private checkTimeRange(currentTime: string, openTime: string, closeTime: string, daysOpen?: number[], currentDay?: number): boolean {
        const [currH, currM] = currentTime.split(':').map(Number);
        const [openH, openM] = openTime.split(':').map(Number);
        const [closeH, closeM] = closeTime.split(':').map(Number);

        const currMins = currH * 60 + currM;
        const openMins = openH * 60 + openM;
        const closeMins = closeH * 60 + closeM;

        if (openMins > closeMins) {
            // Crosses midnight
            if (currMins < closeMins) {
                // Early morning: Check if YESTERDAY was an open day
                if (daysOpen && currentDay !== undefined) {
                    const yesterday = (currentDay + 6) % 7;
                    if (!daysOpen.includes(yesterday)) return false;
                }
                return true;
            } else if (currMins >= openMins) {
                // Late night: Check if TODAY is an open day
                if (daysOpen && currentDay !== undefined) {
                    if (!daysOpen.includes(currentDay)) return false;
                }
                return true;
            }
            return false;
        } else {
            // Normal hours
            if (daysOpen && currentDay !== undefined) {
                if (!daysOpen.includes(currentDay)) return false;
            }
            return currMins >= openMins && currMins < closeMins;
        }
    }
}
