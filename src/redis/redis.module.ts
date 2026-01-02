import { forwardRef, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { BalanceUpdateService } from './balance-update.service';
import { EventsModule } from 'src/events/events.module';
import { DeltaWorkerService } from 'src/workers/delta.service';

@Module({
  imports: [forwardRef(() => EventsModule)],
  providers: [RedisService, BalanceUpdateService, DeltaWorkerService],
  exports: [RedisService, BalanceUpdateService, DeltaWorkerService],
})
export class RedisModule { }