import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';

import { AI_SUMMARIZE_QUEUE } from '../ai/ai.queues';
import { PrismaService } from '../../prisma/prisma.service';

import { GithubAppService } from './github-app.service';
import { AutoStatusService } from './auto-status.service';
import { parseTaskKeys } from './task-key-parser';

interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  githubRepoId: number;
}

interface InstallationRef {
  installationId: number;
}

@Injectable()
export class GithubEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoStatus: AutoStatusService,
    private readonly github: GithubAppService,
    private readonly events: EventEmitter2,
    @InjectQueue(AI_SUMMARIZE_QUEUE) private readonly summarizeQueue: Queue,
  ) {}

  // ----- installation lifecycle -----

  async onInstallationCreated(input: InstallationRef & { accountLogin: string; accountType: string; repositories?: RepoRef[] }) {
    const installation = await this.prisma.githubInstallation.upsert({
      where: { installationId: BigInt(input.installationId) },
      update: { accountLogin: input.accountLogin, accountType: input.accountType, suspendedAt: null },
      create: {
        installationId: BigInt(input.installationId),
        accountLogin: input.accountLogin,
        accountType: input.accountType,
      },
    });
    for (const r of input.repositories ?? []) {
      await this.prisma.githubRepo.upsert({
        where: { githubRepoId: BigInt(r.githubRepoId) },
        update: { owner: r.owner, name: r.name, fullName: r.fullName, archived: false },
        create: {
          installationId: installation.id,
          githubRepoId: BigInt(r.githubRepoId),
          owner: r.owner,
          name: r.name,
          fullName: r.fullName,
        },
      });
    }
    this.events.emit('github.app_installed', { installationId: String(input.installationId) });
  }

  async onInstallationSuspended(installationId: number) {
    await this.prisma.githubInstallation.updateMany({
      where: { installationId: BigInt(installationId) },
      data: { suspendedAt: new Date() },
    });
  }

  async onInstallationDeleted(installationId: number) {
    await this.prisma.githubInstallation.deleteMany({
      where: { installationId: BigInt(installationId) },
    });
    this.events.emit('github.app_uninstalled', { installationId: String(installationId) });
  }

  // ----- push events: link commits -----

  async onPush(input: {
    installation: InstallationRef;
    repo: RepoRef;
    branch: string;
    commits: { sha: string; message: string; authorName?: string; authorLogin?: string }[];
  }) {
    for (const commit of input.commits) {
      const keys = parseTaskKeys(commit.message, input.branch);
      if (keys.length === 0) continue;
      const tasks = await this.resolveTasks(keys);
      for (const task of tasks) {
        const existing = await this.prisma.taskGithubLink.findFirst({
          where: { taskId: task.id, kind: 'commit', commitSha: commit.sha },
        });
        if (existing) continue;
        await this.prisma.taskGithubLink.create({
          data: {
            taskId: task.id,
            kind: 'commit',
            repoFullName: input.repo.fullName,
            commitSha: commit.sha,
            ...(commit.authorLogin ? { authorLogin: commit.authorLogin } : {}),
            metadata: { message: commit.message, branch: input.branch } as Prisma.JsonObject,
          },
        });
        this.events.emit('github.commit_linked', {
          taskId: task.id,
          projectId: task.projectId,
          commitSha: commit.sha,
          repo: input.repo.fullName,
          branch: input.branch,
        });
        await this.autoStatus.applyTransition(task.id, 'commit_pushed');
      }
    }
  }

  // ----- pull_request events -----

  async onPullRequest(input: {
    installation: InstallationRef;
    repo: RepoRef;
    action: 'opened' | 'reopened' | 'closed' | 'ready_for_review' | 'edited' | 'synchronize';
    pr: {
      number: number;
      title: string;
      body: string | null;
      branchName: string;
      draft: boolean;
      merged: boolean;
      state: 'open' | 'closed';
      url: string;
      authorLogin: string;
    };
  }) {
    const keys = parseTaskKeys(input.pr.title, input.pr.body, input.pr.branchName);
    const tasks = await this.resolveTasks(keys);
    if (tasks.length === 0) return;

    // Compute the action's "kind" for state machine + persistence.
    const prState = input.pr.merged
      ? 'merged'
      : input.pr.draft
      ? 'draft'
      : input.pr.state;

    for (const task of tasks) {
      const link = await this.prisma.taskGithubLink.upsert({
        where: {
          // No native unique index for (taskId, prNumber, repoFullName) — use findFirst + create.
          id: (await this.prisma.taskGithubLink.findFirst({
            where: { taskId: task.id, prNumber: input.pr.number, repoFullName: input.repo.fullName },
            select: { id: true },
          }))?.id ?? '00000000-0000-0000-0000-000000000000',
        },
        update: {
          prState,
          prTitle: input.pr.title,
          prUrl: input.pr.url,
          authorLogin: input.pr.authorLogin,
        },
        create: {
          taskId: task.id,
          kind: 'pr',
          repoFullName: input.repo.fullName,
          prNumber: input.pr.number,
          prTitle: input.pr.title,
          prUrl: input.pr.url,
          prState,
          authorLogin: input.pr.authorLogin,
        },
      });

      const isFirstLink = !link.id || link.id === '00000000-0000-0000-0000-000000000000';

      // Auto-status transitions
      if (input.action === 'opened' && !input.pr.draft) {
        await this.autoStatus.applyTransition(task.id, 'pr_opened');
        this.events.emit('github.pr_linked', { taskId: task.id, projectId: task.projectId, prNumber: input.pr.number, repo: input.repo.fullName });
      } else if (input.action === 'ready_for_review') {
        await this.autoStatus.applyTransition(task.id, 'pr_ready_for_review');
      } else if (input.action === 'closed' && input.pr.merged) {
        await this.autoStatus.applyTransition(task.id, 'pr_merged');
        this.events.emit('github.pr_merged', { taskId: task.id, projectId: task.projectId, prNumber: input.pr.number, repo: input.repo.fullName });
        // Fire-and-forget: AI summarization comment on the linked task. The
        // SummarizeProcessor in apps/api/src/modules/ai already handles
        // `kind: 'pr'` jobs by generating a comment via the LLM.
        await this.summarizeQueue.add(
          'pr',
          {
            kind: 'pr',
            taskId: task.id,
            prTitle: input.pr.title,
            prBody: input.pr.body ?? null,
            prUrl: input.pr.url,
          },
          { removeOnComplete: 100, removeOnFail: 200, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
        ).catch(() => undefined);
      } else if (input.action === 'closed' && !input.pr.merged) {
        // log + banner — no auto-revert (spec §13)
        this.events.emit('github.pr_closed', { taskId: task.id, projectId: task.projectId, prNumber: input.pr.number, repo: input.repo.fullName });
      } else if (input.action === 'reopened') {
        await this.autoStatus.applyTransition(task.id, 'pr_reopened');
      }

      // Best-effort PR comment on first link
      if (isFirstLink && input.action === 'opened') {
        await this.github.commentOnPullRequest({
          installationId: input.installation.installationId,
          owner: input.repo.owner,
          repo: input.repo.name,
          prNumber: input.pr.number,
          body: `🔗 Linked to Nockta Flow task **${task.key}**.`,
        });
      }
    }
  }

  // ----- helpers -----

  private async resolveTasks(parsedKeys: { projectKey: string; keyNumber: number; key: string }[]) {
    const out: { id: string; key: string; projectId: string }[] = [];
    if (parsedKeys.length === 0) return out;
    // Group by projectKey for fewer queries
    const byProject = new Map<string, Set<number>>();
    for (const k of parsedKeys) {
      if (!byProject.has(k.projectKey)) byProject.set(k.projectKey, new Set());
      byProject.get(k.projectKey)!.add(k.keyNumber);
    }
    for (const [projectKey, numbers] of byProject) {
      const project = await this.prisma.project.findUnique({
        where: { key: projectKey },
        select: { id: true, key: true, archivedAt: true },
      });
      if (!project || project.archivedAt) continue;
      const tasks = await this.prisma.task.findMany({
        where: { projectId: project.id, keyNumber: { in: [...numbers] } },
        select: { id: true, keyNumber: true, projectId: true },
      });
      for (const t of tasks) {
        out.push({ id: t.id, key: `${project.key}-${t.keyNumber}`, projectId: t.projectId });
      }
    }
    return out;
  }
}
