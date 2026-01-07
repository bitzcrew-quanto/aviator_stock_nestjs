import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import appConfig from './config/app.config';
import { RedisModule } from './redis/redis.module';
import { EventsModule } from './events/events.module';
import { MarketsModule } from './markets/markets.module';
import { AviatorModule } from './game/aviator/aviator.module';
import { HttpModule } from './http/http.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
    }),
    RedisModule, // Global
    EventsModule,
    MarketsModule,
    HttpModule,
    AviatorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
