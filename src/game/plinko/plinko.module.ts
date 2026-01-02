import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from 'src/redis/redis.module';
import { EventsModule } from 'src/events/events.module';
import { HttpModule } from 'src/http/http.module'; 
import { PlinkoPriceService } from './services/price.service';
import { PlinkoGameLoopService } from './services/game-loop.service';

@Module({
    imports: [
        ConfigModule,
        RedisModule,
        EventsModule,
        HttpModule, 
    ],
    providers: [
        PlinkoPriceService,
        PlinkoGameLoopService,
    ],
    exports: [
        PlinkoPriceService,
    ],
})
export class PlinkoModule { }