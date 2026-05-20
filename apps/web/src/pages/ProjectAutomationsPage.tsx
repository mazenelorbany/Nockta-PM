import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { ProjectTabs } from '../components/ProjectTabs';
import { api } from '../lib/api';
import { useResolvedProject } from '../lib/project-route';
import { queryKeys } from '../lib/query-keys';

import { AutomationRow } from './project-automations/AutomationRow';
import { CreateAutomationDrawer } from './project-automations/CreateAutomationDrawer';
import { EmptyState, SkeletonList } from './project-automations/EmptyState';
import { RunsDrawer } from './project-automations/RunsDrawer';
import type {
  Automation,
  Label,
  Project,
  ProjectAccessRow,
  SprintRow,
} from './project-automations/types';
import { apiErrorMessage } from './project-automations/utils';

export function ProjectAutomationsPage(): JSX.Element {
  const { projectId } = useResolvedProject();
  const queryClient = useQueryClient();

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const automationsQuery = useQuery({
    queryKey: ['automations', projectId],
    queryFn: () => api.get<Automation[]>(`/projects/${projectId}/automations`),
    enabled: Boolean(projectId),
  });
  const labelsQuery = useQuery({
    queryKey: ['labels', projectId],
    queryFn: () => api.get<Label[]>(`/projects/${projectId}/labels`),
    enabled: Boolean(projectId),
  });
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => api.get<ProjectAccessRow[]>(`/projects/${projectId}/access`),
    enabled: Boolean(projectId),
  });
  const sprintsQuery = useQuery({
    queryKey: queryKeys.sprints(projectId),
    queryFn: () => api.get<SprintRow[]>(`/projects/${projectId}/sprints`),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;
  const automations = automationsQuery.data ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [openRunsFor, setOpenRunsFor] = useState<string | null>(null);

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<Automation>(`/automations/${id}/toggle`, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations', projectId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Toggle failed')),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/automations/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['automations', projectId] });
      toast.success('Deleted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });

  const userMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accessQuery.data ?? []) {
      if (a.user) m.set(a.user.id, a.user.name);
    }
    return m;
  }, [accessQuery.data]);

  return (
    <div>
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          {project?.key && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
              {project.key}
            </span>
          )}
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">
            {project?.name ?? 'Automations'}
          </h1>
          <span className="text-muted-foreground/60 hidden sm:inline">·</span>
          <span className="text-sm text-muted-foreground hidden sm:inline">Automations</span>
        </div>
      </header>

      <ProjectTabs
        projectId={projectId ?? ''}
        actions={
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="tap inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 h-8 text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            <Plus className="h-3.5 w-3.5" />
            New automation
          </button>
        }
      />

      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-4 sm:py-6 md:py-8">

      {automationsQuery.isLoading ? (
        <SkeletonList />
      ) : automations.length === 0 ? (
        <EmptyState onCreate={() => setShowCreate(true)} />
      ) : (
        <ul className="space-y-3">
          {automations.map((a) => (
            <AutomationRow
              key={a.id}
              automation={a}
              labels={labelsQuery.data ?? []}
              userMap={userMap}
              onToggle={(enabled) => toggleMutation.mutate({ id: a.id, enabled })}
              onDelete={() => {
                if (confirm(`Delete "${a.name}"?`)) deleteMutation.mutate(a.id);
              }}
              onShowRuns={() => setOpenRunsFor(a.id)}
            />
          ))}
        </ul>
      )}

      {showCreate && project && (
        <CreateAutomationDrawer
          project={project}
          labels={labelsQuery.data ?? []}
          assignees={(accessQuery.data ?? []).filter((a) => a.user).map((a) => a.user!)}
          sprints={sprintsQuery.data ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void queryClient.invalidateQueries({ queryKey: ['automations', projectId] });
            toast.success('Automation created');
          }}
        />
      )}

      {openRunsFor && (
        <RunsDrawer
          automationId={openRunsFor}
          onClose={() => setOpenRunsFor(null)}
        />
      )}
      </div>
    </div>
  );
}
