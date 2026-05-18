import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AI_SUMMARIZE_QUEUE } from '../ai/ai.queues';

import { AutoStatusService } from './auto-status.service';
import { GithubAppService } from './github-app.service';
import { GithubEventsService } from './github-events.service';
import { GithubInstallController } from './github-install.controller';
import { GithubWebhookController } from './github-webhook.controller';

@Module({
  // Registering the summarize queue here (without producing the worker) gives
  // GithubEventsService an injectable Queue to push PR-merged summarization jobs to.
  imports: [BullModule.registerQueue({ name: AI_SUMMARIZE_QUEUE })],
  controllers: [GithubWebhookController, GithubInstallController],
  providers: [GithubAppService, GithubEventsService, AutoStatusService],
  exports: [GithubAppService, AutoStatusService],
})
export class GithubModule {}
