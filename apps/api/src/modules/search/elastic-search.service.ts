import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Thin OpenSearch / Elasticsearch client + indexer. Speaks the v7+ REST API
 * via `fetch` so we don't pull in @elastic/elasticsearch just for write +
 * search. Listens to task / comment events from the in-process EventEmitter
 * and keeps a parallel index in sync.
 *
 * Disabled when SEARCH_ELASTIC_URL is empty — every method becomes a no-op,
 * so the rest of the system runs unchanged.
 */
@Injectable()
export class ElasticSearchService implements OnModuleInit {
  private readonly logger = new Logger(ElasticSearchService.name);
  private readonly base = Env.SEARCH_ELASTIC_URL;
  private readonly index = Env.SEARCH_ELASTIC_INDEX_TASKS;
  private readonly apiKey = Env.SEARCH_ELASTIC_API_KEY;

  constructor(private readonly prisma: PrismaService) {}

  get enabled(): boolean {
    return !!this.base;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureIndex();
    } catch (err) {
      this.logger.warn(
        `Could not ensure index "${this.index}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ---------------- Event handlers ----------------

  @OnEvent('task.created')
  @OnEvent('task.updated')
  async onTaskMutated(event: { taskId: string }): Promise<void> {
    if (!this.enabled || !event?.taskId) return;
    await this.indexTask(event.taskId).catch((err) => {
      this.logger.warn(`indexTask(${event.taskId}) failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  @OnEvent('task.deleted')
  async onTaskDeleted(event: { taskId: string }): Promise<void> {
    if (!this.enabled || !event?.taskId) return;
    await this.request('DELETE', `/${this.index}/_doc/${event.taskId}`).catch(() => undefined);
  }

  @OnEvent('comment.added')
  @OnEvent('comment.edited')
  async onCommentMutated(event: { taskId: string }): Promise<void> {
    if (!this.enabled || !event?.taskId) return;
    // Re-index the parent task so its concatenated comment text stays fresh.
    await this.indexTask(event.taskId).catch(() => undefined);
  }

  // ---------------- Search ----------------

  /**
   * Returns task IDs ordered by ES relevance, intersected with the supplied
   * project filter and (for clients) the client_visible visibility gate.
   * Returns null if ES isn't configured — callers should fall back to
   * Postgres FTS.
   */
  async search(q: string, projectIds: string[], clientOnly: boolean): Promise<string[] | null> {
    if (!this.enabled) return null;
    if (projectIds.length === 0) return [];
    const body = {
      size: 500,
      _source: false,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query: q,
                fields: ['title^3', 'description', 'comments'],
                fuzziness: 'AUTO',
              },
            },
          ],
          filter: [
            { terms: { projectId: projectIds } },
            ...(clientOnly ? [{ term: { visibility: 'client_visible' } }] : []),
          ],
        },
      },
    };
    const res = await this.request<{
      hits: { hits: { _id: string }[] };
    }>('POST', `/${this.index}/_search`, body);
    return res.hits.hits.map((h) => h._id);
  }

  // ---------------- Internals ----------------

  private async indexTask(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true, title: true, description: true, status: true, priority: true,
        visibility: true, projectId: true, assigneeUserId: true, createdAt: true,
        comments: {
          where: { deletedAt: null },
          select: { bodyMd: true },
          take: 200, // hard cap on text we ingest per task
        },
      },
    });
    if (!task) {
      await this.request('DELETE', `/${this.index}/_doc/${taskId}`).catch(() => undefined);
      return;
    }
    const doc = {
      title: task.title,
      description: task.description ?? '',
      status: task.status,
      priority: task.priority,
      visibility: task.visibility,
      projectId: task.projectId,
      assigneeUserId: task.assigneeUserId,
      createdAt: task.createdAt,
      comments: task.comments.map((c) => c.bodyMd).join('\n'),
    };
    await this.request('PUT', `/${this.index}/_doc/${taskId}`, doc);
  }

  private async ensureIndex(): Promise<void> {
    const head = await this.request<unknown>('HEAD', `/${this.index}`, undefined, { allow404: true });
    if (head !== null) return; // exists
    await this.request('PUT', `/${this.index}`, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        properties: {
          title:           { type: 'text', analyzer: 'standard' },
          description:     { type: 'text', analyzer: 'standard' },
          comments:        { type: 'text', analyzer: 'standard' },
          status:          { type: 'keyword' },
          priority:        { type: 'keyword' },
          visibility:      { type: 'keyword' },
          projectId:       { type: 'keyword' },
          assigneeUserId:  { type: 'keyword' },
          createdAt:       { type: 'date' },
        },
      },
    });
    this.logger.log(`Created index "${this.index}"`);
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
    path: string,
    body?: unknown,
    opts: { allow404?: boolean } = {},
  ): Promise<T> {
    const url = `${this.base!}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `ApiKey ${this.apiKey}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && opts.allow404) return null as unknown as T;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    if (method === 'HEAD' || res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }
}
