import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
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
// Jira → Nockta importer service.
//
// Single code path shared by the CLI (scripts/import-from-jira.ts) and the
// in-app Import Center. The service exposes listProjects / previewProject /
// runImport for the UI flow; the CLI calls executeRun() directly.
//
// What the service imports:
//   - Projects (one per visible Jira project, name preserved).
//   - Tasks (title, ADF→MD description, status, priority, issuetype, due/start
//     dates, original createdAt + updatedAt).
//   - Hierarchy (Subtask `parent` + Epic Link customfield_10014).
//   - Labels + components (purple labels for labels, teal `component:` labels
//     for components).
//   - Comments (Jira issue comments → Nockta Comment rows, ADF→MD body,
//     author resolved by email, original createdAt preserved).
//   - Worklogs (Jira issue worklogs → Nockta Worklog rows, seconds, started,
//     ADF→MD note; zero-second entries skipped).
//   - Users — pre-fetched via /rest/api/3/users/search. Only `active === true`
//     atlassian accounts become Nockta users. Inactive/app/customer accounts
//     are silently remapped to the IMPORT_ADMIN_EMAIL user so FK chains stay
//     intact.
//
// Out of scope (still): attachments, issue links, sprints, custom fields.
// =============================================================================

export interface JiraCreds {
  domain: string;
  email: string;
  apiToken: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

export interface JiraStatusMapping {
  /** Free-form map: lower-cased Jira status → Nockta status. Optional —
   *  unmapped statuses fall back to the preset's coarse defaults. */
  [jiraStatus: string]: string;
}

export interface JiraImportMapping {
  /** Nockta workflow preset to set on the new project. Inferred from
   *  projectTypeKey when omitted. */
  preset?: WorkflowPreset;
  statusOverrides?: JiraStatusMapping;
}

export interface JiraImportPreviewRow {
  key: string;
  title: string;
  status: string;
  priority: Priority;
  type: TaskType;
  assigneeEmail: string | null;
  labels: string[];
  dueDate: string | null;
}

export interface JiraImportPreview {
  totalIssues: number;
  preview: JiraImportPreviewRow[];
}

export interface JiraRunOptions {
  actorUserId: string;
  dryRun?: boolean;
}

interface JiraUser {
  accountId: string;
  emailAddress?: string;
  displayName?: string;
  active?: boolean;
  accountType?: string;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown;
    status: { name: string };
    priority?: { name: string };
    assignee: JiraUser | null;
    reporter: JiraUser | null;
    duedate: string | null;
    created: string;
    updated: string;
    issuetype: { name: string; subtask: boolean };
    parent?: { key: string };
    customfield_10014?: string | null;
    labels?: string[];
    components?: Array<{ name: string }>;
  };
}

interface JiraComment {
  id: string;
  author?: JiraUser;
  body: unknown;
  created: string;
  updated?: string;
}

interface JiraWorklogEntry {
  id: string;
  author?: JiraUser;
  comment?: unknown;
  started?: string;
  timeSpentSeconds?: number;
}

@Injectable()
export class JiraImportService {
  private readonly logger = new Logger(JiraImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: ImportRunsService,
  ) {}

  /** Probe Jira for visible projects. Used by the UI to populate the project
   *  picker after the user pastes their domain + email + API token. */
  async listProjects(creds: JiraCreds): Promise<JiraProject[]> {
    requireCreds(creds);
    const out: JiraProject[] = [];
    for (let startAt = 0; ; startAt += 50) {
      const resp = await jira<{ values: JiraProject[]; isLast: boolean }>(creds, '/rest/api/3/project/search', {
        maxResults: '50',
        startAt: String(startAt),
      });
      out.push(...resp.values);
      if (resp.isLast) break;
    }
    return out;
  }

  async previewProject(
    creds: JiraCreds,
    projectKey: string,
    mapping: JiraImportMapping,
  ): Promise<JiraImportPreview> {
    requireCreds(creds);
    if (!projectKey) throw new BadRequestException('Missing projectKey');
    const resp = await jira<{ issues: JiraIssue[]; total?: number }>(creds, '/rest/api/3/search/jql', {
      jql: `project = "${projectKey}" ORDER BY created ASC`,
      fields: PREVIEW_FIELDS,
      maxResults: '20',
    });
    const preset = mapping.preset ?? 'engineering';
    const preview: JiraImportPreviewRow[] = resp.issues.map((iss) => ({
      key: iss.key,
      title: iss.fields.summary,
      status: mapStatus(iss.fields.status?.name ?? 'To Do', preset, mapping.statusOverrides),
      priority: mapPriority(iss.fields.priority?.name),
      type: mapType(iss.fields.issuetype),
      assigneeEmail: iss.fields.assignee?.emailAddress?.toLowerCase() ?? null,
      labels: [
        ...(iss.fields.labels ?? []),
        ...(iss.fields.components ?? []).map((c) => `component:${c.name}`),
      ],
      dueDate: iss.fields.duedate,
    }));
    return { totalIssues: resp.total ?? preview.length, preview };
  }

  async runImport(
    creds: JiraCreds,
    projectKey: string,
    mapping: JiraImportMapping,
    options: JiraRunOptions,
  ): Promise<{ runId: string }> {
    requireCreds(creds);
    if (!projectKey) throw new BadRequestException('Missing projectKey');
    const projects = await this.listProjects(creds);
    const jp = projects.find((p) => p.key === projectKey);
    if (!jp) throw new BadRequestException('Project not visible to the supplied token');

    const runId = await this.runs.start({
      source: 'jira',
      actorUserId: options.actorUserId,
      sourceRef: jp.key,
      mappingSnapshot: { projectKey, mapping },
    });

    void this.executeRun(this.prisma, runId, creds, jp, mapping, options).catch((err) => {
      this.logger.error({ err, runId }, 'jira run failed');
      void this.runs.finish({
        runId,
        status: 'failed',
        errorSummary: err instanceof Error ? err.message : String(err),
      });
    });

    return { runId };
  }

  /**
   * Full import body. Same as executeRun in linear-import.service.ts — works
   * with either PrismaService (Nest) or a raw PrismaClient (CLI wrapper).
   */
  async executeRun(
    prisma: PrismaClient | PrismaService,
    runId: string,
    creds: JiraCreds,
    jp: JiraProject,
    mapping: JiraImportMapping,
    options: JiraRunOptions,
  ): Promise<void> {
    const preset = mapping.preset ?? inferPreset(jp);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { id: options.actorUserId },
      select: { id: true },
    });

    // Project resolution: existing match wins (re-run friendly).
    let project = await prisma.project.findFirst({
      where: { name: jp.name },
      select: { id: true, key: true },
    });
    if (!project) {
      if (options.dryRun) {
        await this.runs.finish({ runId, status: 'succeeded' });
        return;
      }
      const key = await pickUniqueKey(prisma, jp.key);
      project = await prisma.project.create({
        data: {
          key,
          name: jp.name,
          description: `Imported from Jira project ${jp.key} on ${new Date().toISOString().split('T')[0]}`,
          visibility: 'public',
          workflowPreset: preset,
          sprintsEnabled: false,
          createdById: admin.id,
        },
        select: { id: true, key: true },
      });
    }
    await this.runs.setProject(runId, project.id);

    // Pull every issue first so we know the total before starting writes.
    // Memory: a typical Jira project (≤5k issues) is fine; for huge migrations
    // the CLI still streams page-by-page (see the original script). The service
    // path trades memory for a single deterministic progress total.
    const issues = await fetchAllJiraIssues(creds, jp.key);
    await this.runs.setTotal(runId, issues.length);

    if (options.dryRun) {
      if (issues.length > 0) await this.runs.increment(runId, 'skipped', issues.length);
      await this.runs.finish({ runId, status: 'succeeded' });
      return;
    }

    // Pre-fetch the workspace user directory so we know each accountId's
    // `active` flag and full email up front. Without this, the resolver below
    // only sees the partial JiraUser sub-object embedded on each issue field,
    // which lacks both the active flag and (when email visibility is
    // restricted) the address — and we'd silently create deactivated seats.
    const directory = await fetchJiraUserDirectory(creds);

    // User cache. Resolution rules:
    //   - Null author → admin.
    //   - Non-atlassian account (app / customer) → admin.
    //   - Inactive atlassian account → admin (drops the deactivated seat).
    //   - Active atlassian account → upserted Nockta user keyed by email.
    const userCache = new Map<string, string>();
    const resolveUser = async (j: JiraUser | null | undefined): Promise<string> => {
      if (!j) return admin.id;
      const cached = userCache.get(j.accountId);
      if (cached) return cached;
      const merged: JiraUser = { ...(directory.get(j.accountId) ?? {}), ...j };
      if (merged.accountType && merged.accountType !== 'atlassian') {
        userCache.set(j.accountId, admin.id);
        return admin.id;
      }
      if (merged.active === false) {
        userCache.set(j.accountId, admin.id);
        return admin.id;
      }
      const email = merged.emailAddress?.toLowerCase() || `${j.accountId}@jira-imported.local`;
      const u = await prisma.user.upsert({
        where: { email },
        update: { name: merged.displayName ?? email },
        create: {
          email,
          name: merged.displayName ?? email,
          kind: 'internal',
          companyRole: 'Member',
        },
        select: { id: true },
      });
      userCache.set(j.accountId, u.id);
      return u.id;
    };

    const labelCache = new Map<string, string>();
    const ensureLabel = async (name: string, color: string): Promise<string> => {
      const trimmed = name.trim();
      // internal: not reached from an HTTP request — background executeRun; caught + logged in importRuns.
      if (!trimmed) throw new Error('empty label');
      const cached = labelCache.get(trimmed.toLowerCase());
      if (cached) return cached;
      const existing = await prisma.label.findUnique({
        where: { projectId_name: { projectId: project!.id, name: trimmed } },
        select: { id: true },
      });
      const id =
        existing?.id ??
        (
          await prisma.label.create({
            data: { projectId: project!.id, name: trimmed, color },
            select: { id: true },
          })
        ).id;
      labelCache.set(trimmed.toLowerCase(), id);
      return id;
    };

    const jiraKeyToTaskId = new Map<string, string>();
    let lastBoardPos: string | null = null;
    const errors: string[] = [];
    const commentUpdatedAt: { id: string; updatedAt: Date }[] = [];
    let workloggedSeconds = 0;
    for (const issue of issues) {
      try {
        const f = issue.fields;
        const assigneeId = f.assignee ? await resolveUser(f.assignee) : null;
        const reporterId = f.reporter ? await resolveUser(f.reporter) : await resolveUser(null);
        const updated = await prisma.project.update({
          where: { id: project.id },
          data: { nextTaskNumber: { increment: 1 } },
          select: { nextTaskNumber: true },
        });
        const keyNumber = updated.nextTaskNumber - 1;
        const boardPosition = generateKeyBetween(lastBoardPos, null);

        const task = await prisma.task.create({
          data: {
            projectId: project.id,
            keyNumber,
            type: mapType(f.issuetype),
            title: f.summary || `(imported ${issue.key})`,
            ...(f.description ? { description: adfToMarkdown(f.description) } : {}),
            status: mapStatus(f.status?.name ?? 'To Do', preset, mapping.statusOverrides),
            priority: mapPriority(f.priority?.name),
            visibility: 'internal',
            reportedByClient: false,
            ...(assigneeId ? { assigneeUserId: assigneeId } : {}),
            reporterUserId: reporterId,
            createdById: reporterId,
            ...(f.duedate ? { dueDate: new Date(f.duedate) } : {}),
            boardPosition,
            createdAt: new Date(f.created),
          },
          select: { id: true },
        });
        lastBoardPos = boardPosition;
        jiraKeyToTaskId.set(issue.key, task.id);

        // Labels + components.
        const labelLinks: { taskId: string; labelId: string; addedById: string }[] = [];
        for (const raw of f.labels ?? []) {
          if (!raw) continue;
          try {
            labelLinks.push({
              taskId: task.id,
              labelId: await ensureLabel(raw, 'A78BFA'),
              addedById: admin.id,
            });
          } catch {
            /* skip bad label */
          }
        }
        for (const comp of f.components ?? []) {
          try {
            labelLinks.push({
              taskId: task.id,
              labelId: await ensureLabel(`component:${comp.name}`, '7DD3C0'),
              addedById: admin.id,
            });
          } catch {
            /* skip bad component */
          }
        }
        if (labelLinks.length > 0) {
          await prisma.taskLabel.createMany({ data: labelLinks, skipDuplicates: true });
        }

        // Comments — paginated. Each Jira comment becomes a Nockta Comment
        // row with the original created/updated timestamps preserved at the
        // end of executeRun (see the raw-SQL pass below — Prisma's
        // @updatedAt would otherwise clobber it).
        const comments = await fetchJiraComments(creds, issue.key);
        for (const c of comments) {
          try {
            const authorId = await resolveUser(c.author ?? null);
            const body = adfToMarkdown(c.body) || '(empty comment)';
            const created = await prisma.comment.create({
              data: {
                taskId: task.id,
                authorUserId: authorId,
                bodyMd: body,
                visibility: 'internal',
                createdAt: new Date(c.created),
              },
              select: { id: true },
            });
            commentUpdatedAt.push({ id: created.id, updatedAt: new Date(c.updated ?? c.created) });
          } catch (cerr) {
            if (errors.length < 10) errors.push(`${issue.key} comment: ${(cerr as Error).message}`);
          }
        }

        // Worklogs — Jira worklog entries become Nockta Worklog rows. Zero-
        // second entries are skipped (Nockta treats endedAt IS NULL as a
        // live timer, and we don't want phantom live timers post-import).
        const worklogs = await fetchJiraWorklogs(creds, issue.key);
        for (const w of worklogs) {
          const seconds = Number(w.timeSpentSeconds ?? 0);
          if (!Number.isFinite(seconds) || seconds <= 0) continue;
          try {
            const userId = await resolveUser(w.author ?? null);
            const startedAt = new Date(w.started ?? f.created);
            const endedAt = new Date(startedAt.getTime() + seconds * 1000);
            await prisma.worklog.create({
              data: {
                taskId: task.id,
                userId,
                seconds,
                startedAt,
                endedAt,
                ...(w.comment ? { note: adfToMarkdown(w.comment) } : {}),
              },
            });
            workloggedSeconds += seconds;
          } catch (werr) {
            if (errors.length < 10) errors.push(`${issue.key} worklog: ${(werr as Error).message}`);
          }
        }
        await this.runs.increment(runId, 'created');
      } catch (err) {
        if (errors.length < 10) errors.push(`${issue.key}: ${(err as Error).message}`);
        await this.runs.increment(runId, 'errored');
      }
    }

    // Parent-link pass 2.
    for (const issue of issues) {
      const parentKey = issue.fields.parent?.key ?? issue.fields.customfield_10014 ?? null;
      if (!parentKey) continue;
      const childId = jiraKeyToTaskId.get(issue.key);
      const parentId = jiraKeyToTaskId.get(parentKey);
      if (!childId || !parentId) continue;
      try {
        await prisma.task.update({ where: { id: childId }, data: { parentTaskId: parentId } });
      } catch {
        /* non-fatal */
      }
    }

    // updatedAt-preservation pass. Both Task and Comment have @updatedAt,
    // which Prisma sets to now() on every write — including the
    // parent-link pass we just ran. So we restore the imported timestamps
    // via raw SQL at the very end of the run.
    for (const issue of issues) {
      const taskId = jiraKeyToTaskId.get(issue.key);
      if (!taskId) continue;
      const updated = issue.fields.updated;
      if (!updated) continue;
      try {
        await prisma.$executeRaw`UPDATE "Task" SET "updatedAt" = ${new Date(updated)} WHERE id = ${taskId}::uuid`;
      } catch {
        /* non-fatal */
      }
    }
    for (const { id, updatedAt } of commentUpdatedAt) {
      try {
        await prisma.$executeRaw`UPDATE "Comment" SET "updatedAt" = ${updatedAt} WHERE id = ${id}::uuid`;
      } catch {
        /* non-fatal */
      }
    }

    this.logger.log(
      `jira import for ${jp.key}: ${issues.length} tasks, ${commentUpdatedAt.length} comments, ${workloggedSeconds}s of worklogs`,
    );

    await this.runs.finish({
      runId,
      status: errors.length === issues.length && issues.length > 0 ? 'failed' : 'succeeded',
      errorSummary: errors.length > 0 ? errors.join('\n') : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Jira REST helpers.
// ---------------------------------------------------------------------------

function requireCreds(c: JiraCreds): void {
  if (!c.domain || !c.email || !c.apiToken) {
    throw new BadRequestException('Missing Jira credentials');
  }
}

async function jira<T>(
  creds: JiraCreds,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`https://${creds.domain}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // 125ms soft rate-limit (matches the CLI; well under Jira's 100/min).
  await new Promise((r) => setTimeout(r, 125));
  const auth = 'Basic ' + Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new InternalServerErrorException(`Jira ${path} → ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

const PREVIEW_FIELDS = [
  'summary',
  'description',
  'status',
  'priority',
  'assignee',
  'reporter',
  'duedate',
  'created',
  'updated',
  'issuetype',
  'parent',
  'labels',
  'components',
  'customfield_10014',
].join(',');

async function fetchJiraUserDirectory(creds: JiraCreds): Promise<Map<string, JiraUser>> {
  const directory = new Map<string, JiraUser>();
  for (let startAt = 0; ; startAt += 100) {
    const resp = await jira<JiraUser[]>(creds, '/rest/api/3/users/search', {
      startAt: String(startAt),
      maxResults: '100',
    });
    if (!Array.isArray(resp) || resp.length === 0) break;
    for (const u of resp) {
      if (u?.accountId) directory.set(u.accountId, u);
    }
    if (resp.length < 100) break;
  }
  return directory;
}

async function fetchJiraComments(creds: JiraCreds, issueKey: string): Promise<JiraComment[]> {
  const out: JiraComment[] = [];
  for (let startAt = 0; ; startAt += 100) {
    const resp = await jira<{ comments: JiraComment[]; total: number }>(
      creds,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      { startAt: String(startAt), maxResults: '100' },
    );
    out.push(...(resp.comments ?? []));
    if ((resp.comments?.length ?? 0) < 100 || out.length >= (resp.total ?? out.length)) break;
  }
  return out;
}

async function fetchJiraWorklogs(creds: JiraCreds, issueKey: string): Promise<JiraWorklogEntry[]> {
  const out: JiraWorklogEntry[] = [];
  for (let startAt = 0; ; startAt += 100) {
    const resp = await jira<{ worklogs: JiraWorklogEntry[]; total: number }>(
      creds,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`,
      { startAt: String(startAt), maxResults: '100' },
    );
    out.push(...(resp.worklogs ?? []));
    if ((resp.worklogs?.length ?? 0) < 100 || out.length >= (resp.total ?? out.length)) break;
  }
  return out;
}

async function fetchAllJiraIssues(creds: JiraCreds, projectKey: string): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  for (;;) {
    const params: Record<string, string> = {
      jql: `project = "${projectKey}" ORDER BY created ASC`,
      fields: PREVIEW_FIELDS,
      maxResults: '100',
    };
    if (nextPageToken) params['nextPageToken'] = nextPageToken;
    const resp = await jira<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(
      creds,
      '/rest/api/3/search/jql',
      params,
    );
    out.push(...resp.issues);
    if (resp.isLast || !resp.nextPageToken) break;
    nextPageToken = resp.nextPageToken;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapping helpers. Copied from the CLI script so the service stands alone.
// ---------------------------------------------------------------------------

function mapPriority(name: string | undefined): Priority {
  switch ((name ?? 'Medium').toLowerCase()) {
    case 'highest':
      return 'Critical';
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
    case 'lowest':
      return 'Low';
    default:
      return 'Medium';
  }
}

function mapType(jiraType: { name: string; subtask: boolean } | undefined): TaskType {
  if (!jiraType) return 'Task';
  if (jiraType.subtask) return 'Subtask';
  const n = jiraType.name.toLowerCase();
  if (n === 'epic') return 'Epic';
  if (n.includes('story')) return 'Story';
  if (n === 'bug' || n === 'defect') return 'Bug';
  return 'Task';
}

function mapStatus(
  jiraStatus: string,
  preset: WorkflowPreset,
  overrides?: JiraStatusMapping,
): string {
  if (overrides) {
    const hit = overrides[jiraStatus.toLowerCase()];
    if (hit) return hit;
  }
  const lower = jiraStatus.toLowerCase();
  const done = [
    'done',
    'closed',
    'resolved',
    'completed',
    'cancelled',
    'canceled',
    "won't do",
    'wont do',
  ];
  if (preset === 'generic') {
    if (done.some((k) => lower.includes(k))) return 'Done';
    if (
      lower.includes('progress') ||
      lower.includes('doing') ||
      lower.includes('development') ||
      lower.includes('selected')
    )
      return 'In Progress';
    return 'Todo';
  }
  if (preset === 'design') {
    if (done.some((k) => lower.includes(k))) return 'Done';
    if (lower.includes('approv')) return 'Approved';
    if (lower.includes('review')) return 'In Review';
    if (lower.includes('progress') || lower.includes('doing')) return 'In Progress';
    return 'Todo';
  }
  if (done.some((k) => lower.includes(k))) return 'Done';
  if (lower.includes('test') || lower.includes('qa') || lower.includes('uat')) return 'Testing';
  if (lower.includes('review')) return 'In Review';
  if (
    lower.includes('progress') ||
    lower.includes('doing') ||
    lower.includes('development') ||
    lower.includes('selected')
  )
    return 'In Progress';
  return 'Todo';
}

function inferPreset(p: JiraProject): WorkflowPreset {
  if (p.projectTypeKey === 'software') return 'engineering';
  const lc = p.name.toLowerCase();
  if (lc.includes('design') || lc.includes('creative') || lc.includes('marketing')) return 'design';
  return 'generic';
}

async function pickUniqueKey(
  prisma: PrismaClient | PrismaService,
  jiraKey: string,
): Promise<string> {
  const base = jiraKey.replace(/[^A-Z]/gi, '').toUpperCase().slice(0, 10) || 'PROJ';
  let candidate = base.length >= 2 ? base : `${base}X`;
  let n = 0;
  while (await prisma.project.findUnique({ where: { key: candidate } })) {
    n++;
    const suffix = String(n);
    candidate = base.slice(0, Math.max(2, 10 - suffix.length)) + suffix;
    // internal: not reached from an HTTP request — pure helper called from background executeRun; caught + logged.
    if (n > 99) throw new Error(`Could not derive a unique key from ${jiraKey}`);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// ADF → Markdown (subset of the CLI's converter — the same node types covered).
// ---------------------------------------------------------------------------

type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
};

function adfToMarkdown(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const n = node as AdfNode;
  if (!n.type) return (n.content ?? []).map(adfToMarkdown).join('');
  switch (n.type) {
    case 'doc':
      return (n.content ?? []).map(adfToMarkdown).join('\n\n').trim();
    case 'paragraph':
      return (n.content ?? []).map(adfToMarkdown).join('');
    case 'text': {
      let text = n.text ?? '';
      for (const mark of n.marks ?? []) {
        switch (mark.type) {
          case 'strong':
            text = `**${text}**`;
            break;
          case 'em':
            text = `*${text}*`;
            break;
          case 'code':
            text = `\`${text}\``;
            break;
          case 'link':
            text = `[${text}](${mark.attrs?.['href'] ?? ''})`;
            break;
        }
      }
      return text;
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.['level'] ?? 1)));
      return '#'.repeat(level) + ' ' + (n.content ?? []).map(adfToMarkdown).join('');
    }
    case 'bulletList':
      return (n.content ?? []).map((item) => '- ' + adfToMarkdown(item).trimStart()).join('\n');
    case 'orderedList':
      return (n.content ?? [])
        .map((item, i) => `${i + 1}. ` + adfToMarkdown(item).trimStart())
        .join('\n');
    case 'listItem':
      return (n.content ?? []).map(adfToMarkdown).join('');
    case 'codeBlock':
      return (
        '```' +
        ((n.attrs?.['language'] as string) ?? '') +
        '\n' +
        (n.content ?? []).map(adfToMarkdown).join('') +
        '\n```'
      );
    case 'blockquote':
      return '> ' + (n.content ?? []).map(adfToMarkdown).join('\n> ');
    case 'rule':
      return '---';
    case 'hardBreak':
      return '\n';
    default:
      return (n.content ?? []).map(adfToMarkdown).join('');
  }
}
