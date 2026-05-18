import { useEffect, useState } from 'react';
import { cn } from '@nockta/ui';
import { getSocket } from '../../../lib/socket';

/**
 * Subscribe to `import:<runId>` and surface processed/total + done status.
 * Cleans up its listeners on unmount or runId change.
 */
export function useImportProgress(runId: string | null): {
  processed: number;
  total: number;
  done: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  errorSummary: string | null;
} {
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState<'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'>(
    'idle',
  );
  const [errorSummary, setErrorSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) {
      setProcessed(0);
      setTotal(0);
      setDone('idle');
      setErrorSummary(null);
      return;
    }
    setDone('running');
    setErrorSummary(null);
    const socket = getSocket();
    const onProgress = (payload: { runId: string; processed: number; total: number }): void => {
      if (payload.runId !== runId) return;
      setProcessed(payload.processed);
      setTotal(payload.total);
    };
    const onDone = (payload: {
      runId: string;
      processed: number;
      total: number;
      status: 'succeeded' | 'failed' | 'cancelled';
      errorSummary?: string;
    }): void => {
      if (payload.runId !== runId) return;
      setProcessed(payload.processed);
      setTotal(payload.total);
      setDone(payload.status);
      setErrorSummary(payload.errorSummary ?? null);
    };
    socket.emit('import:join', { runId });
    socket.on('import.progress', onProgress);
    socket.on('import.done', onDone);
    return () => {
      socket.off('import.progress', onProgress);
      socket.off('import.done', onDone);
      socket.emit('import:leave', { runId });
    };
  }, [runId]);

  return { processed, total, done, errorSummary };
}

export function ImportProgressBar({
  processed,
  total,
  done,
}: {
  processed: number;
  total: number;
  done: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}): JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const tone =
    done === 'succeeded'
      ? 'bg-status-done'
      : done === 'failed' || done === 'cancelled'
        ? 'bg-status-blocked'
        : 'bg-primary';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] tabular-nums">
        <span className="text-muted-foreground">
          {done === 'running' && 'Importing…'}
          {done === 'succeeded' && 'Imported'}
          {done === 'failed' && 'Failed'}
          {done === 'cancelled' && 'Cancelled'}
          {done === 'idle' && 'Waiting'}
        </span>
        <span className="text-muted-foreground">
          {processed} / {total || '?'} ({pct}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-border/60 overflow-hidden">
        <div
          className={cn('h-full transition-all duration-200', tone)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
