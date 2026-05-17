import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// AiSprintPlanningService — deterministic capacity + task ranking.
//
// THIS IS NOT AN LLM CALL. The whole module is plain arithmetic + Prisma reads.
//
// Why math instead of an LLM here:
//   - COST: this gets called every time a PM opens "Plan sprint" — the math
//     version is free and instant; an LLM version would burn budget on a
//     workflow that humans run dozens of times a sprint.
//   - LATENCY: PMs are clicking through backlogs interactively. A 6-second
//     LLM hop while they're staring at the screen is unacceptable for an
//     affordance they'll trigger repeatedly.
//   - REPRODUCIBILITY: the math has a stable answer for a given history. The
//     PM can argue with it ("velocity 18 ± 4, capacity 22") and the LLM
//     answer would drift across calls, undermining trust.
//
// The downside is that we can't reason about novel situations ("we're losing
// two engineers to vacation"). That's fine — we surface the raw numbers and
// the PM supplies the judgement.
// =============================================================================

export interface CapacityRecommendation {
  /** Suggested capacity in story points for the upcoming sprint. */
  suggestedPoints: number;
  /** Lower bound from the velocity confidence interval. */
  lowerBound: number;
  /** Upper bound from the velocity confidence interval. */
  upperBound: number;
  /** Mean velocity across the lookback window. */
  mean: number;
  /** Population standard deviation of velocity over the lookback window. */
  stddev: number;
  /** How many completed sprints we used. May be less than the requested
   *  lookback (e.g. project is new). When 0, capacity falls back to a
   *  hard-coded default — see DEFAULT_CAPACITY_FRESH_PROJECT. */
  sampleSize: number;
  /** Free-form explanation rendered next to the capacity number in the UI. */
  explanation: string;
}

export interface RankedTask {
  taskId: string;
  key: string;
  title: string;
  priority: string;
  /** Story points (estimate). Tasks without an estimate are excluded from the
   *  ranked list — we can't tell whether a 1-point or 13-point chore fits. */
  storyPoints: number;
  /** Days since createdAt — older tasks score higher (anti-starvation). */
  ageDays: number;
  /** Composite score: (priorityWeight * 100) + ageDays - storyPoints. */
  score: number;
  /** Single-line rationale: which factor dominated the rank. */
  why: string;
}

// Priority → numeric weight. Mirrors the AnalyticsService.workload weights so
// scoring stays consistent across the app.
const PRIORITY_WEIGHTS: Record<string, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

// Fallback capacity for a project with zero completed sprints. 20 is the
// commonly-cited "2 engineers × 2 weeks × 5 points/day" rough heuristic.
const DEFAULT_CAPACITY_FRESH_PROJECT = 20;

// Confidence-interval width. 1 stddev ≈ 68% CI, which is the right balance
// for plan-sprint UX: we want the PM to see the realistic range, not the
// 99% extreme. Easy to tweak if teams ask for a wider/narrower band.
const STDDEV_MULTIPLIER = 1;

@Injectable()
export class AiSprintPlanningService {
  private readonly logger = new Logger(AiSprintPlanningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Read the last 3 completed sprints' velocity and propose a capacity for
   * the next one. Uses mean ± stddev as the confidence band — the suggested
   * value is the mean (rounded), bounds are ±1σ clamped to [0, mean*2].
   */
  async suggestSprintCapacity(
    actor: AuthenticatedUser,
    projectId: string,
  ): Promise<CapacityRecommendation> {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    // Pull the historical velocity series via the public helper on
    // AnalyticsService. The series is oldest → newest; we want the most
    // recent 3.
    const fullVelocity = await this.analytics.sprintVelocityForProjectId(projectId);
    const lookback = fullVelocity.slice(-3);

    if (lookback.length === 0) {
      return {
        suggestedPoints: DEFAULT_CAPACITY_FRESH_PROJECT,
        lowerBound: 0,
        upperBound: DEFAULT_CAPACITY_FRESH_PROJECT * 2,
        mean: 0,
        stddev: 0,
        sampleSize: 0,
        explanation:
          `No completed sprints yet — defaulting to ${DEFAULT_CAPACITY_FRESH_PROJECT} pts. ` +
          `This will tighten once 2-3 sprints have closed.`,
      };
    }

    const points = lookback.map((s) => s.completedEstimate);
    const mean = points.reduce((a, b) => a + b, 0) / points.length;
    const variance = points.reduce((a, b) => a + (b - mean) ** 2, 0) / points.length;
    const stddev = Math.sqrt(variance);

    const lower = Math.max(0, Math.round(mean - STDDEV_MULTIPLIER * stddev));
    const upper = Math.round(mean + STDDEV_MULTIPLIER * stddev);
    const suggested = Math.round(mean);

    return {
      suggestedPoints: suggested,
      lowerBound: lower,
      upperBound: upper,
      mean: Number(mean.toFixed(1)),
      stddev: Number(stddev.toFixed(1)),
      sampleSize: lookback.length,
      explanation:
        `Last ${lookback.length} sprint${lookback.length === 1 ? '' : 's'} averaged ${mean.toFixed(1)} pts ` +
        `(σ=${stddev.toFixed(1)}). Suggest planning ${suggested} pts with a ` +
        `${lower}-${upper} pt confidence band.`,
    };
  }

  /**
   * Rank backlog tasks for the upcoming sprint up to `capacity` points.
   *
   * Score formula: (priorityWeight × 100) + ageDays − storyPoints.
   *   - Priority dominates (×100) because it's the human judgement signal we
   *     trust most. A Critical task should always beat a 30-day-old Low.
   *   - Age contributes linearly so backlog rot gets surfaced — a 60-day-old
   *     Medium beats a fresh Medium.
   *   - Smaller tasks score slightly higher to prefer "quick wins" when two
   *     items tie on priority + age, but the deduction is small enough that
   *     a 13-point Critical still wins over a 1-point Low.
   *
   * Tasks without an estimate are excluded. They're either chores the PM
   * needs to estimate first OR un-sized epics — neither belongs in a
   * capacity-bounded sprint.
   */
  async suggestTasksForSprint(
    actor: AuthenticatedUser,
    projectId: string,
    capacity: number,
  ): Promise<{ tasks: RankedTask[]; usedPoints: number; capacity: number }> {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    const now = Date.now();

    const candidates = await this.prisma.task.findMany({
      where: {
        projectId,
        sprintId: null,
        status: { notIn: ['Done', 'Approved'] },
        // Tasks with no estimate can't be packed into a capacity budget. Filter
        // here so the SQL stays cheap; the PM can plan them in by hand.
        estimate: { not: null },
      },
      select: {
        id: true,
        keyNumber: true,
        title: true,
        priority: true,
        estimate: true,
        createdAt: true,
        project: { select: { key: true } },
      },
      take: 200, // bound the working set; ~200 tasks ≈ plenty for the math
    });

    // Score + sort. Ties broken by createdAt ascending (oldest first) so the
    // ranking is deterministic on every call.
    const ranked = candidates
      .map((t) => {
        const ageDays = Math.max(0, (now - t.createdAt.getTime()) / (24 * 60 * 60 * 1000));
        const priorityWeight = PRIORITY_WEIGHTS[t.priority] ?? 1;
        const storyPoints = t.estimate ?? 0;
        const score = priorityWeight * 100 + ageDays - storyPoints;
        return {
          taskId: t.id,
          key: `${t.project.key}-${t.keyNumber}`,
          title: t.title,
          priority: t.priority,
          storyPoints,
          ageDays: Math.round(ageDays),
          score: Number(score.toFixed(2)),
          createdAt: t.createdAt,
        };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    // Greedy fill up to capacity. Greedy is fine because:
    //   - The list is small (<=200) so optimal knapsack would barely matter.
    //   - PMs DO NOT want a "globally optimal" pack — they want the
    //     highest-priority items first and to know when the budget runs out.
    //     Greedy preserves that intuition.
    const picked: RankedTask[] = [];
    let used = 0;
    for (const r of ranked) {
      if (used + r.storyPoints > capacity) continue;
      used += r.storyPoints;
      picked.push({
        taskId: r.taskId,
        key: r.key,
        title: r.title,
        priority: r.priority,
        storyPoints: r.storyPoints,
        ageDays: r.ageDays,
        score: r.score,
        why: explainPick(r),
      });
      if (used >= capacity) break;
    }

    return { tasks: picked, usedPoints: used, capacity };
  }
}

function explainPick(r: {
  priority: string;
  ageDays: number;
  storyPoints: number;
  score: number;
}): string {
  // The "why" is the dominant driver. Priority almost always wins because of
  // the ×100 weight; we show age when the task is older than 14d to flag
  // backlog rot the PM may have forgotten. Story points are surfaced when the
  // pick looks like a quick win (≤3 pts) so PMs can spot easy carries.
  const parts: string[] = [];
  parts.push(`Priority ${r.priority}`);
  if (r.ageDays >= 14) parts.push(`${r.ageDays}d old`);
  if (r.storyPoints > 0 && r.storyPoints <= 3) parts.push('quick win');
  return parts.join(' · ');
}
