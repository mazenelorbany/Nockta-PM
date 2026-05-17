import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { CustomReportsController } from './reports.controller';
import { CustomReportsService } from './reports.service';

@Module({
  controllers: [AnalyticsController, CustomReportsController],
  providers: [AnalyticsService, CustomReportsService],
  exports: [AnalyticsService, CustomReportsService],
})
export class AnalyticsModule {}
