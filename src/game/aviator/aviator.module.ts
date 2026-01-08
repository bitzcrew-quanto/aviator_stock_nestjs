import { Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';
import { HttpModule } from 'src/http/http.module';
import { EventsModule } from 'src/events/events.module';
import { MarketsModule } from 'src/markets/markets.module';
import { AviatorGameLoopService } from './services/game-loop.service';
import { AviatorBetService } from './services/bet.service';
import { AviatorGateway } from './aviator.gateway';

@Module({
    imports: [
        RedisModule,
        HttpModule,
        HttpModule,
        EventsModule,
        MarketsModule
    ],
    providers: [
        AviatorGameLoopService,
        AviatorBetService,
        AviatorGateway
    ],
    exports: [AviatorGameLoopService]
})
export class AviatorModule { }