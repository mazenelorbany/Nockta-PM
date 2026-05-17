import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Env } from '../../config/env';
import { AiCostTrackingService } from './ai-cost-tracking.service';
import { LlmService } from './llm.service';
import { WorkspaceAiSettingsService } from './workspace-ai-settings.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// AiStandupService — the "structured standup with quoted comments" feature.
//
// Difference from AiSyncService.generateStandup (which emits a free-text
// markdown blob):
//   - synthesize() returns a STRUCTURED { did, doing, blockers } shape where
//     every bullet carries its `sourceIds` (commentId / taskId citations).
//     UI can render each bullet with a "see source" affordance.
//   - The LLM is asked to ONLY use the labelled snippets we feed it, and to
//     attach the snippet's [tag] in its output. We then parse the tags back
//     out into structured citations — never trusting the LLM to repeat the
//     exact source text.
//
// The implementation is deliberately defensive: the LLM might hallucinate a
// tag or drop one. We:
//   1. Build the snippet table with stable [c1], [c2], [t1] tags.
//   2. After the LLM responds, scan each line for [tag] occurrences and
//      attach the SUBSET of `sourceIds` we know are real.
//   3. Bullets with zero recognised tags get an empty `sourceIds: []` — the
//      UI shows them as "ungrounded" so the human can still take action.
// =============================================================================

export interface StandupLine {
  /** The bullet text the LLM produced (without inline [tag] markers). */
  line: string;
  /** Comment IDs or Task IDs that grounded this line. Empty when the LLM
   *  didn't cite anything we recognised — UI displays a warning chip. */
  sourceIds: string[];
}

export interface StandupResult {
  did: StandupLine[];
  doing: StandupLine[];
  blockers: StandupLine[];
  /** Generation cost in USD cents — surfaced in the response so the client
   *  can show "0.4¢ this synthesis" without a second usage-summary call. */
  costUsdCents: number;
}

interface SnippetRow {
  /** Stable in-prompt tag, e.g. `c1`, `t3`. */
  tag: string;
  /** Real source identifier (commentId or taskId) the tag resolves back to. */
  sourceId: string;
  /** Short text shown to the LLM as the snippet body. */
  body: string;
  /** Free-form bucket hint (`did` / `doing` / `blockers`) used to bias the
   *  LLM toward the right section. */
  kind: 'did' | 'doing' | 'blockers';
}

@Injectable()
export class AiStandupService {
  private readonly logger = new Logger(AiStandupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly settings: WorkspaceAiSettingsService,
    private readonly costs: AiCostTrackingService,
  ) {}

  /**
   * Build a structured standup for `userId` over [since, until). `actor` can
   * be the user themselves or any internal user — clients are forbidden.
   *
   * Pulls three buckets in parallel:
   *   - completed tasks (TaskStatusChanged → Done in the window)
   *   - in-flight tasks (assignee=user, not Done)
   *   - the user's own comments in the window (richest source of context)
   *   - blocked tasks where the user is assignee or reporter
   *
   * If autosuggest is off OR the standup-synthesis feature toggle is off in
   * WorkspaceAiSettings, we short-circuit and return a "feature disabled"
   * empty result rather than blow up the caller.
   */
  async synthesize(
    actor: AuthenticatedUser,
    userId: string,
    since: Date,
    until: Date,
  ): Promise<StandupResult> {
    if (actor.id !== userId && actor.kind !== 'internal') {
      throw new ForbiddenException('Internal only');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, kind: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.kind !== 'internal') {
      throw new ForbiddenException('Standups are only available for internal users');
    }

    const ws = await this.settings.get();
    const featureOn = readFeatureFlag(ws.settings, 'standupSynthesis');
    if (!ws.autoSuggestEnabled || !featureOn) {
      return { did: [], doing: [], blockers: [], costUsdCents: 0 };
    }

    // Budget gate — short-circuit if month-to-date spend on this kind has
    // already exceeded the configured cap.
    const budgetCents = readBudgetCents(ws.settings, 'standup');
    if (budgetCents !== null) {
      const spent = await this.costs.currentMonthSpendCents('standup');
      if (spent >= budgetCents) {
        await this.costs.record({
          kind: 'standup',
          modelName: this.modelName(),
          inputTokens: 0,
          outputTokens: 0,
          status: 'budget_exceeded',
          userId,
        });
        return { did: [], doing: [], blockers: [], costUsdCents: 0 };
      }
    }

    const [completedEvents, inProgressTasks, recentComments, blockedTasks] = await Promise.all([
      this.prisma.event.findMany({
        where: {
          actorUserId: userId,
          type: 'TaskStatusChanged',
          createdAt: { gte: since, lt: until },
        },
        select: { entityId: true, payload: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
      this.prisma.task.findMany({
        where: {
          assigneeUserId: userId,
          status: { notIn: ['Done', 'Approved'] },
        },
        select: {
          id: true, keyNumber: true, title: true, status: true, isBlocked: true,
          project: { select: { key: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      }),
      this.prisma.comment.findMany({
        where: {
          authorUserId: userId,
          createdAt: { gte: since, lt: until },
          deletedAt: null,
        },
        select: {
          id: true, bodyMd: true, taskId: true, createdAt: true,
          task: { select: { keyNumber: true, project: { select: { key: true } } } },
        },
        orderBy: { createdAt: 'asc' },
        take: 40,
      }),
      this.prisma.task.findMany({
        where: {
          isBlocked: true,
          status: { notIn: ['Done', 'Approved'] },
          OR: [{ assigneeUserId: userId }, { reporterUserId: userId }],
        },
        select: {
          id: true, keyNumber: true, title: true, blockedReason: true,
          project: { select: { key: true } },
        },
        take: 10,
      }),
    ]);

    // Resolve titles for the "did" bucket events.
    const doneTaskIds = completedEvents
      .filter((e) => {
        const p = e.payload as Record<string, unknown>;
        return p['toStatus'] === 'Done' || p['toStatus'] === 'Approved';
      })
      .map((e) => e.entityId);
    const doneTasks = doneTaskIds.length > 0
      ? await this.prisma.task.findMany({
          where: { id: { in: doneTaskIds } },
          select: { id: true, keyNumber: true, title: true, project: { select: { key: true } } },
        })
      : [];
    const taskById = new Map(doneTasks.map((t) => [t.id, t]));

    // Build the snippet table with stable in-prompt tags. The LLM is asked to
    // echo each tag in the bullet that uses it; we parse them back out below.
    const snippets: SnippetRow[] = [];
    let dIdx = 1;
    let cIdx = 1;
    let pIdx = 1;
    let bIdx = 1;
    for (const tid of doneTaskIds) {
      const t = taskById.get(tid);
      if (!t) continue;
      snippets.push({
        tag: `d${dIdx++}`,
        sourceId: t.id,
        kind: 'did',
        body: `${t.project.key}-${t.keyNumber}: ${t.title}`,
      });
    }
    for (const c of recentComments) {
      snippets.push({
        tag: `c${cIdx++}`,
        sourceId: c.id,
        kind: 'did',
        body:
          (c.task ? `[${c.task.project.key}-${c.task.keyNumber}] ` : '') +
          truncate(c.bodyMd, 220),
      });
    }
    for (const t of inProgressTasks) {
      snippets.push({
        tag: `p${pIdx++}`,
        sourceId: t.id,
        kind: 'doing',
        body: `${t.project.key}-${t.keyNumber} [${t.status}]: ${t.title}`,
      });
    }
    for (const t of blockedTasks) {
      snippets.push({
        tag: `b${bIdx++}`,
        sourceId: t.id,
        kind: 'blockers',
        body: `${t.project.key}-${t.keyNumber}: ${t.title}` +
          (t.blockedReason ? ` — ${t.blockedReason}` : ''),
      });
    }

    if (snippets.length === 0) {
      return { did: [], doing: [], blockers: [], costUsdCents: 0 };
    }

    const tagIndex = new Map(snippets.map((s) => [s.tag, s.sourceId] as const));
    const promptSnippets = snippets
      .map((s) => `[${s.tag}] (${s.kind}) ${s.body}`)
      .join('\n');

    const prompt =
      `You are synthesising a daily standup for ${target.name}. Use ONLY the snippets ` +
      `below. Each snippet has a tag like [c1] or [t3]. When you produce a bullet, ` +
      `append the tag(s) the bullet is drawn from in square brackets at the END of the ` +
      `bullet, e.g. "Fixed the login flow [c2]". Never invent items not in the snippets.\n\n` +
      `Snippets:\n${promptSnippets}\n\n` +
      `Output JSON ONLY, no markdown, in this exact shape:\n` +
      `{"did":["...","..."], "doing":["...","..."], "blockers":["...","..."]}\n` +
      `Each section is 0-5 short bullets. If a section has nothing, return [].`;

    const result = await this.llm.generateWithUsage(prompt, {
      systemPrompt: 'You are an engineering manager writing concise standups. Be terse and factual; never invent items.',
      maxTokens: 700,
      temperature: 0.2,
    });

    const cost = this.costs.computeCostCents(
      result.modelName,
      result.inputTokens,
      result.outputTokens,
    );
    await this.costs.record({
      kind: 'standup',
      modelName: result.modelName,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      userId,
    });

    return { ...this.parseLlmJson(result.text, tagIndex), costUsdCents: cost };
  }

  /** Strip markdown fences and parse the JSON, then attribute citations. Tolerant
   *  of trailing prose — we extract the first {...} block. */
  private parseLlmJson(
    raw: string,
    tagIndex: Map<string, string>,
  ): Omit<StandupResult, 'costUsdCents'> {
    const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      this.logger.warn('Standup LLM response had no JSON block; returning empty.');
      return { did: [], doing: [], blockers: [] };
    }
    let parsed: { did?: string[]; doing?: string[]; blockers?: string[] };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      this.logger.warn('Standup LLM response failed to parse; returning empty.');
      return { did: [], doing: [], blockers: [] };
    }
    return {
      did: (parsed.did ?? []).map((l) => citationLine(l, tagIndex)),
      doing: (parsed.doing ?? []).map((l) => citationLine(l, tagIndex)),
      blockers: (parsed.blockers ?? []).map((l) => citationLine(l, tagIndex)),
    };
  }

  /** Effective model name for cost-tracking. Mirrors LlmService.resolveProvider
   *  but without a DB round trip — we only need the *name*. */
  private modelName(): string {
    return Env.LLM_PROVIDER === 'anthropic' ? Env.ANTHROPIC_MODEL : Env.OLLAMA_MODEL;
  }
}

/** Extract every [tag] in the line, look each up in the index, and return the
 *  resolved source ids along with the cleaned line (tags removed). Unknown
 *  tags are silently dropped — the LLM occasionally hallucinates one. */
function citationLine(line: string, tagIndex: Map<string, string>): StandupLine {
  const tagPattern = /\[([a-z]\d{1,3})\]/g;
  const sourceIds: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagPattern.exec(line)) !== null) {
    const id = tagIndex.get(m[1]!);
    if (id && !sourceIds.includes(id)) sourceIds.push(id);
  }
  const cleaned = line.replace(tagPattern, '').replace(/\s+/g, ' ').trim();
  return { line: cleaned, sourceIds };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function readFeatureFlag(settings: unknown, key: string): boolean {
  if (!settings || typeof settings !== 'object') return true;
  const features = (settings as Record<string, unknown>)['features'];
  if (!features || typeof features !== 'object') return true;
  const v = (features as Record<string, unknown>)[key];
  return v !== false; // default true when missing
}

function readBudgetCents(settings: unknown, kind: string): number | null {
  if (!settings || typeof settings !== 'object') return null;
  const budgets = (settings as Record<string, unknown>)['monthlyBudgetUsdCents'];
  if (!budgets || typeof budgets !== 'object') return null;
  const v = (budgets as Record<string, unknown>)[kind];
  if (typeof v === 'number' && v > 0) return v;
  return null;
}
