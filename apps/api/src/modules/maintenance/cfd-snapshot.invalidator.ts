import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import type { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// CfdSnapshotInvalidator — drops today's CfdSnapshot rows for a project as
// soon as one of its tasks changes status. The next read of cumulativeFlow
// will recompute today live (it always does for the current day anyway), so
// we don't need to recompute eagerly — the simpler "delete + lazy-rebuild"
// path is enough and avoids a write storm during bursty board activity.
//
// Why only today's row (and not yesterday's)? The scheduler upserts
// yesterday's row once at 00:30 UTC. By the time it lands, yesterday is
// frozen — a backdated event would be a serious bug, not a normal flow.
// Today's row, on the other hand, doesn't exist as a snapshot until tomorrow
// — and analytics.cumulativeFlow already computes "today" live. So the
// invalidator's real job is just to make sure no stale today-row sneaks in
// from a future schema change or a manual seed; it's a belt-and-braces
// guard with negligible runtime cost.
// =============================================================================

@Injectable()
export class CfdSnapshotInvalidator {
  private readonly logger = new Logger(CfdSnapshotInvalidator.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent('task.status_changed', { async: true })
  async onTaskStatusChanged(payload: Record<string, unknown>): Promise<void> {
    const projectId = payload.projectId as string | undefined;
    if (!projectId) return;
    await this.invalidateToday(projectId);
  }

  /**
   * Delete every snapshot row for `projectId` dated today (UTC). Tomorrow's
   * 00:30 tick will re-snapshot yesterday (which IS today when the cron
   * fires) and the live-read path covers the rest.
   */
  private async invalidateToday(projectId: string): Promise<void> {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    try {
      const result = await this.prisma.cfdSnapshot.deleteMany({
        where: { projectId, date: today },
      });
      if (result.count > 0) {
        this.logger.debug(
          `Invalidated ${result.count} CFD snapshot row(s) for project ${projectId}`,
        );
      }
    } catch (err) {
      // Best-effort — don't break the status-change request path on an
      // invalidation hiccup. The next snapshot tick or read will heal it.
      this.logger.warn(
        `CFD invalidation failed for project ${projectId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
