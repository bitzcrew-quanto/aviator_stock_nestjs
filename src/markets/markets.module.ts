import { Module } from '@nestjs/common';
import { MarketStatusService } from './market-status.service';

@Module({
    providers: [MarketStatusService],
    exports: [MarketStatusService],
})
export class MarketsModule { }
