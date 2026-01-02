import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RedisHealthIndicator {

  constructor(private readonly redisService: RedisService) { }

  async check(key: string): Promise<HealthIndicatorResult> {
    try {
      const ok = await this.redisService.isHealthy();
      if (!ok) {
        throw new Error('RedisService reported unhealthy');
      }
      return { [key]: { status: 'up' } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HealthCheckError('RedisService health check failed', { [key]: { status: 'down', message } });
    }
  }

  async checkDetailed(key: string): Promise<HealthIndicatorResult> {
    try {
      const snapshot = await this.redisService.getHealthSnapshot();
      const status = snapshot.stateClientOperational && snapshot.subscriberOperational ? 'up' : 'down';
      return {
        [key]: {
          status,
          details: {
            mode: {
              pubsub: snapshot.pubsubMode,
              state: snapshot.stateMode,
            },
            tls: {
              pubsub: snapshot.pubsubTls,
              state: snapshot.stateTls,
            },
            stateClientOperational: snapshot.stateClientOperational,
            subscriberOperational: snapshot.subscriberOperational,
            lastSubscribeError: snapshot.lastSubscribeError,
            cluster: snapshot.cluster,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HealthCheckError('RedisService detailed health check failed', { [key]: { status: 'down', message } });
    }
  }
}