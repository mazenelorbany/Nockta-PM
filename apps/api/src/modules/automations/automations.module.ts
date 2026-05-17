import { Module } from '@nestjs/common';
import { AutomationsController } from './automations.controller';
import { AutomationsListener } from './automations.listener';
import { AutomationsService } from './automations.service';
import { DueSoonScheduler } from './due-soon.scheduler';

@Module({
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationsListener, DueSoonScheduler],
  exports: [AutomationsService],
})
export class AutomationsModule {}
