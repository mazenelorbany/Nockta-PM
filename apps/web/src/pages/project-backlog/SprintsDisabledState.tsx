import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { apiErrorMessage } from './helpers';

// =============================================================================
// Sprints-disabled empty state — one-click enable from this page.
// =============================================================================

export function SprintsDisabledState({ projectId, projectName }: { projectId: string; projectName: string }): JSX.Element {
  const queryClient = useQueryClient();
  const enable = useMutation({
    mutationFn: () => api.patch(`/projects/${projectId}`, { sprintsEnabled: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Sprints enabled');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not enable sprints')),
  });
  return (
    <div className="p-12 max-w-xl mx-auto text-center space-y-3">
      <Target className="h-8 w-8 text-muted-foreground mx-auto" />
      <h2 className="text-lg font-semibold">Sprints aren't on for {projectName}</h2>
      <p className="text-sm text-muted-foreground">
        Turn sprints on to start planning. You can keep using the board and list view alongside.
      </p>
      <button
        type="button"
        onClick={() => enable.mutate()}
        disabled={enable.isPending}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition disabled:opacity-50"
      >
        {enable.isPending ? 'Enabling…' : 'Enable sprints'}
      </button>
    </div>
  );
}
