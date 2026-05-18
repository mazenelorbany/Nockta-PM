import { Injectable } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';

interface ResolvedRecipient {
  userId: string;
  reason:
    | 'assigned'
    | 'watching'
    | 'reporter'
    | 'mentioned'
    | 'team_mentioned'
    | 'project_manager';
}

@Injectable()
export class RecipientResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(eventName: string, payload: Record<string, unknown>): Promise<ResolvedRecipient[]> {
    switch (eventName) {
      case 'task.assigned': {
        const userId = payload['assigneeUserId'] as string | undefined;
        return userId ? [{ userId, reason: 'assigned' }] : [];
      }

      case 'task.updated':
      case 'task.status_changed':
      case 'task.unblocked': {
        const taskId = payload['taskId'] as string | undefined;
        if (!taskId) return [];
        const watchers = await this.prisma.taskWatcher.findMany({
          where: { taskId },
          select: { userId: true },
        });
        const actorUserId = payload['actorUserId'] as string | undefined;
        return watchers
          .filter((w) => w.userId !== actorUserId)
          .map((w) => ({ userId: w.userId, reason: 'watching' as const }));
      }

      case 'task.blocked': {
        const taskId = payload['taskId'] as string | undefined;
        if (!taskId) return [];
        const task = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { reporterUserId: true, watchers: { select: { userId: true } } },
        });
        if (!task) return [];
        const actorUserId = payload['actorUserId'] as string | undefined;
        const set = new Map<string, ResolvedRecipient>();
        for (const w of task.watchers) {
          if (w.userId !== actorUserId) set.set(w.userId, { userId: w.userId, reason: 'watching' });
        }
        if (task.reporterUserId !== actorUserId) {
          set.set(task.reporterUserId, { userId: task.reporterUserId, reason: 'reporter' });
        }
        return [...set.values()];
      }

      case 'comment.added': {
        const taskId = payload['taskId'] as string | undefined;
        if (!taskId) return [];
        const authorUserId = payload['authorUserId'] as string | undefined;
        const mentions = (payload['mentions'] ?? {}) as { userIds?: string[]; teamIds?: string[] };
        const watchers = await this.prisma.taskWatcher.findMany({
          where: { taskId },
          select: { userId: true },
        });
        const teamMembers =
          mentions.teamIds && mentions.teamIds.length > 0
            ? await this.prisma.teamMember.findMany({
                where: { teamId: { in: mentions.teamIds } },
                select: { userId: true },
              })
            : [];
        const recipients = new Map<string, ResolvedRecipient>();
        for (const w of watchers) {
          if (w.userId !== authorUserId) recipients.set(w.userId, { userId: w.userId, reason: 'watching' });
        }
        for (const uid of mentions.userIds ?? []) {
          if (uid !== authorUserId) recipients.set(uid, { userId: uid, reason: 'mentioned' });
        }
        for (const tm of teamMembers) {
          if (tm.userId !== authorUserId && !recipients.has(tm.userId)) {
            recipients.set(tm.userId, { userId: tm.userId, reason: 'team_mentioned' });
          }
        }
        return [...recipients.values()];
      }

      case 'sprint.started':
      case 'sprint.completed':
      case 'client.reported_bug':
      case 'deploy.failed':
      case 'deploy.succeeded':
      case 'deploy.rolled_back': {
        const projectId = payload['projectId'] as string | undefined;
        if (!projectId) return [];
        return this.projectManagers(projectId);
      }

      default:
        return [];
    }
  }

  private async projectManagers(projectId: string): Promise<ResolvedRecipient[]> {
    const grants = await this.prisma.projectAccess.findMany({
      where: { projectId, role: 'Manager' },
      select: { userId: true, teamId: true },
    });
    const userIds = new Set<string>();
    for (const g of grants) {
      if (g.userId) {
        userIds.add(g.userId);
      } else if (g.teamId) {
        const members = await this.prisma.teamMember.findMany({
          where: { teamId: g.teamId },
          select: { userId: true },
        });
        for (const m of members) userIds.add(m.userId);
      }
    }
    // Add Admins implicitly — they always see Manager-level project activity.
    const admins = await this.prisma.user.findMany({
      where: { kind: 'internal', companyRole: 'Admin', archivedAt: null },
      select: { id: true },
    });
    for (const a of admins) userIds.add(a.id);
    return [...userIds].map((userId) => ({ userId, reason: 'project_manager' as const }));
  }
}
