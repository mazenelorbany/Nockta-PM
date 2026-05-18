import { Injectable } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// ClientService — read-only, guest-scoped helpers behind the /client/*
// endpoints. Every method is *defensively* scoped to projects the guest has
// an explicit ProjectAccess(role=Client) grant on; we never trust query
// params to limit access (consistency with the rest of the codebase, where
// the controller layer auth guards already gate the route but the service
// re-asserts scope on every query).
// =============================================================================

export type ActivityKind = 'comment' | 'status' | 'deploy';

export interface ActivityItem {
  kind: ActivityKind;
  /** Stable composite id so the React list can key on it without collisions. */
  id: string;
  at: string;
  /** Human one-liner ready for direct render. Backend pre-builds the copy
   *  so the frontend doesn't have to special-case every event shape. */
  summary: string;
  /** Linkable destinations the frontend can route to. Either a task or a
   *  project — never both. */
  link: { kind: 'task'; projectId: string; taskId: string } | { kind: 'project'; projectId: string };
}

@Injectable()
export class ClientService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The set of (projectId, defaultTaskVisibility) tuples the client can see.
   * Used as the universe for every subsequent filter — every activity item
   * and every bug must live on one of these projects.
   */
  private async accessibleProjects(actor: AuthenticatedUser): Promise<
    { id: string; defaultTaskVisibility: 'internal' | 'client_visible' }[]
  > {
    const projects = await this.prisma.project.findMany({
      where: {
        archivedAt: null,
        accessGrants: { some: { userId: actor.id, role: 'Client', subjectKind: 'user' } },
      },
      select: { id: true, defaultTaskVisibility: true },
    });
    return projects.map((p) => ({
      id: p.id,
      defaultTaskVisibility: p.defaultTaskVisibility as 'internal' | 'client_visible',
    }));
  }

  /**
   * Build a single date-sorted activity feed by union-ing three sources.
   * Each source applies its own visibility filter; we over-fetch slightly
   * (3 * limit per source) so the final union has plenty of headroom even
   * if one source is noisy.
   */
  async activity(
    actor: AuthenticatedUser,
    { limit }: { limit: number },
  ): Promise<ActivityItem[]> {
    const projects = await this.accessibleProjects(actor);
    if (projects.length === 0) return [];

    const visibleAllIds = projects.map((p) => p.id);
    // Projects where the whole scope is shared — the visibility filter on
    // tasks gets relaxed to "any task in the project".
    const openIds = projects.filter((p) => p.defaultTaskVisibility === 'client_visible').map((p) => p.id);
    // Projects in default-internal mode — we still see tasks explicitly
    // tagged client_visible, but no other internal tasks.
    const strictIds = projects.filter((p) => p.defaultTaskVisibility === 'internal').map((p) => p.id);

    const overFetch = limit * 3;

    // --- Source A: comments by the team on tasks the client can see -------
    // We narrow by the same predicate the task list uses: either the
    // project default is client_visible, OR the task itself is tagged
    // client_visible. Comment author kind=internal so the client doesn't
    // see their own comments echoed back.
    // Build the per-task visibility OR — Prisma errors on `OR: []`, so we
    // short-circuit to a no-match constraint when both buckets are empty
    // (shouldn't happen given the early return above, but defensive).
    const taskClause: Array<{ projectId: { in: string[] }; visibility?: 'client_visible' }> = [];
    if (openIds.length > 0) taskClause.push({ projectId: { in: openIds } });
    if (strictIds.length > 0) taskClause.push({ projectId: { in: strictIds }, visibility: 'client_visible' });

    const comments = taskClause.length === 0 ? [] : await this.prisma.comment.findMany({
      where: {
        deletedAt: null,
        author: { kind: 'internal' },
        // Only client-visible comments — never expose internal team chatter.
        visibility: 'client_visible',
        task: { OR: taskClause },
      },
      orderBy: { createdAt: 'desc' },
      take: overFetch,
      select: {
        id: true,
        bodyMd: true,
        createdAt: true,
        author: { select: { name: true } },
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            keyNumber: true,
            project: { select: { key: true } },
          },
        },
      },
    });

    // --- Source B: status changes on tasks they reported -----------------
    // `reportedByClient=true` is the proxy for "this is THEIR bug" — using
    // the actual reporterUserId would be slightly more accurate but the
    // existing project page already uses this flag for "Reported by you",
    // so we stay consistent.
    const reportedTasks = await this.prisma.task.findMany({
      where: {
        projectId: { in: visibleAllIds },
        reportedByClient: true,
        reporterUserId: actor.id,
      },
      select: { id: true },
    });
    const reportedTaskIds = reportedTasks.map((t) => t.id);
    const statusEvents = reportedTaskIds.length > 0
      ? await this.prisma.event.findMany({
          where: {
            type: 'TaskStatusChanged',
            entityType: 'Task',
            entityId: { in: reportedTaskIds },
            visibility: 'public',
          },
          orderBy: { createdAt: 'desc' },
          take: overFetch,
          select: { id: true, entityId: true, projectId: true, payload: true, createdAt: true },
        })
      : [];
    // Hydrate task titles + project keys for the status-event lines. Keep
    // the same select shape as comments so the formatter is uniform.
    const statusTaskMap = statusEvents.length > 0
      ? new Map(
          (
            await this.prisma.task.findMany({
              where: { id: { in: statusEvents.map((e) => e.entityId) } },
              select: {
                id: true,
                title: true,
                projectId: true,
                keyNumber: true,
                project: { select: { key: true } },
              },
            })
          ).map((t) => [t.id, t]),
        )
      : new Map();

    // --- Source C: deployments on their projects -------------------------
    const deploys = await this.prisma.deployment.findMany({
      where: {
        projectId: { in: visibleAllIds },
        status: 'succeeded', // failed/in-progress deploys aren't useful to surface
      },
      orderBy: { startedAt: 'desc' },
      take: overFetch,
      select: {
        id: true,
        projectId: true,
        environment: true,
        startedAt: true,
        finishedAt: true,
        project: { select: { name: true } },
      },
    });

    // --- Merge + format --------------------------------------------------
    const items: ActivityItem[] = [];
    for (const c of comments) {
      const t = c.task;
      const snippet = c.bodyMd.length > 80 ? `${c.bodyMd.slice(0, 80).trim()}…` : c.bodyMd;
      items.push({
        kind: 'comment',
        id: `comment:${c.id}`,
        at: c.createdAt.toISOString(),
        summary: `${c.author.name} commented on ${t.project.key}-${t.keyNumber}: ${snippet}`,
        link: { kind: 'task', projectId: t.projectId, taskId: t.id },
      });
    }
    for (const e of statusEvents) {
      const t = statusTaskMap.get(e.entityId);
      if (!t) continue;
      const p = e.payload as Record<string, unknown>;
      const from = (p['fromStatus'] as string | undefined) ?? null;
      const to = (p['toStatus'] as string | undefined) ?? 'Updated';
      items.push({
        kind: 'status',
        id: `status:${e.id}`,
        at: e.createdAt.toISOString(),
        summary: from
          ? `${t.project.key}-${t.keyNumber} moved from ${from} to ${to}`
          : `${t.project.key}-${t.keyNumber} → ${to}`,
        link: { kind: 'task', projectId: t.projectId, taskId: t.id },
      });
    }
    for (const d of deploys) {
      items.push({
        kind: 'deploy',
        id: `deploy:${d.id}`,
        at: (d.finishedAt ?? d.startedAt).toISOString(),
        summary: `Deployment to ${d.environment} succeeded on ${d.project.name}`,
        link: { kind: 'project', projectId: d.projectId },
      });
    }

    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return items.slice(0, limit);
  }

  /**
   * Open bugs the client reported. Mirrors the task list query — we use the
   * actor.id as the reporter to avoid surfacing bugs filed by other clients
   * on the same project (rare, but possible if a project has multiple
   * guests granted access).
   */
  async myBugs(actor: AuthenticatedUser) {
    const projects = await this.accessibleProjects(actor);
    if (projects.length === 0) return [];
    const projectIds = projects.map((p) => p.id);

    const tasks = await this.prisma.task.findMany({
      where: {
        projectId: { in: projectIds },
        reportedByClient: true,
        reporterUserId: actor.id,
        status: { notIn: ['Done', 'Approved'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        createdAt: true,
        keyNumber: true,
        projectId: true,
        project: { select: { key: true, name: true } },
      },
    });

    return tasks.map((t) => ({
      id: t.id,
      key: `${t.project.key}-${t.keyNumber}`,
      title: t.title,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt.toISOString(),
      projectId: t.projectId,
      projectName: t.project.name,
    }));
  }
}
