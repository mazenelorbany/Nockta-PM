import { Module } from '@nestjs/common';
import { RecurrenceController } from './recurrence.controller';
import { RecurrenceSchedulerService } from './recurrence-scheduler.service';
import { RecurrenceService } from './recurrence.service';

@Module({
  controllers: [RecurrenceController],
  providers: [RecurrenceService, RecurrenceSchedulerService],
  exports: [RecurrenceService],
})
export class RecurrenceModule {}
