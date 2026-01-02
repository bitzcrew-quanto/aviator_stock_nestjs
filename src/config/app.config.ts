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

const parseMultipliers = (raw: string | undefined): number[] => {
    if (!raw || raw.trim() === '') return [1, 1.2, 1.5, 2, 3, 5];

    try {
        const asJson = JSON.parse(raw);
        if (Array.isArray(asJson)) {
            return asJson.map((v) => Number(v)).filter((v) => Number.isFinite(v));
        }
    } catch { }
    return raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((v) => Number.isFinite(v));
};

export default registerAs('app', () => ({
    env: process.env.NODE_ENV!,
    port: parseInt(process.env.PORT || '3000', 10),
    subscribeChannels: process.env.SUBSCRIBE_CHANNELS!.split(',').map((c) => c.trim()).filter(Boolean),
    corsOrigin: process.env.CORS_ORIGIN || '*',
    multipliers: parseMultipliers(process.env.MULTIPLIER),
    gameName: process.env.GAME_NAME!,
    desiredRtp: parseFloat(process.env.DESIRED_RTP!),
    thresholdPlayCount: parseInt(process.env.THRESHOLD_PLAYCOUNT!, 10),

    // HQ Service Configuration̋
    hqServiceUrl: process.env.HQ_SERVICE_URL!,
    hqServiceTimeout: parseInt(process.env.HQ_SERVICE_TIMEOUT || '5000', 10),

    // Two Redis configs
    pubsubRedis: createRedisConfig('PUBSUB'),
    stateRedis: createRedisConfig('STATE'),
}));
