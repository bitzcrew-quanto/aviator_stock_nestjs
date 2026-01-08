import { Inject, Injectable, OnModuleDestroy, Logger, forwardRef, OnModuleInit } from '@nestjs/common';
import { createClient, createCluster, type RedisClientType, type RedisClusterType } from 'redis';
import appConfig from '../config/app.config';
import type { ConfigType } from '@nestjs/config';
import { EventsGateway } from 'src/events/events.gateway';
import { DeltaWorkerService } from 'src/workers/delta.service';
import { BalanceUpdateService } from './balance-update.service';
import type { Market, MarketDataPayload } from './dto/market-data.dto';
import { getKeyForLastMarketSnapshot } from './redis.keys';

export type UniversalRedisClient = RedisClientType | RedisClusterType;
type RedisConfig = ConfigType<typeof appConfig>['pubsubRedis'];

@Injectable()
export class RedisService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(RedisService.name);
  private subscriber!: UniversalRedisClient;
  private client!: UniversalRedisClient;
  private stateSubscriber!: UniversalRedisClient;

  private readonly lastPayloadByMarket: Record<string, MarketDataPayload> = Object.create(null);

  private subscriberReady = false;
  private stateSubscriberReady = false;
  private clientReady = false;
  private lastSubscribeError?: string;
  private lastUpdateTimes: Record<string, number> = {};

  constructor(
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    @Inject(forwardRef(() => EventsGateway)) private eventsGateway: EventsGateway,
    private readonly deltaWorker: DeltaWorkerService,
    @Inject(forwardRef(() => BalanceUpdateService)) private balanceUpdateService: BalanceUpdateService,
  ) { }

  async onModuleInit() {
    await this.connect();
  }

  async connect() {
    try {
      this.logger.log('Initializing Redis clients for Subscriber, State, and State Subscriber...');

      this.subscriber = this.createRedisClient('Subscriber', this.config.pubsubRedis);
      this.client = this.createRedisClient('State', this.config.stateRedis);
      this.stateSubscriber = this.createRedisClient('State Subscriber', this.config.stateRedis);

      (this.subscriber).on?.('error', (err: Error) => {
        this.lastSubscribeError = err?.message;
        this.subscriberReady = false;
        this.logger.error('Redis Subscriber Error', err);
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectSubscriber(), 5000);
      });
      (this.client).on?.('error', (err: Error) => {
        this.clientReady = false;
        this.logger.error('Redis State Client Error', err);
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectClient(), 5000);
      });
      (this.stateSubscriber).on?.('error', (err: Error) => {
        this.lastSubscribeError = err?.message;
        this.stateSubscriberReady = false;
        this.logger.error('Redis State Subscriber Error', err);
        // Attempt to reconnect after a delay
        setTimeout(() => this.reconnectStateSubscriber(), 5000);
      });

      (this.subscriber).on?.('end', () => {
        this.subscriberReady = false;
        this.logger.warn('Redis Subscriber connection ended');
      });
      (this.client).on?.('end', () => {
        this.clientReady = false;
        this.logger.warn('Redis State connection ended');
      });
      (this.stateSubscriber).on?.('end', () => {
        this.stateSubscriberReady = false;
        this.logger.warn('Redis State Subscriber connection ended');
      });

      (this.subscriber).on?.('connect', () => {
        this.logger.log('Redis Subscriber connected');
      });
      (this.client).on?.('connect', () => {
        this.clientReady = true;
        this.logger.log('Redis State Client connected');
      });
      (this.stateSubscriber).on?.('connect', () => {
        this.logger.log('Redis State Subscriber connected');
      });

      await Promise.all([
        (this.subscriber).connect(),
        (this.client).connect(),
        (this.stateSubscriber).connect(),
      ]);

      // Set client ready after successful connection
      this.clientReady = true;
      this.logger.log('Redis clients connected successfully.');
      await this.subscribeToChannels();
    } catch (error) {
      this.logger.error(
        'Failed to connect Redis clients on startup. Service will continue and retry on demand.',
        error,
      );
    }
  }

  /** Simple sliding window rate limiter using Redis INCR with TTL. */
  async isAllowedRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
      const nowKey = `rl:${key}`;
      const count = await (this.client).incr(nowKey);
      if (count === 1) await (this.client).expire(nowKey, windowSeconds);
      return count <= limit;
    } catch {
      return true;
    }
  }

  /** Idempotency helper. */
  async setIfNotExists(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await (this.client).set(key, '1', { NX: true, EX: ttlSeconds });
      return result === 'OK';
    } catch {
      return true;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Use Promise.race to add a timeout to the health check
      const healthCheck = (this.client).exists('health:check:noop');
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), 5000)
      );

      await Promise.race([healthCheck, timeout]);
      return this.clientReady;
    } catch (error) {
      this.logger.warn('Redis health check failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async getHealthSnapshot(): Promise<{
    stateClientOperational: boolean;
    subscriberOperational: boolean;
    stateSubscriberOperational: boolean;
    pubsubMode: string;
    stateMode: string;
    pubsubTls?: boolean;
    stateTls?: boolean;
    lastSubscribeError?: string;
    cluster?: { state?: string; knownNodes?: number; size?: number };
  }> {
    const snapshot = {
      stateClientOperational: false,
      subscriberOperational: this.subscriberReady,
      stateSubscriberOperational: this.stateSubscriberReady,
      pubsubMode: this.config.pubsubRedis.mode,
      stateMode: this.config.stateRedis.mode,
      pubsubTls: this.config.pubsubRedis.tlsEnabled,
      stateTls: this.config.stateRedis.tlsEnabled,
      lastSubscribeError: this.lastSubscribeError,
      cluster: undefined as undefined | { state?: string; knownNodes?: number; size?: number },
    };

    try {
      await (this.client).exists('health:check:noop');
      snapshot.stateClientOperational = true;
    } catch {
      snapshot.stateClientOperational = false;
    }

    if (this.config.stateRedis.mode === 'cluster' && typeof (this.client)?.sendCommand === 'function') {
      try {
        const info: string | undefined = await (this.client as any).sendCommand(['CLUSTER', 'INFO']);
        if (typeof info === 'string') {
          const map: Record<string, string> = Object.create(null);
          for (const line of info.split('\n')) {
            const [k, v] = line.split(':');
            if (k && v) map[k.trim()] = v.trim();
          }
          snapshot.cluster = {
            state: map['cluster_state'],
            knownNodes: map['cluster_known_nodes'] ? Number(map['cluster_known_nodes']) : undefined,
            size: map['cluster_size'] ? Number(map['cluster_size']) : undefined,
          };
        }
      } catch {/* ignore */ }
    }

    return snapshot;
  }

  public getStateClient(): UniversalRedisClient { return this.client; }
  public getPubSubClient(): UniversalRedisClient { return this.subscriber; }
  public getStateSubscriberClient(): UniversalRedisClient { return this.stateSubscriber; }

  /**
   * node-redis v4 factory with correct TLS/SNI handling.
   * - Cluster: prefer CONFIG_ENDPOINT → rootNodes as URLs, SNI=CONFIG_ENDPOINT.
   * - Standalone: derive SNI from REDIS_URL host.
   */
  private createRedisClient(clientName: string, config: RedisConfig): UniversalRedisClient {
    const reconnectStrategy = (retries: number) => Math.min(100 * Math.pow(2, retries), 5_000);

    if (config.mode === 'cluster') {
      this.logger.log(`Initializing Redis ${clientName} in CLUSTER mode...`);

      // rootNodes use URL shape; no ClusterNode type needed.
      let rootNodes: Array<{ url: string }>;
      if (config.configEndpoint) {
        const proto = config.tlsEnabled ? 'rediss' : 'redis';
        rootNodes = [{ url: `${proto}://${config.configEndpoint}:${config.port ?? 6379}` }];
      } else if (config.clusterEndpoints?.length) {
        const proto = config.tlsEnabled ? 'rediss' : 'redis';
        rootNodes = config.clusterEndpoints.map((ep) => ({ url: `${proto}://${ep.host}:${ep.port}` }));
      } else {
        throw new Error(`Cluster mode for ${clientName} requires configEndpoint or clusterEndpoints`);
      }

      // Build socket options: include tls only when enabled, as literal true.
      const socket: any = config.tlsEnabled
        ? { tls: true as const, servername: config.configEndpoint ?? config.clusterEndpoints?.[0]?.host, reconnectStrategy }
        : { reconnectStrategy };

      return createCluster({
        rootNodes,
        defaults: {
          username: config.username,
          password: config.password,
          socket,
        },
      });
    }

    // ---- Standalone
    this.logger.log(`Initializing Redis ${clientName} in STANDALONE mode...`);
    if (!config.url) throw new Error(`Redis URL missing for ${clientName}`);

    // Derive SNI from URL host
    let servername: string | undefined;
    try { servername = new URL(config.url).hostname; } catch { }

    // Check if URL uses rediss:// protocol or TLS is explicitly enabled
    const isTlsUrl = config.url.startsWith('rediss://');
    const shouldUseTls = config.tlsEnabled || isTlsUrl;

    const socket: any = shouldUseTls
      ? { tls: true as const, servername, reconnectStrategy }
      : { reconnectStrategy };

    return createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      socket,
    });
  }


  private readonly forcedDeltas: Record<string, { delta: number; expiresAt: number }> = {};

  public forceStockDelta(stock: string, delta: number, durationSeconds: number = 3) {
    this.forcedDeltas[stock] = {
      delta,
      expiresAt: Date.now() + durationSeconds * 1000
    };
  }

  private applyForcedDeltas(payload: MarketDataPayload): MarketDataPayload {
    const now = Date.now();
    let hasChanges = false;
    const outSymbols = { ...payload.symbols };

    for (const [stock, force] of Object.entries(this.forcedDeltas)) {
      if (now > force.expiresAt) {
        delete this.forcedDeltas[stock];
        continue;
      }

      if (outSymbols[stock]) {
        outSymbols[stock] = {
          ...outSymbols[stock],
          delta: force.delta
        };
        hasChanges = true;
      }
    }

    return hasChanges
      ? { ...payload, symbols: outSymbols }
      : payload;
  }

  private async subscribeToChannels() {
    try {
      const channels = this.config.subscribeChannels;

      await (this.subscriber as any).subscribe(
        channels,
        (message: string, channel: string) => {
          try {
            const parsed = JSON.parse(message);
            // Ignore messages that don't look like market data (e.g. Aviator game state)
            if (!parsed.symbols) return;

            const stockList = parsed.symbols ? Object.keys(parsed.symbols).join(', ') : 'No stocks';

            // THROTTLE: Only process 1 update per second per room
            // This ensures "Delta" is calculated over a 1s window (making it more meaningful)
            // and allows the frontend to be calmer.
            const now = Date.now();
            if (this.lastUpdateTimes[channel] && now - this.lastUpdateTimes[channel] < 1000) {
              return;
            }
            this.lastUpdateTimes[channel] = now;

            this.logger.log(`Received market snapshot for ${channel} | Stocks: ${stockList}`);
            const room = channel;
            const previous = this.lastPayloadByMarket[room];
            const current: MarketDataPayload = { ...(parsed as any), market: room } as unknown as MarketDataPayload;

            this.deltaWorker.enrichWithDelta(current, previous)
              .then(async (enriched) => {
                let fullPayload: MarketDataPayload = 'error' in enriched ? current : enriched;

                fullPayload = this.applyForcedDeltas(fullPayload);

                this.lastPayloadByMarket[room] = fullPayload;

                const outbound = { ...fullPayload, symbols: { ...fullPayload.symbols } };

                // Only send stocks that the Aviator Game Loop is interested in (Active + Queue)
                try {
                  const filterKey = `aviator:${room}:filter`; // Matches getAviatorMarketFilterKey
                  const filterRaw = await this.client.get(filterKey);

                  if (filterRaw && outbound.symbols) {
                    const interestedStocks = JSON.parse(filterRaw) as string[];
                    const filteredSymbols: Record<string, any> = {};
                    let count = 0;

                    for (const stock of interestedStocks) {
                      if (outbound.symbols[stock]) {
                        filteredSymbols[stock] = outbound.symbols[stock];
                        count++;
                      }
                    }

                    // Only replace if we actually found stocks, otherwise fallback to full (safety)
                    if (count > 0) {
                      outbound.symbols = filteredSymbols;
                    }
                  }
                } catch (e) {
                  // Ignore filter errors, proceed with full payload
                }
                // ------------------------------------

                this.eventsGateway.broadcastMarketDataToRoom(room, outbound);
              })
              .catch((err) => {
                let fullPayload = this.enrichInline(current, previous);

                // Apply any forced deltas here too
                fullPayload = this.applyForcedDeltas(fullPayload);

                this.lastPayloadByMarket[room] = fullPayload;

                // Clone for broadcast (if we wanted to filter here too, but inline is fallback, let's keep it simple or filtered? Let's keep it safe: send full or filter?
                // For consistency, we should filter. But to keep code simple, let's just send full on error fallback.)
                const outbound = fullPayload; // No filter on fallback

                const lastKey = getKeyForLastMarketSnapshot(room);
                (this.client).set(lastKey, JSON.stringify(fullPayload), { EX: 30 }).catch(() => undefined);
                this.logger.warn(`Delta worker failed, used inline enrichment for room=${room}: ${err instanceof Error ? err.message : String(err)}`);
                this.eventsGateway.broadcastMarketDataToRoom(room, outbound);
              });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`Failed to parse/emit event from channel '${channel}'. Error: ${msg}`);
          }
        },
      );

      await this.subscribeToTenantChannels();

      this.subscriberReady = true;
      this.logger.log(`Subscribed to Redis channels: ${channels.join(', ')}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to subscribe to Redis channels. ${message}`);
      this.lastSubscribeError = message;
    }
  }

  private async subscribeToTenantChannels(): Promise<void> {
    try {
      if (!this.stateSubscriber) {
        this.logger.error('Redis state subscriber is not available for tenant channel subscription');
        return;
      }

      await (this.stateSubscriber).pSubscribe(
        'tenant:*:updates',
        (message: string, channel: string) => {
          try {
            if (!channel || !channel.startsWith('tenant:') || !channel.endsWith(':updates')) {
              this.logger.warn(`Received message on invalid tenant channel format: ${channel}`);
              return;
            }
            const tenantId = channel.slice('tenant:'.length, -':updates'.length);
            if (!tenantId) {
              this.logger.warn(`Invalid tenant ID extracted from channel: ${channel}`);
              return;
            }
            if (!message || message.trim().length === 0) {
              this.logger.warn(`Empty message received on tenant channel: ${channel}`);
              return;
            }

            this.balanceUpdateService.handleTenantUpdate(tenantId, message);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`Failed to handle tenant update from channel '${channel}'. Error: ${msg}`);
          }
        },
      );

      this.logger.log('Subscribed to tenant balance update channels on STATE Redis (pattern: tenant:*:updates)');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to subscribe to tenant channels on STATE Redis. ${message}`);
      this.lastSubscribeError = message;
    }
  }

  // --- KV helpers ---
  async exists(key: string): Promise<boolean> {
    const result = await (this.client).exists(key);
    return result === 1;
  }
  async get(key: string): Promise<string | null> {
    return (this.client).get(key);
  }

  async del(key: string): Promise<number> {
    return (this.client).del(key);
  }

  async set(key: string, value: string | number, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await (this.client).set(key, value, { EX: ttlSeconds });
    else await (this.client).set(key, value);
  }
  async hSet(key: string, fields: Record<string, string | number>): Promise<number> {
    return (this.client).hSet(key, fields);
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    return (this.client).hGetAll(key);
  }
  async hIncrBy(key: string, field: string, increment: number): Promise<number> {
    return (this.client).hIncrBy(key, field, increment);
  }
  async hIncrByFloat(key: string, field: string, increment: number): Promise<number> {
    const resultString = await (this.client).hIncrByFloat(key, field, increment);
    return parseFloat(resultString);
  }
  async sMembers(key: string): Promise<string[]> {
    return (this.client).sMembers(key);
  }
  async zRangeByScore(key: string, min: number, max: number): Promise<string[]> {
    return (this.client).zRange(key, min, max, { BY: 'SCORE' });
  }

  /**
   * Inline enrichment fallback for when the worker is unavailable.
   * Computes previousPrice and delta using the last cached snapshot.
   */
  private enrichInline(current: MarketDataPayload, previous?: MarketDataPayload): MarketDataPayload {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const outSymbols: Record<string, any> = Object.create(null);
      const curr = (current as any)?.symbols ?? {};
      const prev = (previous as any)?.symbols ?? {};

      for (const [symbol, snap] of Object.entries(curr)) {
        const priceRaw: any = (snap as any)?.price;
        const price = Number.isFinite(priceRaw) ? Number(priceRaw) : 0;
        const prevPriceRaw: any = prev?.[symbol]?.price;
        const previousPrice = Number.isFinite(prevPriceRaw) ? Number(prevPriceRaw) : null;
        const lastUpdatedAtRaw: any = (snap as any)?.lastUpdatedAt;
        const lastUpdatedAt = Number.isFinite(lastUpdatedAtRaw)
          ? Number(lastUpdatedAtRaw)
          : nowSec;

        let delta = (snap as any).delta || 0; 

        if (delta === 0 && previousPrice !== null && previousPrice !== 0 && Number.isFinite(price)) {
          const change = price - previousPrice;
          const rawPct = (change / previousPrice) * 100;
          delta = Number(rawPct.toFixed(4));
        }

        outSymbols[symbol] = { price, previousPrice, lastUpdatedAt, delta };
      }

      return { market: current.market, timestamp: current.timestamp, symbols: outSymbols } as MarketDataPayload;
    } catch {
      // If anything goes wrong, return current as-is
      return current;
    }
  }

  getLastMarketPayload(market: string): MarketDataPayload | undefined {
    return this.lastPayloadByMarket[market];
  }

  /** Set/refresh expiration for a key without rewriting the value. */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result: number = await (this.client).expire(key, ttlSeconds);
      return result === 1;
    } catch {
      return false;
    }
  }

  // All channel/room names are used directly without extra mapping

  private async reconnectSubscriber(): Promise<void> {
    try {
      this.logger.log('Attempting to reconnect Redis Subscriber...');
      await (this.subscriber).connect();
      await this.subscribeToChannels();
      this.logger.log('Redis Subscriber reconnected successfully');
    } catch (error) {
      this.logger.error('Failed to reconnect Redis Subscriber', error);
    }
  }

  private async reconnectClient(): Promise<void> {
    try {
      this.logger.log('Attempting to reconnect Redis State Client...');
      await (this.client).connect();
      this.clientReady = true;
      this.logger.log('Redis State Client reconnected successfully');
    } catch (error) {
      this.logger.error('Failed to reconnect Redis State Client', error);
    }
  }

  private async reconnectStateSubscriber(): Promise<void> {
    try {
      this.logger.log('Attempting to reconnect Redis State Subscriber...');
      await (this.stateSubscriber).connect();
      await this.subscribeToTenantChannels();
      this.stateSubscriberReady = true;
      this.logger.log('Redis State Subscriber reconnected successfully');
    } catch (error) {
      this.logger.error('Failed to reconnect Redis State Subscriber', error);
    }
  }

  async reconnectAll(): Promise<void> {
    this.logger.log('Attempting to reconnect all Redis clients...');
    await Promise.allSettled([
      this.reconnectClient(),
      this.reconnectSubscriber(),
      this.reconnectStateSubscriber(),
    ]);
  }

  async onModuleDestroy() {
    const promises: Promise<void>[] = [];
    if (this.subscriber) promises.push((this.subscriber as any).quit().catch(() => undefined));
    if (this.client) promises.push((this.client as any).quit().catch(() => undefined));
    if (this.stateSubscriber) promises.push((this.stateSubscriber as any).quit().catch(() => undefined));
    await Promise.all(promises);
    this.logger.log('All Redis connections have been closed.');
  }
}