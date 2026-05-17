import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { WorkflowPreset } from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';
import { PrismaService } from '../../prisma/prisma.service';

type Trigger = 'commit_pushed' | 'pr_opened' | 'pr_ready_for_review' | 'pr_merged' | 'pr_reopened';

interface Transition {
  fromStatuses: string[];
  toStatus: string;
}

/**
 * Per-preset auto-status state machines. When `githubAutoStatus=true` on a
 * project we map GitHub events to status transitions using the preset's own
 * status vocabulary:
 *
 *   - engineering: Todo → In Progress → In Review → Testing → Done
 *     (PR merged lands in Testing — implementation done but not yet QA'd).
 *   - design: Todo → In Progress → In Review → Approved → Done
 *     (no separate testing column; PR merged moves to In Review since
 *     design "merged" usually means "shipped to staging for sign-off".)
 *   - generic: Todo → In Progress → Done
 *     (single transition surface; PR merged lands in Done directly. Commit
 *     pushed bumps Todo → In Progress.)
 *
 * For triggers that don't have a sensible mapping in a given preset (e.g.
 * `pr_ready_for_review` on generic, which lacks an In Review column), the
 * transition is omitted — the code below short-circuits on a missing entry.
 */
const TRANSITIONS_BY_PRESET: Record<WorkflowPreset, Partial<Record<Trigger, Transition>>> = {
  engineering: {
    commit_pushed:        { fromStatuses: ['Todo'],                       toStatus: 'In Progress' },
    pr_opened:            { fromStatuses: ['Todo', 'In Progress'],        toStatus: 'In Review'   },
    pr_ready_for_review:  { fromStatuses: ['Todo', 'In Progress'],        toStatus: 'In Review'   },
    pr_merged:            { fromStatuses: ['In Review', 'In Progress'],   toStatus: 'Testing'     },
    pr_reopened:          { fromStatuses: ['In Progress'],                toStatus: 'In Review'   },
  },
  design: {
    commit_pushed:        { fromStatuses: ['Todo'],                       toStatus: 'In Progress' },
    pr_opened:            { fromStatuses: ['Todo', 'In Progress'],        toStatus: 'In Review'   },
    pr_ready_for_review:  { fromStatuses: ['Todo', 'In Progress'],        toStatus: 'In Review'   },
    // Design has no Testing column; PR merged is "shipped to staging for
    // visual sign-off" which fits In Review better than Approved (approval
    // is a human gate, not a deploy event).
    pr_merged:            { fromStatuses: ['In Progress', 'Todo'],        toStatus: 'In Review'   },
    pr_reopened:          { fromStatuses: ['Approved'],                   toStatus: 'In Review'   },
  },
  generic: {
    // Only two non-terminal states; pr_ready_for_review has no meaningful
    // mapping (there's no In Review column). Omitted entries are no-ops.
    commit_pushed:        { fromStatuses: ['Todo'],                       toStatus: 'In Progress' },
    pr_opened:            { fromStatuses: ['Todo'],                       toStatus: 'In Progress' },
    pr_merged:            { fromStatuses: ['In Progress', 'Todo'],        toStatus: 'Done'        },
  },
};

@Injectable()
export class AutoStatusService {
  private readonly logger = new Logger(AutoStatusService.name);

  constructor(private readonly prisma: PrismaService, private readonly events: EventEmitter2) {}

  async applyTransition(taskId: string, trigger: Trigger): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { select: { workflowPreset: true, githubAutoStatus: true } } },
    });
    if (!task) return;
    if (!task.project.githubAutoStatus) return;
    const preset = task.project.workflowPreset;
    const transition = TRANSITIONS_BY_PRESET[preset][trigger];
    if (!transition) return; // preset-trigger combination has no mapping
    if (!transition.fromStatuses.includes(task.status)) return; // compatible-state-only
    if (task.status === transition.toStatus) return;            // no-op

    // Move to bottom of destination column on the board.
    const last = await this.prisma.task.findFirst({
      where: { projectId: task.projectId, status: transition.toStatus },
      orderBy: { boardPosition: 'desc' },
      select: { boardPosition: true },
    });
    const boardPosition = generateKeyBetween(last?.boardPosition ?? null, null);

    const previous = task.status;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: transition.toStatus, boardPosition },
    });
    this.events.emit('task.status_changed', {
      taskId,
      projectId: task.projectId,
      fromStatus: previous,
      toStatus: transition.toStatus,
      triggeredBy: 'github',
      actorUserId: null,
    });
    this.logger.log(`auto-status: ${task.id} ${previous} → ${transition.toStatus} via ${trigger}`);
  }
}
