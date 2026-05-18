import { ApiError } from '@nockta/sdk';

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.problem.title || err.problem.detail || err.message || fallback;
  return fallback;
}

export function prettyEventName(t: string): string {
  return t.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}
