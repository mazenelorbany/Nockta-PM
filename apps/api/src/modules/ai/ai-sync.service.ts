import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { AiCostTrackingService } from './ai-cost-tracking.service';
import { LlmService } from './llm.service';
import { QdrantService } from './qdrant.service';

/**
 * Synchronous (request-blocking) AI helpers. Each call runs the LLM/embedding
 * inline and returns the result so the UI can show it immediately.
 *
 * Use the BullMQ-backed flows in ai.processors for fire-and-forget background
 * work (auto-duplicate-comments on task creation, nightly blocker scans, etc).
 */
@Injectable()
export class AiSyncService {
  private readonly logger = new Logger(AiSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly llm: LlmService,
    private readonly qdrant: QdrantService,
    // Optional so tests that mocked out the older 4-arg constructor signature
    // keep working. Nest still injects it at runtime; only the test-utils mock
    // path goes without and degrades to no-op cost telemetry.
    private readonly costs?: AiCostTrackingService,
  ) {}

  // -------- Sprint summary (sync) --------

  async summarizeSprint(actor: AuthenticatedUser, sprintId: string): Promise<{ summary: string; generatedAt: string }> {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: {
        tasks: {
          select: {
            keyNumber: true,
            title: true,
            status: true,
            priority: true,
            isBlocked: true,
            blockedReason: true,
            assignee: { select: { name: true } },
          },
        },
        project: { select: { id: true, key: true, name: true } },
      },
    });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.permissions.assertAtLeast(actor, sprint.project.id, 'Contributor');

    if (sprint.tasks.length === 0) {
      const empty = 'No tasks in this sprint yet — nothing to summarize.';
      return { summary: empty, generatedAt: new Date().toISOString() };
    }

    const tasksList = sprint.tasks
      .map((t) =>
        `- ${sprint.project.key}-${t.keyNumber} [${t.status}${t.isBlocked ? ', BLOCKED' : ''}] ` +
        `(${t.priority}${t.assignee ? `, ${t.assignee.name}` : ''}): ${t.title}` +
        (t.blockedReason ? ` — blocked: ${t.blockedReason}` : '')
      )
      .join('\n');

    const sprintResult = await this.llm.generateWithUsage(
      `Sprint: ${sprint.name} for ${sprint.project.name}\n\n` +
      `Tasks (${sprint.tasks.length}):\n${tasksList}\n\n` +
      `Write a clear, factual summary in 4 sections:\n` +
      `1. **Executive summary** — 2 sentences\n` +
      `2. **Shipped** — bullet list of completed work\n` +
      `3. **In flight / slipped** — what's still open or stuck\n` +
      `4. **Risks & blockers** — concrete blockers worth raising\n\n` +
      `Use markdown. Be concise. Don't invent details not in the data.`,
      {
        systemPrompt: 'You are an engineering manager writing a sprint review. Be terse, factual, and actionable.',
        maxTokens: 800,
        temperature: 0.2,
      },
    );
    const summary = sprintResult.text;
    await this.costs?.record({
      kind: 'summarize',
      modelName: sprintResult.modelName,
      inputTokens: sprintResult.inputTokens,
      outputTokens: sprintResult.outputTokens,
      userId: actor.id,
    });

    const now = new Date();
    await this.prisma.sprint.update({
      where: { id: sprintId },
      data: { aiSummary: summary, aiSummaryAt: now },
    });

    return { summary, generatedAt: now.toISOString() };
  }

  // -------- Similar tasks / duplicate detection (sync) --------

  async findSimilarTasks(actor: AuthenticatedUser, taskId: string): Promise<
    Array<{ taskId: string; key: string; title: string; status: string; score: number }>
  > {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { select: { id: true, key: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');
    await this.permissions.assertAtLeast(actor, task.projectId, 'Viewer');

    let vector: number[];
    try {
      const embedText = `${task.title}\n\n${task.description ?? ''}`;
      vector = await this.llm.embed(embedText);
      // Record the embed call against duplicate-detection telemetry. The
      // /tasks/:id/similar endpoint is the sync version of the same feature
      // the queue processor runs, so we bucket it under the same `duplicate`
      // kind for budgeting + dashboarding.
      await this.costs?.record({
        kind: 'duplicate',
        modelName: 'nomic-embed-text',
        inputTokens: Math.ceil(embedText.length / 4),
        outputTokens: 0,
        userId: actor.id,
      });
    } catch (err) {
      this.logger.warn(`Embedding failed, falling back to keyword search: ${err instanceof Error ? err.message : err}`);
      return this.fallbackKeywordSearch(task);
    }

    let hits: Awaited<ReturnType<typeof this.qdrant.searchSimilar>>;
    try {
      hits = await this.qdrant.searchSimilar(vector, {
        limit: 10,
        projectId: task.projectId,
        excludeTaskId: task.id,
      });
    } catch (err) {
      this.logger.warn(`Qdrant search failed, falling back to keyword search: ${err instanceof Error ? err.message : err}`);
      return this.fallbackKeywordSearch(task);
    }

    // Filter to "meaningfully similar" — >= 0.7 — and to tasks the actor can see.
    const candidates = hits.filter((h) => h.score >= 0.7);
    if (candidates.length === 0) return [];

    const taskIds = candidates.map((c) => (c.payload['taskId'] as string) ?? '').filter(Boolean);
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, title: true, status: true, keyNumber: true, project: { select: { key: true } }, visibility: true, projectId: true },
    });

    const result: Array<{ taskId: string; key: string; title: string; status: string; score: number }> = [];
    for (const c of candidates) {
      const t = tasks.find((x) => x.id === c.payload['taskId']);
      if (!t) continue;
      const canSee = await this.permissions.canSeeTask(actor, t.projectId, t.visibility);
      if (!canSee) continue;
      result.push({
        taskId: t.id,
        key: `${t.project.key}-${t.keyNumber}`,
        title: t.title,
        status: t.status,
        score: c.score,
      });
    }
    return result;
  }

  private async fallbackKeywordSearch(
    task: { id: string; title: string; projectId: string; project: { key: string } },
  ): Promise<Array<{ taskId: string; key: string; title: string; status: string; score: number }>> {
    // Very rough: tokenize title, find tasks sharing 2+ words.
    const words = task.title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
      .slice(0, 6);
    if (words.length === 0) return [];

    const candidates = await this.prisma.task.findMany({
      where: {
        projectId: task.projectId,
        id: { not: task.id },
        status: { notIn: ['Done', 'Approved'] },
        OR: words.map((w) => ({ title: { contains: w, mode: 'insensitive' as const } })),
      },
      take: 10,
      select: { id: true, title: true, status: true, keyNumber: true },
    });

    return candidates.map((c) => {
      const matched = words.filter((w) => c.title.toLowerCase().includes(w)).length;
      return {
        taskId: c.id,
        key: `${task.project.key}-${c.keyNumber}`,
        title: c.title,
        status: c.status,
        score: Math.min(0.99, matched / words.length),
      };
    });
  }

  // -------- Generate task description (sync) --------

  /**
   * Generate a longer description from a short task title. Saves users from staring
   * at a blank text area.
   */
  async expandTitleToDescription(actor: AuthenticatedUser, taskId: string): Promise<{ description: string }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { select: { id: true, name: true, workflowPreset: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');

    const descResult = await this.llm.generateWithUsage(
      `Project: ${task.project.name} (${task.project.workflowPreset})\n` +
      `Task title: ${task.title}\n` +
      (task.description ? `Current description (refine, don't replace):\n${task.description}\n\n` : '\n') +
      `Write a clear task description in markdown that includes:\n` +
      `- A 1-2 sentence "what" overview\n` +
      `- A bulleted acceptance criteria list (3-6 items)\n` +
      `- A small notes section if useful (otherwise omit)\n\n` +
      `Keep it tight. Don't add anything you can't infer.`,
      {
        systemPrompt: 'You are helping a teammate draft a task description. Be concrete and brief.',
        maxTokens: 600,
        temperature: 0.3,
      },
    );
    await this.costs?.record({
      kind: 'summarize',
      modelName: descResult.modelName,
      inputTokens: descResult.inputTokens,
      outputTokens: descResult.outputTokens,
      userId: actor.id,
    });
    return { description: descResult.text };
  }

  // -------- Auto-prioritization suggestion (sync) --------

  /**
   * Read a task's title + description and recommend a priority. Used as an
   * optional "✨ Suggest priority" chip in the task drawer.
   */
  async suggestPriority(actor: AuthenticatedUser, taskId: string): Promise<{ priority: 'Low' | 'Medium' | 'High' | 'Critical'; rationale: string }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        title: true,
        description: true,
        projectId: true,
        visibility: true,
        type: true,
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!(await this.permissions.canSeeTask(actor, task.projectId, task.visibility))) {
      throw new ForbiddenException('No access');
    }

    const prompt =
      `Task type: ${task.type}\nTask title: ${task.title}\n` +
      (task.description ? `Task description:\n${task.description}\n\n` : '\n') +
      `Recommend a priority — one of Low / Medium / High / Critical — based on impact and urgency. ` +
      `Respond as JSON only, no markdown: {"priority": "...", "rationale": "one sentence why"}.`;

    const prioResult = await this.llm.generateWithUsage(prompt, {
      systemPrompt: 'You are a senior engineering manager. Be decisive and brief.',
      maxTokens: 200,
      temperature: 0.1,
    });
    const raw = prioResult.text;
    await this.costs?.record({
      kind: 'prioritize',
      modelName: prioResult.modelName,
      inputTokens: prioResult.inputTokens,
      outputTokens: prioResult.outputTokens,
      userId: actor.id,
    });

    // Tolerant JSON parse — the LLM occasionally wraps in markdown despite the
    // instruction. Strip code fences before parsing.
    const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as { priority: string; rationale: string };
      const validPriorities = ['Low', 'Medium', 'High', 'Critical'] as const;
      const priority = (validPriorities as readonly string[]).includes(parsed.priority)
        ? (parsed.priority as 'Low' | 'Medium' | 'High' | 'Critical')
        : 'Medium';
      return {
        priority,
        rationale: (parsed.rationale ?? '').slice(0, 240),
      };
    } catch {
      // Fall back to keyword heuristic so the UI never sees an error from
      // a malformed model response.
      const text = `${task.title} ${task.description ?? ''}`.toLowerCase();
      if (/(critical|outage|prod down|security|breach|p0)/.test(text)) {
        return { priority: 'Critical', rationale: 'Heuristic match: critical keywords detected.' };
      }
      if (/(urgent|asap|important|p1|high)/.test(text)) {
        return { priority: 'High', rationale: 'Heuristic match: urgency keywords detected.' };
      }
      if (/(nice to have|backlog|cleanup|chore|p3|low)/.test(text)) {
        return { priority: 'Low', rationale: 'Heuristic match: low-urgency keywords detected.' };
      }
      return { priority: 'Medium', rationale: 'Default — no strong urgency or impact signal.' };
    }
  }

  // -------- Standup (sync) --------

  /**
   * Build a daily standup for the given user — "yesterday / today / blockers".
   * Uses the user's own task list + Event timeline as raw signal; the LLM
   * shapes the prose. The actor must be either the target user themselves or
   * an Admin / Manager.
   */
  async generateStandup(
    actor: AuthenticatedUser,
    userId: string,
    opts: { now?: Date } = {},
  ): Promise<{ markdown: string; raw: { completedYesterday: string[]; inProgressToday: string[]; blockers: string[] } }> {
    if (actor.id !== userId) {
      // Permissive: any internal user can read another internal user's
      // standup. Clients can never see standups.
      if (actor.kind !== 'internal') throw new ForbiddenException('Internal only');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, kind: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.kind !== 'internal') {
      throw new ForbiddenException('Standups are only available for internal users');
    }

    const now = opts.now ?? new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60_000);

    // Pull three buckets in parallel:
    //   - tasks the user moved to Done yesterday
    //   - tasks the user has in flight (assigned + not done)
    //   - blocked tasks where the user is assignee or reporter
    const [doneYesterday, inProgressNow, blocked] = await Promise.all([
      // Use the Event table: status_changed → Done events authored by this user
      // since yesterday's midnight. Joins back to the task for title/key.
      this.prisma.event.findMany({
        where: {
          actorUserId: userId,
          type: 'TaskStatusChanged',
          createdAt: { gte: startOfYesterday, lt: startOfToday },
        },
        select: {
          payload: true,
          entityId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
      this.prisma.task.findMany({
        where: {
          assigneeUserId: userId,
          status: { notIn: ['Done', 'Approved'] },
        },
        select: {
          id: true,
          keyNumber: true,
          title: true,
          status: true,
          priority: true,
          isBlocked: true,
          dueDate: true,
          project: { select: { key: true, name: true } },
        },
        orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
        take: 30,
      }),
      this.prisma.task.findMany({
        where: {
          isBlocked: true,
          status: { notIn: ['Done', 'Approved'] },
          OR: [{ assigneeUserId: userId }, { reporterUserId: userId }],
        },
        select: {
          id: true,
          keyNumber: true,
          title: true,
          blockedReason: true,
          project: { select: { key: true } },
        },
        take: 20,
      }),
    ]);

    // Resolve task titles for the yesterday-events bucket.
    const eventTaskIds = doneYesterday.map((e) => e.entityId);
    const eventTasks = eventTaskIds.length > 0
      ? await this.prisma.task.findMany({
          where: { id: { in: eventTaskIds } },
          select: { id: true, keyNumber: true, title: true, project: { select: { key: true } } },
        })
      : [];
    const taskById = new Map(eventTasks.map((t) => [t.id, t]));

    const completedYesterday = doneYesterday
      .filter((e) => {
        const p = e.payload as Record<string, unknown>;
        return p['toStatus'] === 'Done' || p['toStatus'] === 'Approved';
      })
      .map((e) => {
        const t = taskById.get(e.entityId);
        if (!t) return null;
        return `${t.project.key}-${t.keyNumber}: ${t.title}`;
      })
      .filter((s): s is string => Boolean(s));

    const inProgressToday = inProgressNow.map(
      (t) => `${t.project.key}-${t.keyNumber} [${t.status}, ${t.priority}]: ${t.title}` +
        (t.dueDate ? ` — due ${new Date(t.dueDate).toLocaleDateString()}` : ''),
    );

    const blockers = blocked.map(
      (t) => `${t.project.key}-${t.keyNumber}: ${t.title}` +
        (t.blockedReason ? ` — ${t.blockedReason}` : ''),
    );

    // If there's literally nothing to talk about, short-circuit without an
    // LLM call. Saves a few seconds and dollars.
    if (completedYesterday.length === 0 && inProgressToday.length === 0 && blockers.length === 0) {
      return {
        markdown: `# ${target.name}'s standup — ${startOfToday.toLocaleDateString()}\n\n_Nothing on the board for ${target.name} right now. Either fresh start or post-vacation._`,
        raw: { completedYesterday, inProgressToday, blockers },
      };
    }

    const prompt =
      `Generate a concise standup update for ${target.name} for ${startOfToday.toLocaleDateString()}. ` +
      `Use only the data below — never invent items.\n\n` +
      `Completed yesterday:\n${completedYesterday.length ? completedYesterday.map((l) => `- ${l}`).join('\n') : '- (nothing)'}\n\n` +
      `In flight today:\n${inProgressToday.length ? inProgressToday.map((l) => `- ${l}`).join('\n') : '- (nothing)'}\n\n` +
      `Blockers:\n${blockers.length ? blockers.map((l) => `- ${l}`).join('\n') : '- (none)'}\n\n` +
      `Output as markdown with three sections in this exact order: **Yesterday**, **Today**, **Blockers**. ` +
      `Each section is 2-6 short bullet points. Be terse, no fluff, no greetings. ` +
      `If a section has nothing, write a single dash with a brief note like "Nothing landed yesterday".`;

    const standupResult = await this.llm.generateWithUsage(prompt, {
      systemPrompt: 'You are writing concise daily standups for an engineering team. Be brief, factual, no fluff.',
      maxTokens: 500,
      temperature: 0.2,
    });
    await this.costs?.record({
      kind: 'standup',
      modelName: standupResult.modelName,
      inputTokens: standupResult.inputTokens,
      outputTokens: standupResult.outputTokens,
      userId: actor.id,
    });

    return {
      markdown: standupResult.text,
      raw: { completedYesterday, inProgressToday, blockers },
    };
  }
}
