import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  type PrismaClient,
  type Priority,
  type TaskType,
  type WorkflowPreset,
} from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportRunsService } from './import-runs.service';

// =============================================================================
// Linear → Nockta importer, refactored from scripts/import-from-linear.ts into
// a service so both the CLI and the in-product UI flow share the same code
// path. The CLI script is now a thin wrapper that constructs this service with
// a standalone PrismaClient.
//
// Public methods:
//   listTeams(apiKey)                     → fast probe: workspace teams.
//   previewTeam(apiKey, teamId, mapping)  → first 20 issues as they'd land.
//   runImport(apiKey, teamId, mapping, options)
//                                         → starts a run, returns { runId }.
//
// The bulk write path matches the CLI: build a label catalog, atomically bump
// the project's nextTaskNumber by the total issue count, then create tasks
// sequentially. The progress side-channel (Socket.IO room `import:<runId>`)
// is driven by ImportRunsService.increment() on every issue.
// =============================================================================

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  description?: string | null;
}

export interface LinearStatusMapping {
  /** Linear state.type → Nockta status string. Optional overrides; unmapped
   *  keys fall back to the preset's coarse default (see mapStatusDefault). */
  unstarted?: string;
  started?: string;
  completed?: string;
  canceled?: string;
  backlog?: string;
  triage?: string;
}

export interface LinearImportMapping {
  /** Which Nockta workflow preset the destination project uses. Defaults to
   *  'engineering'. */
  preset?: WorkflowPreset;
  /** Per state.type overrides — see LinearStatusMapping. */
  statusByType?: LinearStatusMapping;
  /** When true, also pull archived issues. Default: false. */
  includeArchived?: boolean;
}

export interface ImportPreviewRow {
  identifier: string;
  title: string;
  status: string;
  priority: Priority;
  type: TaskType;
  assigneeEmail: string | null;
  labels: string[];
  dueDate: string | null;
}

export interface ImportPreview {
  /** Total issue count for the team (after applying includeArchived). */
  totalIssues: number;
  /** First 20 rows as they would land in Nockta. */
  preview: ImportPreviewRow[];
}

export interface LinearRunOptions {
  /** Admin user id who kicked off the import. Used as createdBy on the project
   *  and as fallback reporter when an issue has no assignee. */
  actorUserId: string;
  /** When true, validate-only — no rows persisted. */
  dryRun?: boolean;
}

interface LinearUser {
  id: string;
  email: string;
  name: string;
  active: boolean;
}

interface LinearState {
  id: string;
  name: string;
  type: 'unstarted' | 'started' | 'completed' | 'canceled' | 'backlog' | 'triage';
}

interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

interface LinearIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  priority: number;
  dueDate: string | null;
  createdAt: string;
  archivedAt: string | null;
  state: LinearState;
  assignee: { id: string } | null;
  labels: { nodes: LinearLabel[] };
  parent: { id: string } | null;
}

@Injectable()
export class LinearImportService {
  private readonly logger = new Logger(LinearImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: ImportRunsService,
  ) {}

  /** Probe Linear for workspace teams. Used by the UI to populate the team
   *  picker after the user pastes their API key. */
  async listTeams(apiKey: string): Promise<LinearTeam[]> {
    if (!apiKey) throw new BadRequestException('Missing Linear API key');
    return fetchAllTeams(apiKey);
  }

  /** Return the first 20 issues for the team, mapped as they would land in
   *  Nockta. Used as the dry-run preview in the UI. */
  async previewTeam(
    apiKey: string,
    teamId: string,
    mapping: LinearImportMapping,
  ): Promise<ImportPreview> {
    if (!apiKey) throw new BadRequestException('Missing Linear API key');
    if (!teamId) throw new BadRequestException('Missing teamId');
    const includeArchived = mapping.includeArchived ?? false;
    const preset = mapping.preset ?? 'engineering';
    // Fetch first page only — 20 rows is enough for a preview.
    const { issues, total } = await fetchTeamIssuesPage(apiKey, teamId, includeArchived, null, 20);
    const users = await fetchAllUsers(apiKey);
    const preview: ImportPreviewRow[] = issues.slice(0, 20).map((iss) => {
      const u = iss.assignee ? users.get(iss.assignee.id) ?? null : null;
      return {
        identifier: iss.identifier,
        title: iss.title,
        status: mapStatus(iss.state.type, preset, mapping.statusByType),
        priority: mapPriority(iss.priority),
        type: iss.parent ? 'Subtask' : 'Task',
        assigneeEmail: u?.email ?? null,
        labels: iss.labels.nodes.map((l) => l.name),
        dueDate: iss.dueDate,
      };
    });
    return { totalIssues: total, preview };
  }

  /** Start the full import run. Returns the runId synchronously; the actual
   *  work runs in the background and pushes progress over Socket.IO. */
  async runImport(
    apiKey: string,
    teamId: string,
    mapping: LinearImportMapping,
    options: LinearRunOptions,
  ): Promise<{ runId: string }> {
    if (!apiKey) throw new BadRequestException('Missing Linear API key');
    if (!teamId) throw new BadRequestException('Missing teamId');

    // Pre-flight: confirm the team exists. We resolve the team's name + key
    // here so the run row carries a meaningful sourceRef before we hand off
    // to the async pipeline.
    const teams = await fetchAllTeams(apiKey);
    const team = teams.find((t) => t.id === teamId);
    if (!team) throw new BadRequestException('Team not found');

    const runId = await this.runs.start({
      source: 'linear',
      actorUserId: options.actorUserId,
      sourceRef: team.key,
      mappingSnapshot: { teamId, teamKey: team.key, mapping },
    });

    // Fire-and-forget — the request returns immediately. Progress goes over
    // Socket.IO room `import:<runId>`; failures land on the run row's
    // errorSummary and the UI sees them via the import.done event.
    void this.executeRun(this.prisma, runId, apiKey, team, mapping, options).catch((err) => {
      this.logger.error({ err, runId }, 'linear run failed');
      void this.runs.finish({
        runId,
        status: 'failed',
        errorSummary: err instanceof Error ? err.message : String(err),
      });
    });

    return { runId };
  }

  /**
   * Executes the import using an explicit PrismaClient — the same shape the
   * CLI script needs. Exposed for the CLI wrapper to call with a standalone
   * client outside the Nest context.
   */
  async executeRun(
    prisma: PrismaClient | PrismaService,
    runId: string,
    apiKey: string,
    team: LinearTeam,
    mapping: LinearImportMapping,
    options: LinearRunOptions,
  ): Promise<void> {
    const preset = mapping.preset ?? 'engineering';
    const includeArchived = mapping.includeArchived ?? false;

    // Resolve admin user (actor) — they own the project.
    const admin = await prisma.user.findUniqueOrThrow({
      where: { id: options.actorUserId },
      select: { id: true },
    });

    // Look for an existing project with the same key or name; if found we
    // append rows to it rather than refusing the import. This is what the
    // CLI does today and lets a partial re-run pick up where it left off
    // for the project-create step.
    const projectKey = mapProjectKey(team);
    let project = await prisma.project.findFirst({
      where: { OR: [{ key: projectKey }, { name: team.name }] },
      select: { id: true, key: true, workflowPreset: true },
    });
    if (!project) {
      if (options.dryRun) {
        await this.runs.finish({ runId, status: 'succeeded' });
        return;
      }
      const created = await prisma.project.create({
        data: {
          key: projectKey,
          name: team.name,
          description:
            team.description ??
            `Imported from Linear team ${team.key} on ${new Date().toISOString().slice(0, 10)}`,
          visibility: 'teams',
          workflowPreset: preset,
          createdById: admin.id,
          workspaceId: 'default',
        },
        select: { id: true, key: true, workflowPreset: true },
      });
      project = created;
    }
    await this.runs.setProject(runId, project.id);

    // Pull all issues + users up front.
    const issues = await fetchTeamIssuesAll(apiKey, team.id, includeArchived);
    await this.runs.setTotal(runId, issues.length);
    const users = await fetchAllUsers(apiKey);

    if (options.dryRun) {
      // Bump every issue through the skipped counter in one shot so the UI
      // sees a completed progress bar without any DB write side-effects.
      if (issues.length > 0) await this.runs.increment(runId, 'skipped', issues.length);
      await this.runs.finish({ runId, status: 'succeeded' });
      return;
    }

    // User cache.
    const userCache = new Map<string, string>();
    const getOrCreateNocktaUser = async (linearId: string): Promise<string> => {
      const cached = userCache.get(linearId);
      if (cached) return cached;
      const lu = users.get(linearId);
      const email =
        lu?.email && lu.email.includes('@')
          ? lu.email.toLowerCase()
          : `${linearId}@linear-imported.local`;
      const name = lu?.name ?? email.split('@')[0]!;
      const u = await prisma.user.upsert({
        where: { email },
        update: {},
        create: { email, name, kind: 'internal', companyRole: 'Member', workspaceId: 'default' },
        select: { id: true },
      });
      userCache.set(linearId, u.id);
      return u.id;
    };

    // Label catalog.
    const linearToNocktaLabel = new Map<string, string>();
    const uniqueLabels = new Map<string, LinearLabel>();
    for (const i of issues) for (const l of i.labels.nodes) uniqueLabels.set(l.id, l);
    for (const l of uniqueLabels.values()) {
      // Upsert pattern — if the label already exists (re-run case), reuse it.
      const existing = await prisma.label.findUnique({
        where: { projectId_name: { projectId: project.id, name: l.name } },
        select: { id: true },
      });
      const id =
        existing?.id ??
        (
          await prisma.label.create({
            data: {
              projectId: project.id,
              name: l.name,
              color: (l.color ?? '').replace(/^#/, '').slice(0, 6).toUpperCase() || 'A78BFA',
            },
            select: { id: true },
          })
        ).id;
      linearToNocktaLabel.set(l.id, id);
    }

    // Reserve a contiguous range of keyNumbers in one shot.
    const bumped = await prisma.project.update({
      where: { id: project.id },
      data: { nextTaskNumber: { increment: issues.length } },
      select: { nextTaskNumber: true },
    });
    const firstKey = bumped.nextTaskNumber - issues.length;

    const linearToNocktaTask = new Map<string, string>();
    let position = generateKeyBetween(null, null);
    let errorCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < issues.length; i++) {
      const iss = issues[i]!;
      try {
        const assigneeId = iss.assignee ? await getOrCreateNocktaUser(iss.assignee.id) : null;
        const task = await prisma.task.create({
          data: {
            projectId: project.id,
            keyNumber: firstKey + i,
            title: iss.title.slice(0, 240),
            description: iss.description ?? null,
            status: mapStatus(iss.state.type, preset, mapping.statusByType),
            priority: mapPriority(iss.priority),
            type: iss.parent ? 'Subtask' : 'Task',
            visibility: 'internal',
            createdById: admin.id,
            reporterUserId: admin.id,
            ...(assigneeId ? { assigneeUserId: assigneeId } : {}),
            ...(iss.dueDate ? { dueDate: new Date(iss.dueDate) } : {}),
            boardPosition: position,
            createdAt: new Date(iss.createdAt),
          },
          select: { id: true },
        });
        linearToNocktaTask.set(iss.id, task.id);

        const labelIds = iss.labels.nodes
          .map((l) => linearToNocktaLabel.get(l.id))
          .filter((x): x is string => Boolean(x));
        if (labelIds.length > 0) {
          await prisma.taskLabel.createMany({
            data: labelIds.map((labelId) => ({
              taskId: task.id,
              labelId,
              addedById: admin.id,
            })),
            skipDuplicates: true,
          });
        }
        position = generateKeyBetween(position, null);
        await this.runs.increment(runId, 'created');
      } catch (err) {
        errorCount += 1;
        if (errors.length < 10) errors.push(`${iss.identifier}: ${(err as Error).message}`);
        await this.runs.increment(runId, 'errored');
      }
    }

    // Subtask parenting (second pass).
    for (const iss of issues) {
      if (!iss.parent) continue;
      const childId = linearToNocktaTask.get(iss.id);
      const parentId = linearToNocktaTask.get(iss.parent.id);
      if (!childId || !parentId) continue;
      try {
        await prisma.task.update({ where: { id: childId }, data: { parentTaskId: parentId } });
      } catch {
        // Non-fatal; we logged the issue create already.
      }
    }

    await this.runs.finish({
      runId,
      status: errorCount === 0 ? 'succeeded' : errorCount === issues.length ? 'failed' : 'succeeded',
      errorSummary: errors.length > 0 ? errors.join('\n') : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Linear GraphQL helpers. Standalone (no Nest dependencies) so the CLI wrapper
// can reuse them and so the service stays small.
// ---------------------------------------------------------------------------

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) throw new Error('Linear API returned no data');
  return body.data;
}

async function fetchAllTeams(apiKey: string): Promise<LinearTeam[]> {
  type Resp = {
    teams: { nodes: LinearTeam[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  };
  const out: LinearTeam[] = [];
  let cursor: string | null = null;
  for (;;) {
    // Explicit Resp annotation on `data` avoids TS7022 (the inference loops
    // through `cursor = data.teams…endCursor` back into the gql call's args).
    const data: Resp = await gql<Resp>(
      apiKey,
      `query Teams($after: String) {
        teams(first: 50, after: $after) {
          nodes { id key name description }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after: cursor },
    );
    out.push(...data.teams.nodes);
    if (!data.teams.pageInfo.hasNextPage) break;
    cursor = data.teams.pageInfo.endCursor;
  }
  return out;
}

async function fetchTeamIssuesPage(
  apiKey: string,
  teamId: string,
  includeArchived: boolean,
  after: string | null,
  first: number,
): Promise<{ issues: LinearIssue[]; total: number; nextCursor: string | null; hasNext: boolean }> {
  type Resp = {
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      totalCount?: number;
    };
  };
  const data = await gql<Resp>(
    apiKey,
    `query Issues($team: ID!, $after: String, $includeArchived: Boolean!, $first: Int!) {
      issues(
        first: $first
        after: $after
        filter: { team: { id: { eq: $team } } }
        includeArchived: $includeArchived
      ) {
        nodes {
          id identifier number title description priority dueDate createdAt archivedAt
          state { id name type }
          assignee { id }
          labels { nodes { id name color } }
          parent { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { team: teamId, after, includeArchived, first },
  );
  return {
    issues: data.issues.nodes,
    total: data.issues.totalCount ?? data.issues.nodes.length,
    nextCursor: data.issues.pageInfo.endCursor,
    hasNext: data.issues.pageInfo.hasNextPage,
  };
}

async function fetchTeamIssuesAll(
  apiKey: string,
  teamId: string,
  includeArchived: boolean,
): Promise<LinearIssue[]> {
  const out: LinearIssue[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchTeamIssuesPage(apiKey, teamId, includeArchived, cursor, 100);
    out.push(...page.issues);
    if (!page.hasNext) break;
    cursor = page.nextCursor;
  }
  return out;
}

async function fetchAllUsers(apiKey: string): Promise<Map<string, LinearUser>> {
  type Resp = {
    users: {
      nodes: LinearUser[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  const map = new Map<string, LinearUser>();
  let cursor: string | null = null;
  for (;;) {
    // See fetchAllTeams — explicit `data: Resp` avoids the inference cycle.
    const data: Resp = await gql<Resp>(
      apiKey,
      `query Users($after: String) {
        users(first: 100, after: $after) {
          nodes { id email name active }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after: cursor },
    );
    for (const u of data.users.nodes) map.set(u.id, u);
    if (!data.users.pageInfo.hasNextPage) break;
    cursor = data.users.pageInfo.endCursor;
  }
  return map;
}

function mapPriority(linearPriority: number): Priority {
  switch (linearPriority) {
    case 1:
      return 'Critical';
    case 2:
      return 'High';
    case 3:
      return 'Medium';
    case 4:
      return 'Low';
    default:
      return 'Medium';
  }
}

function mapStatus(
  stateType: LinearState['type'],
  preset: WorkflowPreset,
  overrides?: LinearStatusMapping,
): string {
  if (overrides && overrides[stateType]) return overrides[stateType]!;
  return mapStatusDefault(stateType, preset);
}

function mapStatusDefault(stateType: LinearState['type'], preset: WorkflowPreset): string {
  switch (stateType) {
    case 'completed':
      return 'Done';
    case 'canceled':
      return 'Done';
    case 'started':
      return 'In Progress';
    case 'triage':
    case 'backlog':
    case 'unstarted':
    default:
      return preset === 'design' ? 'Todo' : 'Todo';
  }
}

function mapProjectKey(team: LinearTeam): string {
  const candidate = (team.key || team.name).replace(/[^A-Z]/gi, '').toUpperCase();
  return candidate.slice(0, 10).padEnd(2, 'X');
}
