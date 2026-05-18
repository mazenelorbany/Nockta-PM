import { useQuery } from '@tanstack/react-query';
import { cn } from '@nockta/ui';
import { Bookmark, LayoutGrid } from 'lucide-react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Section } from './section';

// -----------------------------------------------------------------------------
// BoardsSection — workspace-scope saved views, one click each.
//
// A "Board" here is a SavedView that has no `query.projectId` — it represents
// a cross-project board configuration (the user's "dashboards" in the new
// vocabulary). Clicking one navigates to /board?savedView=:id, which the
// AllTasksBoardPage interprets by loading the view's filters/view and
// scrubbing the query param. Project-scoped saved views still live behind
// the Views menu inside their respective project boards.
// -----------------------------------------------------------------------------

interface SidebarSavedView {
  id: string;
  name: string;
  query: { projectId?: string };
}

export function BoardsSection(): JSX.Element {
  const navigate = useNavigate();
  const viewsQuery = useQuery({
    queryKey: ['saved-views'],
    queryFn: () => api.get<SidebarSavedView[]>('/saved-views'),
    staleTime: 30_000,
  });
  // Only workspace-scope views (no projectId) belong here. Project-scoped
  // saved views are reachable via each project's chevron-expand sub-tree.
  const workspaceBoards = (viewsQuery.data ?? []).filter((v) => !v.query.projectId);

  return (
    <Section
      title={'Boards'}
      count={workspaceBoards.length}
      action={
        <Link
          to="/board"
          aria-label={'All-tasks board'}
          title={'All-tasks board'}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <LayoutGrid className="h-3 w-3" />
        </Link>
      }
    >
      {viewsQuery.isLoading ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">{'Loading…'}</div>
      ) : workspaceBoards.length === 0 ? (
        <button
          type="button"
          onClick={() => navigate('/board')}
          className="w-full text-start text-xs px-2 py-1.5 rounded text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
          title={'+ Save a board from filters'}
        >
          {'+ Save a board from filters'}
        </button>
      ) : (
        workspaceBoards.map((v) => (
          <NavLink
            key={v.id}
            to={`/board?savedView=${v.id}`}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )
            }
            title={`Open the "${v.name}" board`}
          >
            <Bookmark className="h-3.5 w-3.5" />
            <span className="truncate">{v.name}</span>
          </NavLink>
        ))
      )}
    </Section>
  );
}
