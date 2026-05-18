import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// AiCostTrackingService — single owner of every LLM-cost row.
//
// Public surface:
//   - record({ kind, modelName, inputTokens, outputTokens, status?, userId? })
//     Writes one AiUsageEvent row, computing costUsdCents from the static
//     PRICE_TABLE below. Idempotently safe (no upsert key).
//
//   - currentMonthSpendCents(kind) — sum costUsdCents for the current
//     calendar month + given kind. Drives the processors' budget gate.
//
//   - summary({ since, until }) — daily aggregates for /ai/usage/summary.
//     Bucketed in SQL (date_trunc) so the dashboard stays O(window).
//
// Why a static price table (not env): Anthropic publishes per-1M-token
// pricing on a stable cadence and per-model. Keeping the table in code keeps
// it diff-reviewable and avoids a config-blast-radius bug. Update when prices
// change.
//
// Pricing as of 2026-05: Claude Sonnet ~$3/1M input, $15/1M output. Ollama is
// local — zero direct cost (we still record tokens so usage shows in the
// dashboard, but cost stays 0).
// =============================================================================

export type AiUsageKind =
  | 'duplicate'
  | 'prioritize'
  | 'summarize'
  | 'standup'
  | 'sprint_planning';

interface PriceEntry {
  /** USD cents per million input tokens. */
  inputCentsPerMTok: number;
  /** USD cents per million output tokens. */
  outputCentsPerMTok: number;
}

const PRICE_TABLE: Record<string, PriceEntry> = {
  // Anthropic — current published pricing for the Sonnet tier.
  'claude-sonnet-4-6': { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  'claude-sonnet-4-5': { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  'claude-3-5-sonnet-latest': { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 },
  // Ollama / local — zero direct cost. Keep tokens for usage volume tracking.
  'llama3.2': { inputCentsPerMTok: 0, outputCentsPerMTok: 0 },
  'nomic-embed-text': { inputCentsPerMTok: 0, outputCentsPerMTok: 0 },
};

const DEFAULT_PRICE: PriceEntry = { inputCentsPerMTok: 300, outputCentsPerMTok: 1500 };

export interface RecordUsageInput {
  kind: AiUsageKind;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  /** 'ok' (default), 'budget_exceeded', or 'error'. */
  status?: 'ok' | 'budget_exceeded' | 'error';
  userId?: string | null;
}

export interface DailySummaryPoint {
  /** ISO date (YYYY-MM-DD), UTC day buckets. */
  date: string;
  totalCostCents: number;
  byKind: Record<string, number>;
  byModel: Record<string, number>;
}

@Injectable()
export class AiCostTrackingService {
  private readonly logger = new Logger(AiCostTrackingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Compute USD cents from token counts. Rounded with `Math.round`; small
   *  per-call totals can be sub-cent so the dashboard sum is the truth, not
   *  any individual row. */
  computeCostCents(modelName: string, inputTokens: number, outputTokens: number): number {
    const price = PRICE_TABLE[modelName] ?? DEFAULT_PRICE;
    const inputCents = (inputTokens * price.inputCentsPerMTok) / 1_000_000;
    const outputCents = (outputTokens * price.outputCentsPerMTok) / 1_000_000;
    return Math.round(inputCents + outputCents);
  }

  /**
   * Persist one AiUsageEvent. Cost is computed at write time so a future
   * price-table change doesn't retroactively rewrite history.
   *
   * Failures here are logged but never thrown — we don't want a cost-tracking
   * outage to fail the caller's LLM call. The aggregate dashboard accepts
   * "missing rows on the metrics side" gracefully.
   */
  async record(input: RecordUsageInput): Promise<void> {
    const costUsdCents = this.computeCostCents(
      input.modelName,
      input.inputTokens,
      input.outputTokens,
    );
    try {
      await this.prisma.aiUsageEvent.create({
        data: {
          kind: input.kind,
          modelName: input.modelName,
          inputTokens: Math.max(0, Math.trunc(input.inputTokens)),
          outputTokens: Math.max(0, Math.trunc(input.outputTokens)),
          costUsdCents,
          status: input.status ?? 'ok',
          userId: input.userId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record AI usage (kind=${input.kind}, model=${input.modelName}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Sum costUsdCents for the current calendar month, optionally filtered to a
   * kind. Used by the processors' budget gate: when this exceeds the
   * configured monthlyBudgetUsdCents[kind], the processor short-circuits and
   * records a `budget_exceeded` row instead of calling the LLM.
   */
  async currentMonthSpendCents(kind?: AiUsageKind): Promise<number> {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const agg = await this.prisma.aiUsageEvent.aggregate({
      where: {
        createdAt: { gte: startOfMonth },
        status: 'ok',
        ...(kind ? { kind } : {}),
      },
      _sum: { costUsdCents: true },
    });
    return agg._sum.costUsdCents ?? 0;
  }

  /**
   * Daily aggregates over [since, until). Returns one DailySummaryPoint per
   * UTC day in the window (oldest → newest); days with no rows are returned
   * with `totalCostCents: 0` and empty by-key maps so the chart never has
   * holes.
   *
   * Buckets in SQL via date_trunc('day', ...) for O(rows) instead of pulling
   * every row back. The kind+model breakdown is folded client-side from a
   * second grouping query — small index hit, far less data than streaming
   * every row to the API.
   */
  async summary(opts: { since: Date; until: Date }): Promise<{
    days: DailySummaryPoint[];
    totalCostCents: number;
  }> {
    const since = opts.since;
    const until = opts.until;

    const rows = await this.prisma.$queryRaw<
      { day: Date; kind: string; modelName: string; cost: bigint }[]
    >(Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS day,
             "kind",
             "modelName",
             SUM("costUsdCents")::bigint AS cost
      FROM "AiUsageEvent"
      WHERE "createdAt" >= ${since}
        AND "createdAt" < ${until}
        AND status = 'ok'
      GROUP BY 1, 2, 3
      ORDER BY 1 ASC
    `);

    // Build the list of UTC day keys covering the window so the response has a
    // continuous date axis even when some days have zero spend.
    const days: DailySummaryPoint[] = [];
    const startUtc = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
    const endUtc = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()));
    for (let t = startUtc.getTime(); t < endUtc.getTime() + 1; t += 24 * 60 * 60 * 1000) {
      const d = new Date(t);
      days.push({
        date: d.toISOString().slice(0, 10),
        totalCostCents: 0,
        byKind: {},
        byModel: {},
      });
    }
    const byIso = new Map(days.map((d, i) => [d.date, i] as const));

    let total = 0;
    for (const r of rows) {
      const iso = r.day.toISOString().slice(0, 10);
      const idx = byIso.get(iso);
      if (idx === undefined) continue;
      const point = days[idx]!;
      const cost = Number(r.cost);
      point.totalCostCents += cost;
      point.byKind[r.kind] = (point.byKind[r.kind] ?? 0) + cost;
      point.byModel[r.modelName] = (point.byModel[r.modelName] ?? 0) + cost;
      total += cost;
    }

    return { days, totalCostCents: total };
  }
}
