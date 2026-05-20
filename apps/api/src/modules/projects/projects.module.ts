import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AuthModule } from '../auth/auth.module';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectWorkflowService } from './project-workflow.service';
import { ProjectsPurgeProcessor } from './projects-purge.processor';

@Module({
  // ScheduleModule.forRoot() is already imported by AiModule but Nest dedupes
  // on the same token, so a second import here keeps this module self-contained
  // when wired into a non-Ai-bearing stack (e.g. a stripped E2E harness).
  // AuthModule is imported because ProjectsService depends on AuthService for
  // the magic-link invitation flow.
  imports: [ScheduleModule.forRoot(), AuthModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectWorkflowService, ProjectsPurgeProcessor],
  exports: [ProjectsService, ProjectWorkflowService],
})
export class ProjectsModule {}
