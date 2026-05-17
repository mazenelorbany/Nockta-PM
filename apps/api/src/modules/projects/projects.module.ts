import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectsPurgeProcessor } from './projects-purge.processor';

@Module({
  // ScheduleModule.forRoot() is already imported by AiModule but Nest dedupes
  // on the same token, so a second import here keeps this module self-contained
  // when wired into a non-Ai-bearing stack (e.g. a stripped E2E harness).
  imports: [ScheduleModule.forRoot()],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectsPurgeProcessor],
  exports: [ProjectsService],
})
export class ProjectsModule {}
