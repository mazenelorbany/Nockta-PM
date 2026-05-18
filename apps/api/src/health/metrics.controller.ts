import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { collectDefaultMetrics, Counter, Histogram, register } from 'prom-client';

import { Public } from '../modules/auth/decorators/public.decorator';

// Default Node metrics (event loop lag, heap, GC, etc) — register once at
// import time so re-importing this module under hot-reload doesn't double up.
collectDefaultMetrics({ register });

/**
 * HTTP request counters / histograms. Exported so the global request-context
 * interceptor (which fires on every controller request) can update them.
 * Using `getSingleMetric()`-style guards keeps this safe under dev HMR.
 */
function ensureCounter(name: string, help: string, labels: string[]): Counter<string> {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Counter<string>;
  return new Counter({ name, help, labelNames: labels });
}

function ensureHistogram(name: string, help: string, labels: string[], buckets: number[]): Histogram<string> {
  const existing = register.getSingleMetric(name);
  if (existing) return existing as Histogram<string>;
  return new Histogram({ name, help, labelNames: labels, buckets });
}

export const httpRequestsTotal = ensureCounter(
  'nockta_http_requests_total',
  'Total HTTP requests, partitioned by route, method, and status code',
  ['method', 'route', 'status'],
);

export const httpRequestDurationSeconds = ensureHistogram(
  'nockta_http_request_duration_seconds',
  'HTTP request latency histogram in seconds',
  ['method', 'route', 'status'],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);

/**
 * Scheduler-lock acquisition counter — incremented by SchedulerLockService
 * with `outcome` in {acquired, busy, error}. The Grafana scheduler-lock
 * dashboard reads `rate(nockta_scheduler_lock_acquisitions_total{outcome="busy"}[5m])`
 * to spot contention spikes (one replica getting starved consistently).
 */
export const schedulerLockAcquisitions = ensureCounter(
  'nockta_scheduler_lock_acquisitions_total',
  'Scheduler-lock acquisition attempts',
  ['lock_key', 'outcome'],
);

/**
 * AI processor run counter. `processor` ∈ {embed, duplicate, blocker,
 * prioritize, summarize, pr_summary}; `outcome` ∈ {success, failure, skip}.
 * Lets us alert on a sudden drop in `success` rate without scraping logs.
 */
export const aiProcessorRuns = ensureCounter(
  'nockta_ai_processor_runs_total',
  'AI processor job outcomes',
  ['processor', 'outcome'],
);

/**
 * Attachment-purge counter. `outcome` ∈ {purged, storage_failed, db_failed}.
 * If `storage_failed` rises while `purged` stalls, S3 is unhappy and the
 * scheduled cleanup is losing ground.
 */
export const attachmentPurgeOps = ensureCounter(
  'nockta_attachment_purge_total',
  'Attachment hard-delete outcomes from the maintenance cron',
  ['outcome'],
);

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  /**
   * Prometheus scrape endpoint. Public — protect via network ACL in prod
   * (e.g. only allow internal cluster pods to hit it) rather than auth, so
   * the Prometheus pod doesn't need a JWT.
   */
  @Public()
  @Get()
  @Header('Content-Type', register.contentType)
  async metrics(): Promise<string> {
    return register.metrics();
  }
}
