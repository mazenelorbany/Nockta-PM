import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';

import { AI_DUPLICATE_QUEUE, AI_EMBED_QUEUE, AI_PRIORITIZE_QUEUE, AI_SUMMARIZE_QUEUE } from './ai.queues';

@Injectable()
export class AiDispatcherService implements OnModuleInit {
  constructor(
    private readonly emitter: EventEmitter2,
    @InjectQueue(AI_EMBED_QUEUE) private readonly embedQueue: Queue,
    @InjectQueue(AI_DUPLICATE_QUEUE) private readonly dupQueue: Queue,
    @InjectQueue(AI_SUMMARIZE_QUEUE) private readonly sumQueue: Queue,
    @InjectQueue(AI_PRIORITIZE_QUEUE) private readonly prioQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.emitter.on('task.created', async (payload: Record<string, unknown>) => {
      const taskId = payload['taskId'] as string;
      if (!taskId) return;
      await this.embedQueue.add('embed', { taskId });
      // Duplicate detection runs on every new task, with extra weight if client-reported.
      await this.dupQueue.add('detect', { taskId });
      // Auto-prioritization. The processor is idempotent: it no-ops unless the
      // task is still at the default Medium priority and has no rationale yet
      // (which happens to filter out anything created via CSV import where the
      // user explicitly set a priority).
      await this.prioQueue.add('prioritize', { taskId });
    });

    this.emitter.on('task.updated', async (payload: Record<string, unknown>) => {
      const taskId = payload['taskId'] as string;
      const changes = (payload['changes'] as Record<string, unknown> | undefined) ?? {};
      if (taskId && (changes['title'] !== undefined || changes['description'] !== undefined)) {
        await this.embedQueue.add('embed', { taskId });
      }
    });

    this.emitter.on('sprint.completed', async (payload: Record<string, unknown>) => {
      const sprintId = payload['sprintId'] as string;
      if (sprintId) await this.sumQueue.add('summarize-sprint', { kind: 'sprint', sprintId });
    });

    this.emitter.on('github.pr_merged', async (payload: Record<string, unknown>) => {
      const taskId = payload['taskId'] as string;
      const prTitle = (payload['prTitle'] as string | undefined) ?? '';
      const prBody = (payload['prBody'] as string | null | undefined) ?? null;
      const prUrl = (payload['prUrl'] as string | undefined) ?? '';
      if (taskId && prTitle) {
        await this.sumQueue.add('summarize-pr', { kind: 'pr', taskId, prTitle, prBody, prUrl });
      }
    });
  }
}
