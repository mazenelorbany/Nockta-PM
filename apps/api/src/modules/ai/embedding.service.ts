import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';

import type { LlmService } from './llm.service';
import type { QdrantService } from './qdrant.service';

function hashSource(title: string, description: string | null): string {
  return createHash('sha256').update(`${title}\n${description ?? ''}`).digest('hex');
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly qdrant: QdrantService,
  ) {}

  /** Compute & upsert the task's vector if the source has changed since last embed. */
  async ensureFreshEmbedding(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, title: true, description: true, status: true, visibility: true },
    });
    if (!task) return;

    const sourceHash = hashSource(task.title, task.description);
    const meta = await this.prisma.taskEmbeddingMeta.findUnique({ where: { taskId } });
    if (meta && meta.sourceHash === sourceHash) return;

    const vector = await this.llm.embed(`${task.title}\n\n${task.description ?? ''}`);
    await this.qdrant.upsertTask(task.id, vector, {
      projectId: task.projectId,
      status: task.status,
      visibility: task.visibility,
      title: task.title,
    });
    await this.prisma.taskEmbeddingMeta.upsert({
      where: { taskId },
      update: { qdrantPointId: task.id, sourceHash },
      create: { taskId, qdrantPointId: task.id, sourceHash },
    });
  }

  async deleteEmbedding(taskId: string): Promise<void> {
    await this.qdrant.deleteTask(taskId);
    await this.prisma.taskEmbeddingMeta.deleteMany({ where: { taskId } });
  }
}
