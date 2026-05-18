import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';

import { api } from '../../lib/api';

import type { AutomationRun } from './types';
import { timeAgo } from './utils';

// ============================================================================
// Runs drawer
// ============================================================================

export function RunsDrawer({ automationId, onClose }: { automationId: string; onClose: () => void }): JSX.Element {
  const runsQuery = useQuery({
    queryKey: ['automation-runs', automationId],
    queryFn: () => api.get<AutomationRun[]>(`/automations/${automationId}/runs`),
    refetchInterval: 5000,
  });
  return (
    <div className="fixed inset-0 z-50 flex">
      <button type="button" aria-label="Close" onClick={onClose} className="flex-1 bg-black/40 backdrop-blur-sm" />
      <div className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-background shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-6 py-4 backdrop-blur">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Automation</p>
            <h2 className="mt-0.5 text-base font-semibold">Run history</h2>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">Close</button>
        </header>
        <div className="flex-1 px-6 py-4">
          {runsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {runsQuery.data && runsQuery.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Not yet triggered — when the trigger fires, runs will show up here.</p>
          )}
          <ul className="space-y-2">
            {(runsQuery.data ?? []).map((r) => (
              <li key={r.id} className="rounded-lg border border-border bg-card/40 p-3 text-sm">
                <div className="flex items-center gap-2">
                  {r.status === 'succeeded' && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
                  {r.status === 'skipped' && <Clock className="h-4 w-4 text-muted-foreground" />}
                  {r.status === 'failed' && <AlertCircle className="h-4 w-4 text-destructive" />}
                  <span className="capitalize">{r.status}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{timeAgo(r.createdAt)}</span>
                </div>
                {r.message && <p className="mt-1 text-xs text-muted-foreground">{r.message}</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
