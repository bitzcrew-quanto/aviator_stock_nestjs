import { forwardRef, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { RedisModule } from 'src/redis/redis.module';
import { MarketsModule } from 'src/markets/markets.module';

@Module({
    imports: [
        forwardRef(() => RedisModule),
        MarketsModule
    ],
    providers: [EventsGateway],
    exports: [EventsGateway],
})
export class EventsModule { }
