import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { EventWriterService } from './event-writer.service';
import { EventsService } from './events.service';
import { TimelineController } from './timeline.controller';

@Module({
  controllers: [TimelineController, AuditLogController],
  providers: [EventsService, EventWriterService],
  exports: [EventsService],
})
export class EventsModule {}
