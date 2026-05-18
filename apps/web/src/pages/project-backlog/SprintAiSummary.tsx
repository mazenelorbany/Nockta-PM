import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import { apiErrorMessage } from './helpers';

// =============================================================================
// SprintAiSummary — LLM-generated recap for active/completed sprints. Rendered
// in a collapsed <details> inside the sprint section so it doesn't take up
// space until the user wants it.
// =============================================================================

export function SprintAiSummary({ sprintId }: { sprintId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const summaryQuery = useQuery({
    queryKey: ['sprint-summary', sprintId],
    queryFn: () =>
      api.get<{ summary: string | null; generatedAt: string | null }>(
        `/ai/sprints/${sprintId}/summary`,
      ),
  });
  const generate = useMutation({
    mutationFn: () =>
      api.post<{ summary: string; generatedAt: string }>(
        `/ai/sprints/${sprintId}/summarize-now`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sprint-summary', sprintId] });
      toast.success('Summary generated');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not generate summary')),
  });

  const summary = summaryQuery.data?.summary;
  const generatedAt = summaryQuery.data?.generatedAt;

  return (
    <details className="rounded-md border border-border/60 bg-card/30">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground flex items-center gap-2">
        <Sparkles className="h-3 w-3 text-primary" />
        AI sprint summary
        {generatedAt && (
          <span className="ml-1 text-[10px] text-muted-foreground/70">
            · {new Date(generatedAt).toLocaleString()}
          </span>
        )}
      </summary>
      <div className="border-t border-border/60 px-3 py-2 text-xs">
        {!summary && !generate.isPending && (
          <button
            type="button"
            onClick={() => generate.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 transition"
          >
            <Sparkles className="h-3 w-3" />
            Generate summary
          </button>
        )}
        {generate.isPending && (
          <p className="text-[11px] text-muted-foreground">Thinking… this can take 10–20 seconds.</p>
        )}
        {summary && !generate.isPending && (
          <>
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
              {summary}
            </div>
            <button
              type="button"
              onClick={() => generate.mutate()}
              className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Regenerate
            </button>
          </>
        )}
      </div>
    </details>
  );
}
