import type {
  CallHandler,
  ExecutionContext} from '@nestjs/common';
import {
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';

import { httpRequestDurationSeconds, httpRequestsTotal } from '../../health/metrics.controller';

/**
 * Records Prometheus counters + histogram for every HTTP request. Mounted
 * globally in main.ts so every controller route is covered without per-module
 * wiring. Route label uses the Express path template (so `/projects/:id` stays
 * a single label instead of exploding into one bucket per UUID).
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const started = process.hrtime.bigint();
    return next.handle().pipe(
      tap({
        next: () => record(req, res, started),
        error: () => record(req, res, started),
      }),
    );
  }
}

function record(req: Request, res: Response, started: bigint): void {
  const elapsedNs = Number(process.hrtime.bigint() - started);
  const seconds = elapsedNs / 1e9;
  // Use the route template if Express resolved one; otherwise fall back to the
  // raw URL stripped of querystring so cardinality stays bounded.
  // baseUrl + path always returns a string (possibly empty), so the trailing
  // ?? 'unknown' was dead. Fall back via boolean coercion instead.
  const fallback = req.baseUrl + (req.path || '').replace(/\/$/, '');
  const route =
    (req.route as { path?: string } | undefined)?.path ??
    (fallback || 'unknown');
  const labels = {
    method: req.method,
    route,
    status: String(res.statusCode),
  };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, seconds);
}
