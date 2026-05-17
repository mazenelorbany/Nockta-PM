import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { ulid } from 'ulid';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

const HEADER = 'x-correlation-id';

/** Attaches a correlation ID to every HTTP request for log/event tracing. */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { correlationId?: string }>();
    const res = http.getResponse<Response>();
    const incoming = req.headers[HEADER];
    const correlationId =
      typeof incoming === 'string' && incoming.length > 0 ? incoming : ulid();
    req.correlationId = correlationId;
    res.setHeader(HEADER, correlationId);
    return next.handle();
  }
}
