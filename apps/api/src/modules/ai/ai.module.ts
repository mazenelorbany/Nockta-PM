import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';

import { AnalyticsModule } from '../analytics/analytics.module';
import { ChatModule } from '../chat/chat.module';

import { AiController } from './ai.controller';
import { AiCostTrackingService } from './ai-cost-tracking.service';
import { AiCronService } from './ai-cron.service';
import { AiDispatcherService } from './ai-dispatcher.service';
import { AiSprintPlanningService } from './ai-sprint-planning.service';
import { AiStandupService } from './ai-standup.service';
import { AiSyncService } from './ai-sync.service';
import {
  BlockerPredictionProcessor, DuplicateDetectionProcessor,
  EmbeddingProcessor, PrioritizeProcessor, SummarizeProcessor,
} from './ai.processors';
import {
  AI_BLOCKER_QUEUE, AI_DUPLICATE_QUEUE, AI_EMBED_QUEUE, AI_PRIORITIZE_QUEUE, AI_SUMMARIZE_QUEUE,
} from './ai.queues';
import { EmbeddingService } from './embedding.service';
import { LlmService } from './llm.service';
import { QdrantService } from './qdrant.service';
import { WorkspaceAiSettingsController } from './workspace-ai-settings.controller';
import { WorkspaceAiSettingsService } from './workspace-ai-settings.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    forwardRef(() => ChatModule),
    AnalyticsModule,
    BullModule.registerQueue(
      { name: AI_EMBED_QUEUE },
      { name: AI_DUPLICATE_QUEUE },
      { name: AI_SUMMARIZE_QUEUE },
      { name: AI_BLOCKER_QUEUE },
      { name: AI_PRIORITIZE_QUEUE },
    ),
  ],
  controllers: [AiController, WorkspaceAiSettingsController],
  providers: [
    LlmService,
    QdrantService,
    EmbeddingService,
    AiCronService,
    AiDispatcherService,
    AiSyncService,
    AiStandupService,
    AiSprintPlanningService,
    AiCostTrackingService,
    WorkspaceAiSettingsService,
    EmbeddingProcessor,
    DuplicateDetectionProcessor,
    SummarizeProcessor,
    BlockerPredictionProcessor,
    PrioritizeProcessor,
  ],
  exports: [
    LlmService,
    EmbeddingService,
    QdrantService,
    AiSyncService,
    AiStandupService,
    AiSprintPlanningService,
    AiCostTrackingService,
    WorkspaceAiSettingsService,
  ],
})
export class AiModule {}
