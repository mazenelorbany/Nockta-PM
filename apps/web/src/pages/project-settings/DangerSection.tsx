import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, Trash2 } from 'lucide-react';

import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

import { Section } from './shared';
import { apiErrorMessage } from './utils';
import type { Project } from './types';

export function DangerSection({
  project,
  projectId,
}: {
  project: Project;
  projectId: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const archiveMutation = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}`),
    onSuccess: () => {
      toast.success('Project archived');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
      navigate('/projects');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Archive failed')),
  });

  return (
    <Section
      id="danger"
      icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
      title="Danger zone"
      hint="Irreversible actions live here. Tread carefully."
      danger
    >
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
        <div className="text-sm font-medium mb-1">Archive project</div>
        <div className="text-xs text-muted-foreground mb-3">
          Hides the project from the list. Tasks and history are preserved.
          Restoring requires a database operator — there is no UI to undo this.
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Archive "${project.name}"?`)) archiveMutation.mutate();
          }}
          disabled={archiveMutation.isPending || Boolean(project.archivedAt)}
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {project.archivedAt
            ? 'Already archived'
            : archiveMutation.isPending
              ? 'Archiving…'
              : 'Archive project'}
        </button>
      </div>
    </Section>
  );
}
