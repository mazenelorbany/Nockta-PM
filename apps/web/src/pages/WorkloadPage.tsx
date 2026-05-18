import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  EmptyState, NocktaMark, QueryErrorState, SkeletonList,
} from '@nockta/ui';
import { Users as UsersIcon } from 'lucide-react';

import { TaskDetailDrawer } from '../components/TaskDetailDrawer';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

import { Pill } from './workload/Pill';
import { WorkloadDetailModal } from './workload/WorkloadDetailModal';
import { WorkloadRowItem } from './workload/WorkloadRowItem';
import type { ProjectLite, TeamLite, WorkloadResp } from './workload/types';

// =============================================================================
// /workload — cross-project capacity view. Each row is one person with an
// open-task count, a stacked priority bar, and a "load score" that weights
// Critical 4x / High 3x / Medium 2x / Low 1x. Filterable by project + team.
// =============================================================================

export function WorkloadPage(): JSX.Element {
  const [projectId, setProjectId] = useState('');
  const [teamId, setTeamId] = useState('');
  // Detail modal — which person's drill-down is open. Null = closed.
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  // When the user clicks a task inside the detail modal, we route into the
  // standard TaskDetailDrawer by setting ?task=ID. Same pattern every other
  // page in the app uses to host the drawer.
  const [searchParams, setSearchParams] = useSearchParams();
  const openTaskId = searchParams.get('task');
  function openTask(id: string): void {
    setSearchParams((sp) => {
      sp.set('task', id);
      return sp;
    });
  }
  function closeTask(): void {
    setSearchParams((sp) => {
      sp.delete('task');
      return sp;
    });
  }
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectLite[]>('/projects'),
  });
  const teamsQuery = useQuery({
    queryKey: queryKeys.teams(),
    queryFn: () => api.get<TeamLite[]>('/teams'),
  });
  const qs = new URLSearchParams();
  if (projectId) qs.set('projectId', projectId);
  if (teamId) qs.set('teamId', teamId);
  const workloadQuery = useQuery({
    queryKey: ['workload', qs.toString()],
    queryFn: () => api.get<WorkloadResp>(`/analytics/workload?${qs.toString()}`),
  });

  const rows = workloadQuery.data?.rows ?? [];
  // Use the max load score as the scale; protect against zero.
  const maxLoad = Math.max(1, ...rows.map((r) => r.loadScore));

  return (
    <div className="flex flex-col h-full">
      <header className="relative overflow-hidden border-b border-border gradient-mesh-subtle">
        <div
          className="absolute -right-12 -bottom-16 text-brand/[0.05] pointer-events-none select-none"
          aria-hidden="true"
        >
          <NocktaMark className="h-[240px] w-[240px]" />
        </div>
        <div className="relative px-4 sm:px-6 md:px-8 pt-6 sm:pt-8 pb-6 sm:pb-8">
          <span className="nockta-eyebrow text-brand">{'Workspace'}</span>
          <h1
            className="display-heading mt-2 leading-[1.04]"
            style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}
          >
            {'Workload'}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {"Who's loaded with what. Priority-weighted scoring across every open task — Critical counts as 4×, High 3×, Medium 2×, Low 1×."}
          </p>
        </div>
      </header>

      <div className="px-4 sm:px-6 md:px-8 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <Pill
          label={'Project'}
          value={projectId}
          onChange={setProjectId}
          options={[
            { value: '', label: 'All projects' },
            ...(projectsQuery.data ?? []).map((p) => ({ value: p.id, label: `${p.key} — ${p.name}` })),
          ]}
        />
        <Pill
          label={'Team'}
          value={teamId}
          onChange={setTeamId}
          options={[
            { value: '', label: 'Everyone' },
            ...(teamsQuery.data ?? []).map((teamItem) => ({ value: teamItem.id, label: teamItem.name })),
          ]}
        />
        {(projectId || teamId) && (
          <button
            type="button"
            onClick={() => {
              setProjectId('');
              setTeamId('');
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
        <span className="nockta-eyebrow text-muted-foreground ml-auto">
          {rows.length} {rows.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 md:px-8 py-4 sm:py-6">
        {workloadQuery.isLoading ? (
          <SkeletonList rows={6} rowClassName="h-16" />
        ) : workloadQuery.isError ? (
          <QueryErrorState
            title="Couldn't load workload"
            error={workloadQuery.error}
            onRetry={() => void workloadQuery.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<UsersIcon className="h-5 w-5" />}
            title="No open work in this view"
            description="Either nobody on this team has an open task right now, or the filters are too tight. Clear them to see the full org."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <WorkloadRowItem
                key={r.userId}
                row={r}
                maxLoad={maxLoad}
                onOpen={() => setDetailUserId(r.userId)}
              />
            ))}
          </ul>
        )}
      </div>

      {detailUserId && (
        <WorkloadDetailModal
          userId={detailUserId}
          onClose={() => setDetailUserId(null)}
          onOpenTask={(id) => {
            // Keep the modal mounted behind the drawer so the user lands back
            // on the same person when they close the task.
            openTask(id);
          }}
        />
      )}
      {openTaskId && <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />}
    </div>
  );
}
