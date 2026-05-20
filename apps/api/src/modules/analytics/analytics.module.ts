import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { CustomReportsController } from './reports.controller';
import { CustomReportsService } from './reports.service';
import { SprintReportService } from './sprint-report.service';

@Module({
  controllers: [AnalyticsController, CustomReportsController],
  providers: [AnalyticsService, CustomReportsService, SprintReportService],
  exports: [AnalyticsService, CustomReportsService, SprintReportService],
})
export class AnalyticsModule {}
