import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ExportsController } from './exports.controller';
import { ExportsProcessor } from './exports.processor';
import { ExportsScheduler } from './exports.scheduler';
import { EXPORTS_QUEUE, ExportsService } from './exports.service';

// =============================================================================
// ExportsModule — scheduled + on-demand exports.
//
// Wires the BullMQ queue ('exports'), the CRUD controller, the service that
// owns the lifecycle, the worker that does the actual serialise + upload, and
// the in-process minute-tick scheduler that fires due ExportSchedule rows.
//
// StorageService is provided globally by StorageModule, so it just falls
// through into the processor's constructor without an explicit import here.
// =============================================================================

@Module({
  imports: [BullModule.registerQueue({ name: EXPORTS_QUEUE })],
  controllers: [ExportsController],
  providers: [ExportsService, ExportsProcessor, ExportsScheduler],
  exports: [ExportsService],
})
export class ExportsModule {}
