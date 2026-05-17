import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import {
  BlockerPredictionProcessor,
  DuplicateDetectionProcessor,
  PrioritizeProcessor,
} from './ai.processors';
import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AiCostTrackingService } from './ai-cost-tracking.service';
import type { EmbeddingService } from './embedding.service';
import type { LlmService } from './llm.service';
import type { QdrantService } from './qdrant.service';
import type { WorkspaceAiSettingsService } from './workspace-ai-settings.service';

// Build a minimal AiCostTrackingService stand-in shared by every processor
// test. Cost rows are write-only side effects from the processor's POV — we
// don't read them back, just assert they were attempted with the right kind.
function makeCostsMock() {
  const record = vi.fn().mockResolvedValue(undefined);
  return {
    instance: { record } as unknown as AiCostTrackingService,
    record,
  };
}

// Fixed threshold used by the dup-detection tests below. Mirrors the schema
// default; the actual value is read at runtime via WorkspaceAiSettingsService
// (mocked here to return this constant).
const DUP_THRESHOLD = 0.85;

// ai.processors — three queue workers that quietly mutate state on behalf of
// the user. We pin the preconditions under which each processor WILL write
// and the ones under which it MUST NOT. Queue-side deps (LLM/Embed/Qdrant)
// are hand-rolled vi.fn() bags cast via `as unknown as <Service>`.

function job<T>(data: T): Job<T> {
  return { data } as unknown as Job<T>;
}

// =============================================================================
// DuplicateDetectionProcessor
// =============================================================================

interface DupMocks {
  prisma: PrismaService;
  embeddings: { ensureFreshEmbedding: ReturnType<typeof vi.fn> };
  llm: { embed: ReturnType<typeof vi.fn> };
  qdrant: { searchSimilar: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
  settings: { get: ReturnType<typeof vi.fn>; getDupThreshold: ReturnType<typeof vi.fn> };
  costs: ReturnType<typeof makeCostsMock>;
}

function buildDup(): { processor: DuplicateDetectionProcessor; mocks: DupMocks } {
  const prisma = makePrismaMock();
  const embeddings = { ensureFreshEmbedding: vi.fn().mockResolvedValue(undefined) };
  const llm = { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) };
  const qdrant = { searchSimilar: vi.fn() };
  const events = makeEventsMock();
  const settings = {
    // DuplicateDetectionProcessor reads workspaceAiSettings.get() to check the
    // duplicateDetection feature flag before running. Default to feature ON.
    get: vi.fn().mockResolvedValue({ settings: { features: { duplicateDetection: true } } }),
    getDupThreshold: vi.fn().mockResolvedValue(DUP_THRESHOLD),
  };
  const costs = makeCostsMock();
  const processor = new DuplicateDetectionProcessor(
    prisma,
    embeddings as unknown as EmbeddingService,
    llm as unknown as LlmService,
    qdrant as unknown as QdrantService,
    events.instance,
    settings as unknown as WorkspaceAiSettingsService,
    costs.instance,
  );
  return { processor, mocks: { prisma, embeddings, llm, qdrant, events, settings, costs } };
}

describe('DuplicateDetectionProcessor', () => {
  let mocks: DupMocks;
  let processor: DuplicateDetectionProcessor;

  beforeEach(() => {
    ({ processor, mocks } = buildDup());
  });

  function stubTask() {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-new', projectId: 'p1', title: 'login broken', description: 'still cannot log in',
      project: { key: 'PRJ' },
    } as never);
  }

  it('skips entirely when the source task no longer exists', async () => {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce(null);
    await processor.process(job({ taskId: 't-missing' }));
    expect(mocks.qdrant.searchSimilar).not.toHaveBeenCalled();
    expect(mocks.prisma.comment.create).not.toHaveBeenCalled();
  });

  it('does not post a comment when all candidates are below the workspace threshold', async () => {
    stubTask();
    mocks.qdrant.searchSimilar.mockResolvedValueOnce([
      { id: 'c-1', score: DUP_THRESHOLD - 0.01, payload: { status: 'Todo', title: 'similar', key: '12' } },
    ]);
    await processor.process(job({ taskId: 't-new' }));
    expect(mocks.prisma.comment.create).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });

  it('drops candidates whose status is Done even when score is above threshold', async () => {
    stubTask();
    mocks.qdrant.searchSimilar.mockResolvedValueOnce([
      { id: 'c-done', score: 0.99, payload: { status: 'Done', title: 'fixed', key: '9' } },
    ]);
    await processor.process(job({ taskId: 't-new' }));
    expect(mocks.prisma.comment.create).not.toHaveBeenCalled();
  });

  it('posts an AI duplicate comment for above-threshold AND non-Done candidates', async () => {
    stubTask();
    mocks.qdrant.searchSimilar.mockResolvedValueOnce([
      { id: 'c-hit', score: 0.92, payload: { status: 'In Progress', title: 'cant log in', key: '11' } },
      { id: 'c-done', score: 0.99, payload: { status: 'Done', title: 'fixed', key: '5' } },
    ]);
    vi.mocked(mocks.prisma.user.findFirst).mockResolvedValueOnce({ id: 'system-admin' } as never);
    vi.mocked(mocks.prisma.comment.create).mockResolvedValueOnce({ id: 'ai-comment' } as never);

    await processor.process(job({ taskId: 't-new' }));

    const args = vi.mocked(mocks.prisma.comment.create).mock.calls[0]?.[0];
    expect(args?.data?.taskId).toBe('t-new');
    expect(args?.data?.visibility).toBe('internal');
    expect(String(args?.data?.bodyMd)).toContain('cant log in');
    expect(String(args?.data?.bodyMd)).not.toContain('fixed');
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'comment.added', expect.objectContaining({ taskId: 't-new' }),
    );
  });
});

// =============================================================================
// PrioritizeProcessor
// =============================================================================

interface PrioMocks {
  prisma: PrismaService;
  llm: { generate: ReturnType<typeof vi.fn>; generateWithUsage: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
  settings: { get: ReturnType<typeof vi.fn>; getDupThreshold: ReturnType<typeof vi.fn> };
  costs: ReturnType<typeof makeCostsMock>;
}

function buildPrio(): { processor: PrioritizeProcessor; mocks: PrioMocks } {
  const prisma = makePrismaMock();
  // Processor now uses generateWithUsage so cost telemetry is attributable;
  // we keep `generate` as a fallback fn so existing tests that stub it still
  // route through a wrapper that emits the new shape.
  const generateWithUsage = vi.fn();
  const generate = vi.fn().mockImplementation(async (...args: unknown[]) => {
    const result = await generateWithUsage(...args);
    return typeof result === 'string' ? result : result?.text;
  });
  const llm = { generate, generateWithUsage };
  const events = makeEventsMock();
  const settings = {
    get: vi.fn().mockResolvedValue({
      priorityWeights: { deadline: 1, blocked: 2, customerImpact: 1.5 },
    }),
    getDupThreshold: vi.fn().mockResolvedValue(DUP_THRESHOLD),
  };
  const costs = makeCostsMock();
  const processor = new PrioritizeProcessor(
    prisma,
    llm as unknown as LlmService,
    events.instance,
    settings as unknown as WorkspaceAiSettingsService,
    costs.instance,
  );
  return { processor, mocks: { prisma, llm, events, settings, costs } };
}

function stubMediumTask(prisma: PrismaService, title: string, description: string | null = null) {
  vi.mocked(prisma.task.findUnique).mockResolvedValueOnce({
    id: 't-1', title, description, priority: 'Medium', projectId: 'p1',
    type: 'Task', aiPriorityReason: null,
  } as never);
}

describe('PrioritizeProcessor — precondition gate (idempotency)', () => {
  let mocks: PrioMocks;
  let processor: PrioritizeProcessor;

  beforeEach(() => {
    ({ processor, mocks } = buildPrio());
  });

  it('does nothing when the user already changed the priority off Medium', async () => {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1', title: 'whatever', description: 'ok', priority: 'High',
      projectId: 'p1', type: 'Task', aiPriorityReason: null,
    } as never);
    await processor.process(job({ taskId: 't-1' }));
    expect(mocks.llm.generate).not.toHaveBeenCalled();
    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
  });

  it('does nothing when aiPriorityReason has already been written (re-queue guard)', async () => {
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      id: 't-1', title: 'whatever', description: 'ok', priority: 'Medium',
      projectId: 'p1', type: 'Task', aiPriorityReason: 'AI: already analyzed.',
    } as never);
    await processor.process(job({ taskId: 't-1' }));
    expect(mocks.llm.generate).not.toHaveBeenCalled();
    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
  });

  it('does nothing when the task text is too short to be a useful signal', async () => {
    stubMediumTask(mocks.prisma, 'hi');
    await processor.process(job({ taskId: 't-1' }));
    expect(mocks.llm.generate).not.toHaveBeenCalled();
    expect(mocks.prisma.task.update).not.toHaveBeenCalled();
  });
});

describe('PrioritizeProcessor — LLM happy path', () => {
  let mocks: PrioMocks;
  let processor: PrioritizeProcessor;

  beforeEach(() => {
    ({ processor, mocks } = buildPrio());
  });

  it('persists priority + rationale when LLM returns valid JSON', async () => {
    stubMediumTask(mocks.prisma, 'Production DB failing on writes', 'transactions error out');
    mocks.llm.generateWithUsage.mockResolvedValueOnce({
      text: JSON.stringify({ priority: 'Critical', rationale: 'Prod DB is failing.' }),
      modelName: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
    });
    // Processor re-fetches before writing — return same Medium state.
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      priority: 'Medium', aiPriorityReason: null,
    } as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({} as never);

    await processor.process(job({ taskId: 't-1' }));

    const args = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(args?.data?.priority).toBe('Critical');
    expect(args?.data?.aiPriorityReason).toBe('Prod DB is failing.');
    // Triage explanation is the new auditable prose. Must reference the
    // chosen priority and cite at least one signal name (deadline / blockers /
    // customer impact) so the reader can audit the AI's reasoning.
    expect(String(args?.data?.aiTriageExplanation)).toMatch(/Critical/);
    // Cost row was attempted with the prioritize kind + the model the LLM
    // claimed in its usage response.
    expect(mocks.costs.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'prioritize', modelName: 'claude-sonnet-4-6' }),
    );
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'task.priority_suggested', expect.objectContaining({ taskId: 't-1', priority: 'Critical' }),
    );
  });

  it('strips ```json fences before parsing', async () => {
    stubMediumTask(mocks.prisma, 'Some nontrivial title', 'a description');
    mocks.llm.generateWithUsage.mockResolvedValueOnce({
      text: '```json\n{"priority":"High","rationale":"reason"}\n```',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 80,
      outputTokens: 30,
    });
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      priority: 'Medium', aiPriorityReason: null,
    } as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({} as never);

    await processor.process(job({ taskId: 't-1' }));

    const args = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(args?.data?.priority).toBe('High');
  });
});

describe('PrioritizeProcessor — keyword heuristic fallback', () => {
  let mocks: PrioMocks;
  let processor: PrioritizeProcessor;

  beforeEach(() => {
    ({ processor, mocks } = buildPrio());
  });

  function setupGarbageLlm(title: string) {
    stubMediumTask(mocks.prisma, title);
    mocks.llm.generateWithUsage.mockResolvedValueOnce({
      text: 'this is not JSON at all',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 50,
      outputTokens: 10,
    });
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      priority: 'Medium', aiPriorityReason: null,
    } as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({} as never);
  }

  it('maps "security" / "breach" / "outage" / "critical" → Critical', async () => {
    setupGarbageLlm('Security breach in payment flow');
    await processor.process(job({ taskId: 't-1' }));
    const args = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(args?.data?.priority).toBe('Critical');
    expect(String(args?.data?.aiPriorityReason)).toMatch(/critical/i);
  });

  it('maps "urgent" / "asap" / "important" → High', async () => {
    setupGarbageLlm('Urgent: customer reports broken checkout ASAP');
    await processor.process(job({ taskId: 't-1' }));
    const args = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(args?.data?.priority).toBe('High');
  });

  it('maps "nice to have" / "backlog" / "chore" → Low', async () => {
    setupGarbageLlm('Backlog cleanup: nice to have tooltip on the avatar');
    await processor.process(job({ taskId: 't-1' }));
    const args = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(args?.data?.priority).toBe('Low');
  });

  it('writes a "no strong signal" rationale and stops when no keyword matches', async () => {
    stubMediumTask(mocks.prisma, 'Refactor the avatar component into smaller pieces');
    mocks.llm.generateWithUsage.mockResolvedValueOnce({
      text: 'not json',
      modelName: 'claude-sonnet-4-6',
      inputTokens: 40,
      outputTokens: 10,
    });
    await processor.process(job({ taskId: 't-1' }));
    const args = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(args?.data?.priority).toBeUndefined();
    expect(String(args?.data?.aiPriorityReason)).toMatch(/no strong/i);
    expect(mocks.events.emit).not.toHaveBeenCalled();
  });
});

// =============================================================================
// BlockerPredictionProcessor — nightly scan. Real code persists aiRiskReason +
// notifies assignee + reporter; there is no isLikelyBlocked field on the task.
// =============================================================================

interface BlockerMocks {
  prisma: PrismaService;
  events: ReturnType<typeof makeEventsMock>;
}

function buildBlocker(): { processor: BlockerPredictionProcessor; mocks: BlockerMocks } {
  const prisma = makePrismaMock();
  const events = makeEventsMock();
  const processor = new BlockerPredictionProcessor(prisma, events.instance);
  return { processor, mocks: { prisma, events } };
}

describe('BlockerPredictionProcessor', () => {
  let mocks: BlockerMocks;
  let processor: BlockerPredictionProcessor;

  beforeEach(() => {
    ({ processor, mocks } = buildBlocker());
  });

  it('scans only In Progress + not blocked + stale (>7d) tasks', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([] as never);
    await processor.process(job({}));
    const args = vi.mocked(mocks.prisma.task.findMany).mock.calls[0]?.[0];
    expect(args?.where?.status).toBe('In Progress');
    expect(args?.where?.isBlocked).toBe(false);
    expect(args?.where?.updatedAt).toEqual(expect.objectContaining({ lt: expect.any(Date) }));
  });

  it('writes aiRiskReason and notifies assignee + reporter on each stale task', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([{
      id: 't-stale', projectId: 'p1', title: 'spinning', keyNumber: 7,
      assigneeUserId: 'u-assignee', reporterUserId: 'u-reporter',
    }] as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.notification.create).mockResolvedValue({} as never);

    await processor.process(job({}));

    const updateArgs = vi.mocked(mocks.prisma.task.update).mock.calls[0]?.[0];
    expect(updateArgs?.where).toEqual({ id: 't-stale' });
    expect(String(updateArgs?.data?.aiRiskReason)).toMatch(/7 days/);
    expect(mocks.prisma.notification.create).toHaveBeenCalledTimes(2);
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'ai.blocker_predicted', expect.objectContaining({ taskId: 't-stale', projectId: 'p1' }),
    );
  });

  it('does not double-notify when assignee === reporter (Set dedup)', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([{
      id: 't-stale', projectId: 'p1', title: 'spinning', keyNumber: 8,
      assigneeUserId: 'u-same', reporterUserId: 'u-same',
    }] as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.notification.create).mockResolvedValue({} as never);

    await processor.process(job({}));
    expect(mocks.prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it('handles assignee=null gracefully (notifies reporter only)', async () => {
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValueOnce([{
      id: 't-stale', projectId: 'p1', title: 'spinning', keyNumber: 9,
      assigneeUserId: null, reporterUserId: 'u-r',
    }] as never);
    vi.mocked(mocks.prisma.task.update).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.notification.create).mockResolvedValue({} as never);

    await processor.process(job({}));
    expect(mocks.prisma.notification.create).toHaveBeenCalledTimes(1);
  });
});
