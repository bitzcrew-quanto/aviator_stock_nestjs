import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { MarketStatusService } from './market-status.service';
import { RedisModule } from '../redis/redis.module';

@Module({
    imports: [
        HttpModule,
        ConfigModule,
        forwardRef(() => RedisModule)
    ],
    providers: [MarketStatusService],
    exports: [MarketStatusService],
})
export class MarketsModule { }
