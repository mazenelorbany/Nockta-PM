import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Env } from '../../config/env';

export const TASKS_COLLECTION = 'tasks';
const EMBEDDING_DIM = 768; // nomic-embed-text

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private readonly client: QdrantClient;

  constructor() {
    this.client = new QdrantClient({
      url: Env.QDRANT_URL,
      ...(Env.QDRANT_API_KEY ? { apiKey: Env.QDRANT_API_KEY } : {}),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === TASKS_COLLECTION);
      if (!exists) {
        await this.client.createCollection(TASKS_COLLECTION, {
          vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
        });
        this.logger.log(`created Qdrant collection ${TASKS_COLLECTION}`);
      }
    } catch (err) {
      this.logger.warn({ err }, 'Qdrant not reachable — AI features will degrade');
    }
  }

  async upsertTask(taskId: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    await this.client.upsert(TASKS_COLLECTION, {
      points: [{ id: taskId, vector, payload }],
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.client.delete(TASKS_COLLECTION, { points: [taskId] });
  }

  async searchSimilar(
    vector: number[],
    options: { limit?: number; projectId?: string; excludeTaskId?: string } = {},
  ): Promise<{ id: string; score: number; payload: Record<string, unknown> }[]> {
    const filterMust: unknown[] = [];
    if (options.projectId) filterMust.push({ key: 'projectId', match: { value: options.projectId } });
    const result = await this.client.search(TASKS_COLLECTION, {
      vector,
      limit: options.limit ?? 5,
      ...(filterMust.length > 0 ? { filter: { must: filterMust } } : {}),
      with_payload: true,
    });
    return result
      .filter((p) => String(p.id) !== options.excludeTaskId)
      .map((p) => ({
        id: String(p.id),
        score: p.score,
        payload: (p.payload as Record<string, unknown>) ?? {},
      }));
  }
}
