import { ApiError } from '@nockta/sdk';

import type { KeyResult } from './types';

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.problem.title || err.problem.detail || err.message || fallback;
  return fallback;
}

export function krPercent(kr: KeyResult): number {
  if (kr.targetValue === 0) return 0;
  // Allow over-achievement to clamp at 100 so the UI stays sensible. We could
  // surface the literal ratio elsewhere if a "stretch" KR ever matters.
  return Math.max(0, Math.min(100, Math.round((kr.currentValue / kr.targetValue) * 100)));
}
