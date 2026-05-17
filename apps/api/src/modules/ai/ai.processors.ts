import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { aiProcessorRuns } from '../../health/metrics.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCostTrackingService } from './ai-cost-tracking.service';
import {
  AI_BLOCKER_QUEUE, AI_DUPLICATE_QUEUE, AI_EMBED_QUEUE, AI_PRIORITIZE_QUEUE, AI_SUMMARIZE_QUEUE,
} from './ai.queues';
import { EmbeddingService } from './embedding.service';
import { LlmService } from './llm.service';
import { QdrantService } from './qdrant.service';
import { WorkspaceAiSettingsService } from './workspace-ai-settings.service';

// Wrap a processor body with success/failure metric emission. Throwing
// caller's error is preserved so BullMQ still retries per its policy.
async function withAiMetrics<T>(
  processor: 'embed' | 'duplicate' | 'blocker' | 'prioritize' | 'summarize',
  fn: () => Promise<{ skipped?: boolean } | void>,
): Promise<void> {
  try {
    const result = await fn();
    if (result && (result as { skipped?: boolean }).skipped) {
      aiProcessorRuns.inc({ processor, outcome: 'skip' });
    } else {
      aiProcessorRuns.inc({ processor, outcome: 'success' });
    }
  } catch (err) {
    aiProcessorRuns.inc({ processor, outcome: 'failure' });
    throw err;
  }
}

// =============================================================================
// Embedding worker — keeps each task's vector in Qdrant fresh.
// =============================================================================

@Processor(AI_EMBED_QUEUE)
export class EmbeddingProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbeddingProcessor.name);
  constructor(private readonly embeddings: EmbeddingService) {
    super();
  }
  async process(job: Job<{ taskId: string }>): Promise<void> {
    await withAiMetrics('embed', async () => {
      await this.embeddings.ensureFreshEmbedding(job.data.taskId);
    });
  }
}

// =============================================================================
// Duplicate detection — on new tasks, look for similar open tasks; if any score
// above the threshold, post an "AI suggests: possible duplicate of …" comment.
//
// The threshold is sourced from WorkspaceAiSettingsService.getDupThreshold(),
// which reads from the singleton settings row (cached 30s). This replaces the
// older `Env.AI_DUP_THRESHOLD` constant so admins can tune the value from the
// AI settings tab without an API restart.
// =============================================================================

// Structured reason envelope written into every AI auto-triage suggestion.
// Picked up by the UI (PriorityPicker AiWhyChip, future Task drawer dup card)
// so users see the explicit signals + evidence — not opaque LLM prose.
//
// Persistence:
//   - priority suggestions extend `Task.aiPriorityFactors` with the same
//     `signals: [{label,weight,evidence}], explanation: string` shape.
//   - duplicate-detection comments embed the JSON in a markdown
//     ```json:ai-suggestion``` fence inside the comment body so UI parsers
//     can extract it without a new Prisma column.
export interface AiSuggestionReason {
  signals: Array<{
    /** Short label shown in the UI's signals table column. */
    label: string;
    /** Weight contribution (0..n) — how much the signal moved the decision. */
    weight: number;
    /** Concrete evidence the signal fired on — a quoted phrase, a task key,
     *  a similarity %, etc. Renders next to the label as the "proof". */
    evidence: string;
  }>;
  /** One-sentence summary for tooltips + accessible labels. */
  explanation: string;
}

/** Encode a structured reason inside a markdown comment body. Picked up by
 *  the web UI via the `ai-suggestion` fence id. */
function fenceReason(reason: AiSuggestionReason): string {
  return '\n\n```json:ai-suggestion\n' + JSON.stringify(reason) + '\n```\n';
}

@Processor(AI_DUPLICATE_QUEUE)
export class DuplicateDetectionProcessor extends WorkerHost {
  private readonly logger = new Logger(DuplicateDetectionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
    private readonly llm: LlmService,
    private readonly qdrant: QdrantService,
    private readonly events: EventEmitter2,
    private readonly settings: WorkspaceAiSettingsService,
    private readonly costs: AiCostTrackingService,
  ) {
    super();
  }

  async process(job: Job<{ taskId: string }>): Promise<void> {
    // Feature gate — duplicateDetection toggle off → no-op.
    const ws = await this.settings.get().catch(() => null);
    if (ws && !readFeatureFlag(ws.settings, 'duplicateDetection')) return;

    const task = await this.prisma.task.findUnique({
      where: { id: job.data.taskId },
      include: { project: { select: { key: true } } },
    });
    if (!task) return;
    await this.embeddings.ensureFreshEmbedding(task.id);
    const embedInputChars = task.title.length + (task.description?.length ?? 0);
    const vector = await this.llm.embed(`${task.title}\n\n${task.description ?? ''}`);
    // Record the embedding call against the workspace usage telemetry. We
    // don't have a tokenized count from Ollama; estimate at ~4 chars/token,
    // same heuristic LlmService uses. Costs to ~0 because nomic-embed-text
    // is local — but volume still shows in the dashboard sparkline.
    await this.costs.record({
      kind: 'duplicate',
      modelName: 'nomic-embed-text',
      inputTokens: Math.ceil(embedInputChars / 4),
      outputTokens: 0,
    });
    const hits = await this.qdrant.searchSimilar(vector, {
      limit: 5,
      projectId: task.projectId,
      excludeTaskId: task.id,
    });
    const dupThreshold = await this.settings.getDupThreshold();
    const candidates = hits.filter((h) => h.score >= dupThreshold && (h.payload['status'] as string) !== 'Done');
    if (candidates.length === 0) return;

    // Build the structured reason BEFORE rendering the comment so UI parsers
    // get the same set of signals the human-readable list shows.
    const reason: AiSuggestionReason = {
      explanation:
        `Found ${candidates.length} similar open task${candidates.length === 1 ? '' : 's'} ` +
        `at or above the ${(dupThreshold * 100).toFixed(0)}% similarity threshold.`,
      signals: candidates.map((c) => ({
        label: `Similar to ${task.project.key}-${(c.payload['key'] as string) ?? c.id}`,
        weight: c.score,
        evidence: `"${c.payload['title']}" — ${(c.score * 100).toFixed(0)}% match`,
      })),
    };

    const body =
      `🤖 **Possible duplicate.** Similar open tasks:\n\n` +
      candidates
        .map((c) => `- ${task.project.key}-${(c.payload['key'] as string) ?? c.id} — _${c.payload['title']}_ (similarity ${(c.score * 100).toFixed(0)}%)`)
        .join('\n') +
      fenceReason(reason);

    const system = await this.prisma.user.findFirst({
      where: { kind: 'internal', companyRole: 'Admin', archivedAt: null }, select: { id: true },
    });
    if (!system) return;
    await this.prisma.comment.create({
      data: {
        taskId: task.id,
        authorUserId: system.id,
        bodyMd: body,
        visibility: 'internal',
        editLockedAt: new Date(),
      },
    });
    this.events.emit('comment.added', {
      commentId: 'ai-dup', taskId: task.id, authorUserId: system.id,
      visibility: 'internal', mentions: { userIds: [], teamIds: [] },
      bodyPreview: 'AI: possible duplicate', isInternal: true,
    });
  }
}

/** Read a feature flag out of WorkspaceAiSettings.settings JSON. Default ON. */
function readFeatureFlag(settings: unknown, key: string): boolean {
  if (!settings || typeof settings !== 'object') return true;
  const features = (settings as Record<string, unknown>)['features'];
  if (!features || typeof features !== 'object') return true;
  const v = (features as Record<string, unknown>)[key];
  return v !== false;
}

// =============================================================================
// Summarize worker — sprint summaries and PR summaries.
// =============================================================================

interface SummarizeSprintJob { kind: 'sprint'; sprintId: string }
interface SummarizePRJob {     kind: 'pr';     taskId: string; prTitle: string; prBody: string | null; prUrl: string }
type SummarizeJob = SummarizeSprintJob | SummarizePRJob;

@Processor(AI_SUMMARIZE_QUEUE)
export class SummarizeProcessor extends WorkerHost {
  private readonly logger = new Logger(SummarizeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly events: EventEmitter2,
    private readonly costs: AiCostTrackingService,
  ) {
    super();
  }

  async process(job: Job<SummarizeJob>): Promise<void> {
    if (job.data.kind === 'sprint') {
      await this.summarizeSprint(job.data.sprintId);
    } else {
      await this.summarizePR(job.data);
    }
  }

  private async summarizeSprint(sprintId: string): Promise<void> {
    const sprint = await this.prisma.sprint.findUnique({
      where: { id: sprintId },
      include: {
        tasks: {
          select: { keyNumber: true, title: true, status: true, priority: true, isBlocked: true },
        },
        project: { select: { key: true, name: true } },
      },
    });
    if (!sprint) return;
    const tasksList = sprint.tasks
      .map((t) => `- ${sprint.project.key}-${t.keyNumber} [${t.status}${t.isBlocked ? ', blocked' : ''}] (${t.priority}): ${t.title}`)
      .join('\n');
    const sprintPrompt =
      `Summarize the following completed sprint for ${sprint.project.name}.\n\n` +
      `Sprint: ${sprint.name}\nTasks:\n${tasksList}\n\n` +
      `Produce: (1) one-paragraph executive summary, (2) highlights, (3) what slipped, (4) blockers.`;
    const sprintResult = await this.llm.generateWithUsage(sprintPrompt, {
      systemPrompt: 'You are an engineering manager writing a sprint retrospective. Be terse, factual, and actionable.',
      maxTokens: 800,
    });
    const summary = sprintResult.text;
    await this.costs.record({
      kind: 'summarize',
      modelName: sprintResult.modelName,
      inputTokens: sprintResult.inputTokens,
      outputTokens: sprintResult.outputTokens,
    });
    this.events.emit('ai.sprint_summary_generated', { sprintId, projectId: sprint.projectId, summary });
  }

  private async summarizePR(job: SummarizePRJob): Promise<void> {
    const prPrompt =
      `Summarize this merged pull request for the team:\n\n` +
      `Title: ${job.prTitle}\n` +
      (job.prBody ? `Description:\n${job.prBody}\n\n` : '') +
      `Produce 2-4 bullet points capturing what shipped and any noteworthy risks.`;
    const prResult = await this.llm.generateWithUsage(prPrompt, {
      systemPrompt: 'You are summarizing code-review-quality PRs for non-author engineers. Be terse and factual.',
      maxTokens: 300,
    });
    const summary = prResult.text;
    await this.costs.record({
      kind: 'summarize',
      modelName: prResult.modelName,
      inputTokens: prResult.inputTokens,
      outputTokens: prResult.outputTokens,
    });
    const system = await this.prisma.user.findFirst({
      where: { kind: 'internal', companyRole: 'Admin', archivedAt: null }, select: { id: true },
    });
    if (!system) return;
    await this.prisma.comment.create({
      data: {
        taskId: job.taskId,
        authorUserId: system.id,
        bodyMd: `🤖 **PR Summary** — ${job.prUrl}\n\n${summary}`,
        visibility: 'internal',
        editLockedAt: new Date(),
      },
    });
  }
}

// =============================================================================
// Blocker prediction — nightly scan of long-running In Progress tasks.
// =============================================================================

@Processor(AI_BLOCKER_QUEUE)
export class BlockerPredictionProcessor extends WorkerHost {
  private readonly logger = new Logger(BlockerPredictionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stale = await this.prisma.task.findMany({
      where: { status: 'In Progress', isBlocked: false, updatedAt: { lt: cutoff } },
      select: {
        id: true, projectId: true, title: true, keyNumber: true,
        assigneeUserId: true, reporterUserId: true,
      },
      take: 200,
    });
    const reason = 'In Progress >7 days without updates';
    const now = new Date();
    for (const task of stale) {
      // Persist the prediction on the task so the UI can surface a badge
      // without hitting the AI worker on every page load.
      await this.prisma.task.update({
        where: { id: task.id },
        data: { aiRiskReason: reason, aiRiskPredictedAt: now },
      }).catch(() => undefined);

      // Notify the people most likely to act on it: assignee + reporter.
      const recipientIds = new Set<string>();
      if (task.assigneeUserId) recipientIds.add(task.assigneeUserId);
      recipientIds.add(task.reporterUserId);
      for (const userId of recipientIds) {
        await this.prisma.notification.create({
          data: {
            recipientUserId: userId,
            type: 'AiBlockerPredicted',
            payload: { taskId: task.id, reason },
            relatedTaskId: task.id,
            relatedProjectId: task.projectId,
          },
        }).catch(() => undefined);
      }

      this.events.emit('ai.blocker_predicted', {
        taskId: task.id, projectId: task.projectId, reason,
      });
    }
  }
}

// =============================================================================
// Auto-prioritization — runs on task.created when the user didn't override
// the default Medium priority. Reads title + description, asks the LLM for
// a recommendation, and updates the task if the suggestion differs.
//
// Why on task.created (and not status change): priority is most useful at the
// moment of triage. Re-evaluating later would fight the team's own judgement
// and pollute the activity timeline. The processor is idempotent — if the
// task no longer has the default priority by the time we run (e.g. the user
// edited it within seconds), the job is a no-op.
// =============================================================================

interface PriorityFactor {
  /** Human-readable factor name surfaced in the drawer tooltip table. */
  name: string;
  /** Weight from WorkspaceAiSettings.priorityWeights (or default 1). */
  weight: number;
  /** Raw signal value 0..1 (e.g. "0.8 = strong deadline match"). */
  value: number;
  /** weight * value — sortable contribution toward the final score. */
  contribution: number;
}

@Processor(AI_PRIORITIZE_QUEUE)
export class PrioritizeProcessor extends WorkerHost {
  private readonly logger = new Logger(PrioritizeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly events: EventEmitter2,
    private readonly settings: WorkspaceAiSettingsService,
    private readonly costs: AiCostTrackingService,
  ) {
    super();
  }

  async process(job: Job<{ taskId: string }>): Promise<void> {
    const { taskId } = job.data;
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        projectId: true,
        type: true,
        aiPriorityReason: true,
      },
    });
    if (!task) return;

    // Idempotency guard: only act when the priority is still the default and
    // we haven't already written a rationale (so re-queueing the same task
    // doesn't keep overwriting it).
    if (task.priority !== 'Medium' || task.aiPriorityReason) return;

    // Skip empty tasks — no signal to work with.
    const text = `${task.title} ${task.description ?? ''}`.trim();
    if (text.length < 8) return;

    const prompt =
      `Task type: ${task.type}\nTask title: ${task.title}\n` +
      (task.description ? `Task description:\n${task.description}\n\n` : '\n') +
      `Recommend a priority — one of Low / Medium / High / Critical — based on impact and urgency. ` +
      `Respond as JSON only, no markdown: {"priority": "...", "rationale": "one sentence why"}.`;

    let suggested: 'Low' | 'Medium' | 'High' | 'Critical' = 'Medium';
    let rationale = '';
    let usedFallback = true;
    try {
      const result = await this.llm.generateWithUsage(prompt, {
        systemPrompt: 'You are a senior engineering manager. Be decisive and brief.',
        maxTokens: 200,
        temperature: 0.1,
      });
      await this.costs.record({
        kind: 'prioritize',
        modelName: result.modelName,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      const cleaned = result.text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned) as { priority: string; rationale: string };
      const valid = ['Low', 'Medium', 'High', 'Critical'] as const;
      if ((valid as readonly string[]).includes(parsed.priority)) {
        suggested = parsed.priority as typeof suggested;
      }
      rationale = (parsed.rationale ?? '').slice(0, 240);
      usedFallback = false;
    } catch {
      // Keyword heuristic fallback — same logic as the sync version of
      // suggestPriority. Better a heuristic than a missed signal.
      const lower = text.toLowerCase();
      if (/(critical|outage|prod down|security|breach|p0)/.test(lower)) {
        suggested = 'Critical';
        rationale = 'Heuristic match: critical keywords detected.';
      } else if (/(urgent|asap|important|p1|high)/.test(lower)) {
        suggested = 'High';
        rationale = 'Heuristic match: urgency keywords detected.';
      } else if (/(nice to have|backlog|cleanup|chore|p3|low)/.test(lower)) {
        suggested = 'Low';
        rationale = 'Heuristic match: low-urgency keywords detected.';
      } else {
        // No signal — record the no-op rationale so we don't re-queue.
        await this.prisma.task.update({
          where: { id: task.id },
          data: {
            aiPriorityReason: 'AI: no strong urgency or impact signal — left at Medium.',
            aiTriageExplanation:
              'No strong urgency or impact signal in the task text. The auto-triage pass left the priority at the default Medium and did not adjust the assignment.',
          },
        }).catch(() => undefined);
        return;
      }
    }

    // Re-fetch in case the user edited the task while the LLM was thinking.
    const current = await this.prisma.task.findUnique({
      where: { id: task.id },
      select: { priority: true, aiPriorityReason: true },
    });
    if (!current || current.priority !== 'Medium' || current.aiPriorityReason) return;

    // Build the structured factor breakdown the drawer renders. Pulls the
    // current weights from the workspace AI settings; missing keys fall back
    // to weight=1. The `value` per factor is a coarse keyword signal — good
    // enough to explain WHY the LLM landed where it did without re-asking
    // the model for a second pass.
    const factors = await this.buildFactors(text, suggested);

    // 2-3 sentence triage explanation rendered in the AiWhyChip popover
    // alongside the factor table. Cites the same signals the table shows so a
    // reader can audit the AI's reasoning without re-running the call.
    const triageExplanation = buildTriageExplanation({
      title: task.title,
      suggested,
      rationale,
      usedFallback,
      factors,
    });

    await this.prisma.task.update({
      where: { id: task.id },
      data: {
        priority: suggested,
        aiPriorityReason: rationale || `AI suggestion: ${suggested}`,
        // PriorityFactor[] is structurally JSON-compatible but lacks the
        // string index signature Prisma's InputJsonValue requires.
        aiPriorityFactors: factors as unknown as Prisma.InputJsonValue,
        aiTriageExplanation: triageExplanation,
      },
    });

    // Fire an event so the timeline + realtime broadcast pick up the change.
    this.events.emit('task.priority_suggested', {
      taskId: task.id,
      projectId: task.projectId,
      priority: suggested,
      rationale,
    });

    this.logger.log(`Auto-prioritized ${task.id} → ${suggested}`);
  }

  /**
   * Build the structured per-factor breakdown stored on the task and surfaced
   * in the AI · why? tooltip. Keyword-derived signals; weights come from the
   * workspace AI settings.
   */
  private async buildFactors(text: string, suggested: string): Promise<PriorityFactor[]> {
    const lower = text.toLowerCase();
    const weights = ((await this.settings.get()).priorityWeights ?? {}) as Record<string, number>;
    const deadlineW = numberOr(weights['deadline'], 1);
    const blockedW = numberOr(weights['blocked'], 2);
    const customerW = numberOr(weights['customerImpact'], 1.5);

    const deadlineSignal = /(deadline|due|by friday|by monday|tomorrow|today|asap|urgent)/.test(lower) ? 1 : 0;
    const blockedSignal  = /(blocked|blocker|cannot proceed|waiting on)/.test(lower) ? 1 : 0;
    const customerSignal = /(customer|client|user impact|outage|production)/.test(lower) ? 1 : 0;

    const factors: PriorityFactor[] = [
      { name: 'Deadline urgency', weight: deadlineW, value: deadlineSignal, contribution: deadlineW * deadlineSignal },
      { name: 'Blockers',         weight: blockedW,  value: blockedSignal,  contribution: blockedW  * blockedSignal  },
      { name: 'Customer impact',  weight: customerW, value: customerSignal, contribution: customerW * customerSignal },
      // Final-decision row gives the reader the score's right-hand side.
      { name: `Resolved priority: ${suggested}`, weight: 0, value: 0, contribution: 0 },
    ];
    return factors;
  }
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Build the 2-3 sentence triage explanation surfaced in the AiWhyChip popover.
 *
 * Composition:
 *   - Sentence 1: state the AI's call ("Auto-triaged to High based on ...").
 *   - Sentence 2: cite the factors that actually fired (deadline / blockers /
 *     customer impact). If none, fall back to the LLM's own rationale.
 *   - Sentence 3 (optional): note when the heuristic fallback was used so a
 *     reader knows the LLM was bypassed — keeps audit trail honest.
 *
 * Kept out of the LLM prompt on purpose: the structured factors table already
 * carries the data; this string just renders it in prose for users who don't
 * read tables.
 */
function buildTriageExplanation(args: {
  title: string;
  suggested: string;
  rationale: string;
  usedFallback: boolean;
  factors: PriorityFactor[];
}): string {
  const fired = args.factors
    .filter((f) => f.value > 0 && f.contribution > 0)
    .map((f) => f.name.toLowerCase());

  const lead = `Auto-triaged to ${args.suggested} priority based on the task title and description.`;

  let evidence: string;
  if (fired.length > 0) {
    const joined = fired.length === 1
      ? fired[0]
      : fired.slice(0, -1).join(', ') + ' and ' + fired[fired.length - 1];
    evidence = `Signals that fired: ${joined}.`;
  } else if (args.rationale) {
    evidence = `Model rationale: ${args.rationale.replace(/\.+$/, '')}.`;
  } else {
    evidence = `No structured signals fired; the model raised priority on overall task wording.`;
  }

  const provenance = args.usedFallback
    ? ' Used the heuristic fallback because the model response could not be parsed.'
    : '';

  return `${lead} ${evidence}${provenance}`.trim();
}
