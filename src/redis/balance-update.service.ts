import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { EventsGateway } from 'src/events/events.gateway';

interface BalanceUpdatePayload {
  type: 'BALANCE_UPDATE';
  payload: Array<{ playerId: string; balance: string }>;
}

@Injectable()
export class BalanceUpdateService {
  private readonly logger = new Logger(BalanceUpdateService.name);

  constructor(
    @Inject(forwardRef(() => EventsGateway))
    private readonly eventsGateway: EventsGateway,
  ) { }

  handleTenantUpdate(tenantId: string, message: string): void {
    try {
      const data = JSON.parse(message);
      if (data.type === 'BALANCE_UPDATE') {
        this.handleBalanceUpdate(tenantId, data.payload);
      }
    } catch (error) {
      this.logger.error(`Failed to parse tenant update: ${error.message}`);
    }
  }

  private handleBalanceUpdate(tenantId: string, updates: Array<{ playerId: string; balance: string }>): void {
    for (const update of updates) {
      const room = `balance:${tenantId}:${update.playerId}`;
            this.eventsGateway.emitBalanceUpdateToPlayerRoom(room, {
        playerId: update.playerId,
        balance: parseFloat(update.balance),
        currency: 'USD'
      });
    }
  }
  
  getPlayerBalanceRoom(tenantId: string, playerId: string): string {
    return `balance:${tenantId}:${playerId}`;
  }
}