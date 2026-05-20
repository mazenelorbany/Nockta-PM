import type { EventEmitter2 } from '@nestjs/event-emitter';
import { vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// Lightweight, type-tolerant mock factories used across the test suites.
//
// We deliberately don't try to model the full Prisma client. Each test sets
// up just the methods it exercises (with vi.fn().mockResolvedValueOnce(...)),
// and the factory returns an object that satisfies the constructor signature
// of the service under test via `as unknown as PrismaService`.
// =============================================================================

/** Build a Prisma mock with every model + method we touch in tests as a vi.fn(). */
export function makePrismaMock(): PrismaService {
  // Default each method to a resolved-undefined Promise so service-internal
  // fire-and-forget calls like `prisma.foo.create(...).catch(...)` don't
  // blow up in tests that didn't bother stubbing every model method.
  // Tests that need a real return value still override via
  // `mockResolvedValueOnce(...)`, which takes precedence.
  const m = () => vi.fn().mockResolvedValue(undefined);
  const model = (methods: string[]) =>
    Object.fromEntries(methods.map((k) => [k, m()]));

  // Build the bag first so $transaction can close over `bag` (rather than
  // `this`, which is undefined inside arrow functions under strict mode).
  // $transaction passes the SAME mock back into the callback so call sites
  // doing tx.user.findUnique etc. share state with the outer mock.
  const bag: Record<string, unknown> = {
    user: model([
      'findUnique',
      'findFirst',
      'findMany',
      'findUniqueOrThrow',
      'create',
      'upsert',
      'update',
      'updateMany',
      'delete',
    ]),
    refreshToken: model([
      'findUnique',
      'findFirst',
      'findUniqueOrThrow',
      'create',
      'update',
      'updateMany',
      'delete',
    ]),
    magicLink: model(['findUnique', 'create', 'update', 'updateMany']),
    project: model([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
    ]),
    projectAccess: model(['findFirst', 'findMany', 'create', 'update', 'upsert', 'delete']),
    projectWorkflowTransition: model(['findMany', 'createMany', 'deleteMany']),
    teamMember: model(['findMany', 'deleteMany', 'createMany']),
    team: model(['findMany', 'findUnique']),
    task: model([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findMany',
      'count',
      'create',
      'update',
      'updateMany',
      'delete',
      'groupBy',
    ]),
    comment: model([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findMany',
      'create',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
    ]),
    commentMention: model(['create', 'createMany', 'delete', 'deleteMany']),
    commentReaction: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'upsert',
      'delete',
      'deleteMany',
    ]),
    commentRevision: model([
      'findUnique',
      'findMany',
      'create',
      'delete',
      'deleteMany',
    ]),
    attachment: model([
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findMany',
      'create',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
    ]),
    sprint: model(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findMany', 'update', 'create']),
    sprintTaskMembership: model([
      'findMany',
      'create',
      'createMany',
      'update',
      'updateMany',
      'delete',
    ]),
    savedSearch: model([
      'findMany',
      'findUnique',
      'create',
      'update',
      'delete',
      'deleteMany',
    ]),
    projectTemplate: model(['findUnique', 'findMany', 'create', 'delete']),
    label: model(['findUnique', 'findMany', 'create', 'createMany', 'delete']),
    taskWatcher: model(['create', 'createMany', 'upsert', 'delete', 'deleteMany', 'findMany']),
    taskReporter: model(['findMany', 'upsert', 'delete']),
    taskLink: model(['findUnique', 'findUniqueOrThrow', 'create', 'delete']),
    taskEmbeddingMeta: model(['findUnique', 'upsert', 'deleteMany']),
    goal: model(['findUnique', 'findMany', 'create', 'update', 'delete']),
    keyResult: model(['findMany', 'findUnique', 'findUniqueOrThrow', 'create', 'update', 'delete', 'aggregate']),
    goalTask: model(['upsert', 'delete', 'findMany']),
    notificationPreference: model([
      'findMany',
      'findFirst',
      'findUnique',
      'create',
      'update',
      'upsert',
    ]),
    notification: model([
      'findUnique',
      'findFirst',
      'findMany',
      'count',
      'create',
      'update',
      'updateMany',
      'delete',
    ]),
    taskMute: model(['findUnique', 'create', 'upsert', 'delete']),
    notificationMute: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'upsert',
      'delete',
      'deleteMany',
    ]),
    notificationSnoozeRule: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
      'deleteMany',
    ]),
    auditLogEntry: model([
      'findUnique',
      'findMany',
      'create',
      'delete',
      'deleteMany',
    ]),
    chatBinding: model(['findUnique', 'findFirst', 'create', 'delete', 'deleteMany', 'upsert']),
    event: model(['findFirst', 'findMany', 'create']),
    automation: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
    ]),
    automationRun: model(['create', 'findMany']),
    automationStep: model([
      'findUnique',
      'findMany',
      'create',
      'delete',
      'aggregate',
    ]),
    taskLabel: model(['create', 'upsert', 'delete', 'findMany', 'groupBy']),
    deployment: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'upsert',
    ]),
    taskDeployment: model(['upsert', 'findMany']),
    projectDeploymentSecret: model(['findUnique', 'upsert']),
    taskGithubLink: model(['findMany', 'create']),
    workspaceAiSettings: model([
      'findUnique',
      'findFirst',
      'create',
      'update',
      'upsert',
    ]),
    // Templates carry the cross-project gallery + tag list endpoints. Tests
    // hitting the listGallery / listGalleryTags paths read findMany; the
    // create/update paths are already covered by the basic CRUD list.
    taskTemplate: model([
      'findUnique',
      'findMany',
      'findFirst',
      'create',
      'update',
      'delete',
    ]),
    // Worklog mock — added so tests touching the live-timer code path (start,
    // stop, getMyActive, computeWeeklyStreak's raw-query setup) can stub
    // findFirst / updateMany without a hand-rolled spy bag.
    worklog: model([
      'findFirst',
      'findMany',
      'aggregate',
      'create',
      'update',
      'updateMany',
      'delete',
    ]),
    // Outbound webhooks (Pass 2 of Round 5 — workspace-level fan-out, distinct
    // from automation-rule send_webhook).
    outboundWebhook: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'updateMany',
      'delete',
    ]),
    webhookDelivery: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
    ]),
    // AiUsageEvent — cost telemetry rows (Round 6 Pass B). Both record() and
    // aggregate() callers stub through the Prisma client; tests that need
    // summary() also stub $transaction/$queryRaw on the top-level bag.
    aiUsageEvent: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'createMany',
      'aggregate',
      'groupBy',
      'count',
    ]),
    // ImportRun + JiraStatusMap — Pass D Imports overhaul (resume + Jira-CSV).
    // Tests for the imports service stub create / update / findUnique to
    // assert resume-point persistence and the row-error feed.
    importRun: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'updateMany',
      'delete',
    ]),
    jiraStatusMap: model([
      'findUnique',
      'findMany',
      'create',
      'update',
      'upsert',
      'delete',
      'deleteMany',
    ]),
    // ExportSchedule + ExportRun — Round 6 Pass E exports overhaul. The
    // service tests stub findUnique/findMany/create/update so the lifecycle
    // can be exercised without a live database.
    exportSchedule: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
    ]),
    exportRun: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
    ]),
    // Pass I — Notifications 8→9. The dispatcher's digest fork reads/writes
    // this table; the digest scheduler tick() also drains it on time.
    notificationDigest: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'updateMany',
      'delete',
    ]),
    // Pass I — Sprints 8→9. Retro + goal-evaluation rows hang off Sprint.
    sprintRetro: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'upsert',
      'delete',
    ]),
    sprintGoalEvaluation: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'upsert',
      'delete',
    ]),
    // Pass I — Comments 8→9. Workspace or project-scoped comment templates.
    commentTemplate: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
      'deleteMany',
    ]),
    // Pass I — Analytics 8→9. Saved custom-report definitions.
    customReport: model([
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'delete',
    ]),
  };
  bag.$transaction = vi.fn(async (cb: unknown) => {
    if (typeof cb === 'function') {
      return (cb as (tx: unknown) => unknown)(bag);
    }
    return cb;
  });
  // Raw-SQL escape hatch — services that use Prisma.sql for date_trunc /
  // window queries (analytics, ai cost-tracking) call $queryRaw directly.
  // Tests override with mockResolvedValueOnce per case.
  bag.$queryRaw = vi.fn().mockResolvedValue([]);
  // $executeRaw is used for in-place writes that side-step model methods —
  // currently the digest service's atomic JSONB append. Returns row-count by
  // contract; default to 1 ("affected one row") so the happy path doesn't
  // accidentally exercise the "row vanished mid-flight" branch.
  bag.$executeRaw = vi.fn().mockResolvedValue(1);
  return bag as unknown as PrismaService;
}

/** Build an EventEmitter2 mock with a no-op emit. Returns the spy for assertions. */
export function makeEventsMock(): {
  instance: EventEmitter2;
  emit: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn();
  return {
    instance: { emit } as unknown as EventEmitter2,
    emit,
  };
}
