import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { StatusPill } from '../task-bits';

import type { SimilarTask } from './types';

export function SimilarTasksSection({ taskId }: { taskId: string }): JSX.Element {
  const [shown, setShown] = useState(false);
  const similarQuery = useQuery({
    queryKey: ['similar-tasks', taskId],
    queryFn: () => api.get<SimilarTask[]>(`/ai/tasks/${taskId}/similar`),
    enabled: shown,
    staleTime: 60_000,
  });

  return (
    <section className="space-y-2">
      <header className="flex items-center justify-between">
        <h3 className="nockta-eyebrow text-muted-foreground inline-flex items-center gap-1.5">
          <span className="text-primary">✨</span>
          Similar tasks
        </h3>
        {!shown && (
          <button
            type="button"
            onClick={() => setShown(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Find similar
          </button>
        )}
      </header>
      {shown && similarQuery.isLoading && (
        <p className="text-xs text-muted-foreground">Searching…</p>
      )}
      {shown && similarQuery.isError && (
        <p className="text-xs text-muted-foreground">AI is unavailable right now.</p>
      )}
      {shown && similarQuery.data && similarQuery.data.length === 0 && (
        <p className="text-xs text-muted-foreground">No close matches found.</p>
      )}
      {shown && similarQuery.data && similarQuery.data.length > 0 && (
        <ul className="space-y-1">
          {similarQuery.data.map((s) => (
            <li key={s.taskId}>
              <a
                href={`?taskId=${s.taskId}`}
                className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-xs transition hover:border-primary/40"
              >
                <span className="font-mono text-muted-foreground">{s.key}</span>
                <span className="flex-1 truncate">{s.title}</span>
                <StatusPill status={s.status} />
                <span className="font-mono text-[10px] text-muted-foreground">
                  {(s.score * 100).toFixed(0)}%
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
