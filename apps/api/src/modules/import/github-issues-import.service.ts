import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  type PrismaClient,
  type Priority,
  type TaskType,
  type WorkflowPreset,
} from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';
import { PrismaService } from '../../prisma/prisma.service';
import { GithubAppService } from '../github/github-app.service';
import { ImportRunsService } from './import-runs.service';

// =============================================================================
// GitHub Issues → Nockta importer service.
//
// Uses the GitHub App installation token flow already in place via
// GithubAppService.forInstallation(). The user picks an installation (a workspace
// admin has already linked the App once), then a repo. Issues are pulled with
// Octokit's paginate iterator and mapped:
//   - open / closed                       → Nockta status (engineering default)
//   - labels                              → Nockta Labels (label → label catalog)
//   - assignees[0]                        → assigneeUserId (matched by email
//                                            where the GitHub user has a public
//                                            email; otherwise fall back to admin).
//   - state_reason 'completed'/'reopened' → reflected in status mapping.
//
// PRs are intentionally skipped — Octokit's list endpoint returns both issues
// and PRs as "issues", and the github_issues table is dedicated to issues only.
// =============================================================================

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  private: boolean;
}

export interface GhStatusMapping {
  open?: string;
  closed?: string;
  /** GitHub state_reason — completed / reopened / not_planned. */
  not_planned?: string;
}

export interface GhImportMapping {
  preset?: WorkflowPreset;
  status?: GhStatusMapping;
  /** When true, also pull closed issues. Default: true (the most-asked behaviour
   *  is "give me everything"). */
  includeClosed?: boolean;
}

export interface GhPreviewRow {
  number: number;
  title: string;
  status: string;
  type: TaskType;
  assigneeLogin: string | null;
  labels: string[];
}

export interface GhImportPreview {
  totalIssues: number;
  preview: GhPreviewRow[];
}

export interface GhRunOptions {
  actorUserId: string;
  /** Destination project. Required for GH — the importer never creates a
   *  project on its own because GH repos don't have an obvious 1:1 with
   *  Nockta projects (a single repo could feed multiple teams). */
  projectId: string;
  dryRun?: boolean;
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason?: 'completed' | 'reopened' | 'not_planned' | null;
  user: { login: string; email?: string | null } | null;
  assignee: { login: string; email?: string | null } | null;
  assignees: Array<{ login: string; email?: string | null }>;
  labels: Array<{ name: string; color: string } | string>;
  pull_request?: object;
  created_at: string;
  closed_at: string | null;
}

@Injectable()
export class GithubIssuesImportService {
  private readonly logger = new Logger(GithubIssuesImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: ImportRunsService,
    private readonly githubApp: GithubAppService,
  ) {}

  /** List repos visible to the supplied installation. Used by the UI to
   *  render the repo picker after the user selects an installation. */
  async listRepos(installationId: number): Promise<GhRepo[]> {
    if (!installationId) throw new BadRequestException('Missing installationId');
    const octo = await this.githubApp.forInstallation(installationId);
    if (!octo) throw new BadRequestException('GitHub App not configured on this server');
    const repos: GhRepo[] = [];
    // octokit returns up to 100 per page; we cap at 500 — admins migrating
    // hundreds of repos at once should use the CLI, not the UI flow.
    let page = 1;
    for (;;) {
      const resp = await octo.apps.listReposAccessibleToInstallation({ per_page: 100, page });
      const body = resp.data as { repositories: Array<{
        id: number; name: string; full_name: string; private: boolean;
        owner: { login: string };
      }> };
      for (const r of body.repositories) {
        repos.push({
          id: r.id,
          name: r.name,
          full_name: r.full_name,
          owner: r.owner.login,
          private: r.private,
        });
      }
      if (body.repositories.length < 100 || repos.length >= 500) break;
      page += 1;
    }
    return repos;
  }

  async previewRepo(
    installationId: number,
    owner: string,
    repo: string,
    mapping: GhImportMapping,
  ): Promise<GhImportPreview> {
    if (!installationId || !owner || !repo) {
      throw new BadRequestException('Missing installationId/owner/repo');
    }
    const octo = await this.githubApp.forInstallation(installationId);
    if (!octo) throw new BadRequestException('GitHub App not configured');
    const state: 'all' | 'open' = mapping.includeClosed === false ? 'open' : 'all';
    const resp = await octo.issues.listForRepo({ owner, repo, state, per_page: 20 });
    const issues = (resp.data as unknown as GhIssue[]).filter((i) => !i.pull_request);
    const preset = mapping.preset ?? 'engineering';
    const preview: GhPreviewRow[] = issues.slice(0, 20).map((iss) => ({
      number: iss.number,
      title: iss.title,
      status: mapState(iss.state, iss.state_reason ?? null, preset, mapping.status),
      type: 'Task' as TaskType,
      assigneeLogin: iss.assignee?.login ?? iss.assignees?.[0]?.login ?? null,
      labels: iss.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    }));
    return { totalIssues: preview.length, preview };
  }

  async runImport(
    installationId: number,
    owner: string,
    repo: string,
    mapping: GhImportMapping,
    options: GhRunOptions,
  ): Promise<{ runId: string }> {
    if (!installationId || !owner || !repo) {
      throw new BadRequestException('Missing installationId/owner/repo');
    }
    if (!options.projectId) throw new BadRequestException('Missing projectId');
    const runId = await this.runs.start({
      source: 'github_issues',
      actorUserId: options.actorUserId,
      projectId: options.projectId,
      sourceRef: `${owner}/${repo}`,
      mappingSnapshot: { owner, repo, mapping },
    });
    void this.executeRun(this.prisma, runId, installationId, owner, repo, mapping, options).catch(
      (err) => {
        this.logger.error({ err, runId }, 'github issues run failed');
        void this.runs.finish({
          runId,
          status: 'failed',
          errorSummary: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return { runId };
  }

  async executeRun(
    prisma: PrismaClient | PrismaService,
    runId: string,
    installationId: number,
    owner: string,
    repo: string,
    mapping: GhImportMapping,
    options: GhRunOptions,
  ): Promise<void> {
    const octo = await this.githubApp.forInstallation(installationId);
    if (!octo) throw new Error('GitHub App not configured');
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: options.projectId },
      select: { id: true, workflowPreset: true },
    });
    const preset = mapping.preset ?? project.workflowPreset;
    const admin = await prisma.user.findUniqueOrThrow({
      where: { id: options.actorUserId },
      select: { id: true },
    });

    // Page through all issues. Octokit's paginate API yields one issue at a
    // time, hiding cursor management.
    const state: 'all' | 'open' = mapping.includeClosed === false ? 'open' : 'all';
    const issues: GhIssue[] = [];
    for await (const resp of octo.paginate.iterator(octo.issues.listForRepo, {
      owner,
      repo,
      state,
      per_page: 100,
    })) {
      const page = resp.data as unknown as GhIssue[];
      for (const iss of page) {
        if (iss.pull_request) continue; // PRs come through this endpoint too — skip
        issues.push(iss);
      }
    }
    await this.runs.setTotal(runId, issues.length);

    if (options.dryRun) {
      if (issues.length > 0) await this.runs.increment(runId, 'skipped', issues.length);
      await this.runs.finish({ runId, status: 'succeeded' });
      return;
    }

    // Label catalog (per-project, upsert).
    const labelCache = new Map<string, string>();
    const ensureLabel = async (name: string, color: string): Promise<string> => {
      const cached = labelCache.get(name.toLowerCase());
      if (cached) return cached;
      const existing = await prisma.label.findUnique({
        where: { projectId_name: { projectId: project.id, name } },
        select: { id: true },
      });
      const id =
        existing?.id ??
        (
          await prisma.label.create({
            data: {
              projectId: project.id,
              name,
              color: (color ?? '').replace(/^#/, '').slice(0, 6).toUpperCase() || 'A78BFA',
            },
            select: { id: true },
          })
        ).id;
      labelCache.set(name.toLowerCase(), id);
      return id;
    };

    // Assignee resolution by GitHub login → email is best-effort. GH only
    // returns the public email when the user has opted in; otherwise we fall
    // back to admin so the FK is satisfied. Future work: link via the
    // GitHub user → Nockta user mapping table.
    const userCache = new Map<string, string>();
    const resolveLogin = async (login: string | null | undefined): Promise<string> => {
      if (!login) return admin.id;
      const cached = userCache.get(login);
      if (cached) return cached;
      try {
        const u = await octo.users.getByUsername({ username: login });
        const email = (u.data as { email?: string | null }).email?.toLowerCase();
        if (email) {
          const dbUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
          if (dbUser) {
            userCache.set(login, dbUser.id);
            return dbUser.id;
          }
        }
      } catch {
        /* fall through to admin */
      }
      userCache.set(login, admin.id);
      return admin.id;
    };

    // Reserve a contiguous range of keyNumbers.
    const bumped = await prisma.project.update({
      where: { id: project.id },
      data: { nextTaskNumber: { increment: issues.length } },
      select: { nextTaskNumber: true },
    });
    const firstKey = bumped.nextTaskNumber - issues.length;
    let position = generateKeyBetween(null, null);
    const errors: string[] = [];
    for (let i = 0; i < issues.length; i++) {
      const iss = issues[i]!;
      try {
        const assigneeId = await resolveLogin(iss.assignee?.login ?? iss.assignees?.[0]?.login ?? null);
        const task = await prisma.task.create({
          data: {
            projectId: project.id,
            keyNumber: firstKey + i,
            title: iss.title.slice(0, 240),
            description: iss.body ?? null,
            status: mapState(iss.state, iss.state_reason ?? null, preset, mapping.status),
            priority: 'Medium' as Priority,
            type: 'Task' as TaskType,
            visibility: 'internal',
            createdById: admin.id,
            reporterUserId: admin.id,
            assigneeUserId: assigneeId,
            boardPosition: position,
            createdAt: new Date(iss.created_at),
          },
          select: { id: true },
        });

        // Labels.
        const labelIds: string[] = [];
        for (const l of iss.labels) {
          const name = typeof l === 'string' ? l : l.name;
          const color = typeof l === 'string' ? 'A78BFA' : l.color;
          try {
            labelIds.push(await ensureLabel(name, color));
          } catch {
            /* skip bad label */
          }
        }
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
        if (errors.length < 10) errors.push(`#${iss.number}: ${(err as Error).message}`);
        await this.runs.increment(runId, 'errored');
      }
    }
    await this.runs.finish({
      runId,
      status: errors.length === issues.length && issues.length > 0 ? 'failed' : 'succeeded',
      errorSummary: errors.length > 0 ? errors.join('\n') : null,
    });
  }
}

// ---------------------------------------------------------------------------
// Mapping.
// ---------------------------------------------------------------------------

function mapState(
  state: 'open' | 'closed',
  reason: 'completed' | 'reopened' | 'not_planned' | null,
  preset: WorkflowPreset,
  overrides?: GhStatusMapping,
): string {
  if (state === 'open') {
    return overrides?.open ?? 'Todo';
  }
  if (reason === 'not_planned') return overrides?.not_planned ?? 'Done';
  return overrides?.closed ?? (preset === 'design' ? 'Done' : 'Done');
}
