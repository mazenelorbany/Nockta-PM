import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../prisma/prisma.service';

import { EVENT_MAP } from './event-map';

/**
 * Subscribes to every domain event emitted via EventEmitter2 and persists it
 * to the `events` table. Drives both the user-facing Activity Timeline and the
 * Admin-only Audit Log (they're two queries over the same table).
 */
@Injectable()
export class EventWriterService implements OnModuleInit {
  private readonly logger = new Logger(EventWriterService.name);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.emitter.onAny((event, payload) => {
      const name = Array.isArray(event) ? event.join('.') : (event as string);
      void this.handle(name, payload as Record<string, unknown>);
    });
  }

  private async handle(eventName: string, payload: Record<string, unknown>): Promise<void> {
    const mapping = EVENT_MAP[eventName];
    if (!mapping) return; // ignore unmapped events (sub-systems may emit internal-only signals)

    const entityIdRaw = payload[mapping.entityIdKey];
    if (entityIdRaw === undefined || entityIdRaw === null) {
      this.logger.warn({ eventName, payload }, 'event missing entityId, skipping');
      return;
    }
    const entityId = String(entityIdRaw);
    const projectId = mapping.projectIdKey
      ? (payload[mapping.projectIdKey] as string | undefined) ?? null
      : null;
    const actorUserId = (payload['actorUserId'] as string | undefined) ?? null;

    try {
      await this.prisma.event.create({
        data: {
          type: mapping.type,
          actorUserId,
          entityType: mapping.entityType,
          entityId,
          projectId,
          visibility: mapping.visibility,
          payload: payload as object,
        },
      });
    } catch (err) {
      // Persistence failures should not break the request path — log and move on.
      this.logger.error({ err, eventName }, 'failed to persist event');
    }
  }
}
