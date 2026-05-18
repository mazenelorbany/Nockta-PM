import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../../lib/api';

/**
 * StandupCard — generates a 3-section "yesterday / today / blockers" standup
 * on demand. The generated markdown is cached in component state so the user
 * can re-open the dashboard without re-paying the LLM cost.
 */
export function StandupCard({ userId }: { userId: string }): JSX.Element {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const generate = useMutation({
    mutationFn: () => api.post<{ markdown: string }>(`/ai/users/${userId}/standup`),
    onSuccess: (data) => setMarkdown(data.markdown),
    onError: () => {
      // Toast handled centrally; component just shows a quiet error fallback.
    },
  });

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="nockta-eyebrow text-muted-foreground inline-flex items-center gap-1.5">
            <span className="text-primary">✨</span> Standup
          </p>
          <p className="mt-0.5 text-sm font-semibold">Daily check-in</p>
        </div>
        <button
          type="button"
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition disabled:opacity-50"
        >
          {markdown ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {generate.isPending && !markdown && (
        <p className="text-xs text-muted-foreground">
          Thinking… pulling yesterday's activity and today's open work.
        </p>
      )}
      {!generate.isPending && !markdown && (
        <p className="text-xs text-muted-foreground">
          Click "Generate" to build today's standup from your activity.
        </p>
      )}
      {markdown && (
        <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap text-sm">
          {markdown}
        </div>
      )}
    </div>
  );
}
