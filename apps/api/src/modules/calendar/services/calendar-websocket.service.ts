import { Injectable, Logger } from '@nestjs/common';

import { CalendarGateway } from '../gateways/calendar.gateway';

@Injectable()
export class CalendarWebSocketService {
  private readonly logger = new Logger(CalendarWebSocketService.name);

  constructor(private readonly calendarGateway: CalendarGateway) {}

  notifyWeeklyLoadUpdated(
    athleteId: number,
    context?: { eventId?: number; reason?: 'event_deleted' | 'event_updated' },
  ): void {
    try {
      this.calendarGateway.broadcastToAthlete(
        athleteId,
        'weekly_load_updated',
        {
          athleteId,
          ...context,
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to notify weekly load updated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  notifyActivityProcessed(eventId: number, athleteId: number): void {
    try {
      this.calendarGateway.broadcastToAthlete(athleteId, 'activity_processed', {
        eventId,
        athleteId,
      });
    } catch (error) {
      this.logger.error(
        `Failed to notify activity processed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
