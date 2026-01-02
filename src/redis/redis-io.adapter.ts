import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, createCluster, type RedisClientType, type RedisClusterType } from 'redis';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import appConfig from 'src/config/app.config';

export class RedisIoAdapter extends IoAdapter {
    private readonly logger = new Logger(RedisIoAdapter.name);
    private adapterConstructor?: ReturnType<typeof createAdapter>;
    private readonly config: ConfigType<typeof appConfig>;
    private pubClient!: RedisClientType | RedisClusterType;
    private subClient!: RedisClientType | RedisClusterType;
    private healthy = false;

    constructor(app: INestApplication) {
        super(app);
        this.config = app.get(appConfig.KEY);
    }

    async connectToRedis(): Promise<void> {
        const redisConfig = this.config.stateRedis;
        this.logger.log(`Connecting Socket.IO adapter using STATE_REDIS config in ${redisConfig.mode} mode...`);

        try {
            const ca = redisConfig.tlsCaCertBase64 ? Buffer.from(redisConfig.tlsCaCertBase64, 'base64') : undefined;

            // Check if URL uses rediss:// protocol or TLS is explicitly enabled
            const isTlsUrl = redisConfig.url?.startsWith('rediss://') || false;
            const shouldUseTls = redisConfig.tlsEnabled || isTlsUrl;

            const socketOptions = {
                reconnectStrategy: (retries: number) => {
                    const delay = Math.min(100 * Math.pow(2, retries), 5000);
                    this.logger.warn(`Socket.IO adapter Redis reconnect #${retries + 1} in ${delay}ms`);
                    return delay;
                },
                tls: shouldUseTls,
                ca,
            } as any;

            if (redisConfig.mode === 'cluster') {
                const rootNodes = redisConfig.clusterEndpoints.map(endpoint => ({
                    socket: { host: endpoint.host, port: endpoint.port, tls: shouldUseTls, ca },
                }));
                this.pubClient = createCluster({
                    rootNodes,
                    defaults: {
                        username: redisConfig.username,
                        password: redisConfig.password,
                        socket: socketOptions,
                    },
                });
                // For cluster, create a separate sub client instead of duplicate() for reliability
                this.subClient = createCluster({
                    rootNodes,
                    defaults: {
                        username: redisConfig.username,
                        password: redisConfig.password,
                        socket: socketOptions,
                    },
                });
            } else {
                if (!redisConfig.url) throw new Error('STATE_REDIS_URL is missing for Socket Adapter');
                this.pubClient = createClient({ url: redisConfig.url, username: redisConfig.username, password: redisConfig.password, socket: socketOptions });
                this.subClient = this.pubClient.duplicate();
            }


            this.pubClient.on('error', (err: Error) => this.logger.error('Socket.IO Redis pub error', err?.stack));
            this.subClient.on('error', (err: Error) => this.logger.error('Socket.IO Redis sub error', err?.stack));
            this.pubClient.on('end', () => this.logger.warn('Socket.IO Redis pub connection ended'));
            this.subClient.on('end', () => this.logger.warn('Socket.IO Redis sub connection ended'));

            await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
            this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
            this.logger.log('Socket.IO adapter connected to Redis successfully.');
            this.healthy = true;
        } catch (err) {
            this.adapterConstructor = undefined;
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Socket.IO adapter failed to connect to Redis. Falling back to in-memory adapter. Error: ${message}`);
            this.healthy = false;
        }
    }

    createIOServer(port: number, options?: ServerOptions): any {
        const server = super.createIOServer(port, {
            ...options,
            cors: { origin: this.config.corsOrigin || '*', methods: ['GET', 'POST'] },
            perMessageDeflate: {
                threshold: 16384,
            },
        });
        if (this.adapterConstructor) {
            server.adapter(this.adapterConstructor);
        } else {
            this.logger.warn('Running Socket.IO without Redis adapter (single-instance mode).');
        }
        return server;
    }

    isHealthy(): boolean {
        return this.healthy === true;
    }
}