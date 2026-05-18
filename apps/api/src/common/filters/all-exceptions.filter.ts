import type {
  ArgumentsHost} from '@nestjs/common';
import {
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail: string | undefined;
    const extras: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        title = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        title = (b['error'] as string) || (b['message'] as string) || 'Error';
        const msg = b['message'];
        detail = Array.isArray(msg) ? (msg as string[]).join('; ') : (msg as string | undefined);
        if (b['errors']) extras['errors'] = b['errors'];
      }
    } else if (exception instanceof Error) {
      detail = exception.message;
      this.logger.error(exception.stack ?? exception.message);
    } else {
      this.logger.error({ exception }, 'Unknown exception type');
    }

    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      ...(detail ? { detail } : {}),
      instance: request.url,
      ...extras,
    };

    response.status(status).type('application/problem+json').json(problem);
  }
}
