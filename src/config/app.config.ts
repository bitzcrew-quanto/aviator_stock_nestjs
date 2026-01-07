import { registerAs } from '@nestjs/config';

const parseClusterEndpoints = (endpoints: string | undefined) => {
    if (!endpoints) return [];
    return endpoints
        .split(',')
        .map((endpoint) => {
            const [host, port] = endpoint.trim().split(':');
            return { host, port: parseInt(port, 10) || 6379 };
        })
        .filter((x) => x.host);
};

const createRedisConfig = (prefix: string) => ({
    mode: process.env[`${prefix}_REDIS_MODE`] || 'standalone',              // 'standalone' | 'cluster'
    url: process.env[`${prefix}_REDIS_URL`],                                // standalone
    // Cluster (preferred)
    configEndpoint: process.env[`${prefix}_REDIS_CONFIG_ENDPOINT`],         // clustercfg.*.cache.amazonaws.com
    port: Number(process.env[`${prefix}_REDIS_PORT`] ?? 6379),
    // Cluster (fallback explicit nodes)
    clusterEndpoints: parseClusterEndpoints(process.env[`${prefix}_REDIS_CLUSTER_ENDPOINTS`]),
    tlsEnabled: process.env[`${prefix}_REDIS_TLS_ENABLED`] === 'true',
    username: process.env[`${prefix}_REDIS_USERNAME`],
    password: process.env[`${prefix}_REDIS_PASSWORD`],
    tlsCaCertBase64: process.env[`${prefix}_REDIS_TLS_CA_CERT`],            // optional base64-encoded CA PEM
});



export default registerAs('app', () => ({
    env: process.env.NODE_ENV!,
    port: parseInt(process.env.PORT || '3000', 10),
    subscribeChannels: process.env.SUBSCRIBE_CHANNELS!.split(',').map((c) => c.trim()).filter(Boolean), // These are the Game Rooms
    corsOrigin: process.env.CORS_ORIGIN || '*',

    // Aviator Game Configuration
    aviator: {
        bettingDurationMs: parseInt(process.env.AVIATOR_BETTING_DURATION_MS || '6000', 10),
        postCrashDurationMs: parseInt(process.env.AVIATOR_POST_CRASH_DURATION_MS || '3000', 10),
    },

    // HQ Service Configuration
    hqServiceUrl: process.env.HQ_SERVICE_URL!,
    hqServiceTimeout: parseInt(process.env.HQ_SERVICE_TIMEOUT || '5000', 10),

    // Two Redis configs
    pubsubRedis: createRedisConfig('PUBSUB'),
    stateRedis: createRedisConfig('STATE'),
}));
