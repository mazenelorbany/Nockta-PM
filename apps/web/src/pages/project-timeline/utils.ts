import { ApiError } from '@nockta/sdk';

import type { Priority } from '../../components/task-bits';

export function priorityColor(p: Priority): string {
  switch (p) {
    case 'Critical': return 'bg-priority-critical';
    case 'High': return 'bg-priority-high';
    case 'Medium': return 'bg-primary';
    case 'Low': return 'bg-muted-foreground/60';
  }
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.problem.detail) return err.problem.detail;
    if (err.problem.title) return err.problem.title;
  }
  return fallback;
}
