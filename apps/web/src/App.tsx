import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { KeyboardShortcuts } from './components/KeyboardShortcuts';
import { Layout } from './components/Layout';
import { api } from './lib/api';
import { useAuth } from './lib/auth-store';
import { installAutoDrain, type QueuedMutation } from './lib/offline-mutation-queue';
import { defaultViewToPath, getDefaultProjectView } from './lib/default-project-view';
// Eager: anonymous routes (we can't lazy them without flashing the spinner on
// every login → home redirect). Everything authenticated is lazy-loaded so the
// initial bundle stays around the shell + the smallest possible router.
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { LoginPage } from './pages/LoginPage';
import { MagicLinkCallbackPage } from './pages/MagicLinkCallbackPage';

// Round 7 Pass G — every authenticated route is lazy. Even the dashboard,
// since the shell already shows a route-fallback skeleton while it streams in
// and any returning user with a deep-link header (e.g. /board, /my-tasks)
// no longer pays the dashboard bundle cost on first paint.
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const AllTasksBoardPage = lazy(() => import('./pages/AllTasksBoardPage').then((m) => ({ default: m.AllTasksBoardPage })));
const ArchivedProjectsPage = lazy(() => import('./pages/ArchivedProjectsPage').then((m) => ({ default: m.ArchivedProjectsPage })));
const WorkloadPage = lazy(() => import('./pages/WorkloadPage').then((m) => ({ default: m.WorkloadPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const CalendarPage = lazy(() => import('./pages/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const InboxPage = lazy(() => import('./pages/InboxPage').then((m) => ({ default: m.InboxPage })));
const MyTasksPage = lazy(() => import('./pages/MyTasksPage').then((m) => ({ default: m.MyTasksPage })));
const ProjectDocsPage = lazy(() => import('./pages/ProjectDocsPage').then((m) => ({ default: m.ProjectDocsPage })));
const ProjectAutomationsPage = lazy(() => import('./pages/ProjectAutomationsPage').then((m) => ({ default: m.ProjectAutomationsPage })));
const ProjectBoardPage = lazy(() => import('./pages/ProjectBoardPage').then((m) => ({ default: m.ProjectBoardPage })));
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })));
const ProjectsListPage = lazy(() => import('./pages/ProjectsListPage').then((m) => ({ default: m.ProjectsListPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const ProjectBacklogPage = lazy(() => import('./pages/ProjectBacklogPage').then((m) => ({ default: m.ProjectBacklogPage })));
const ProjectDashboardPage = lazy(() => import('./pages/ProjectDashboardPage').then((m) => ({ default: m.ProjectDashboardPage })));
const ProjectOverviewPage = lazy(() => import('./pages/ProjectOverviewPage').then((m) => ({ default: m.ProjectOverviewPage })));
const ProjectTimelinePage = lazy(() => import('./pages/ProjectTimelinePage').then((m) => ({ default: m.ProjectTimelinePage })));
const ProjectWorklogReportPage = lazy(() => import('./pages/ProjectWorklogReportPage').then((m) => ({ default: m.ProjectWorklogReportPage })));
const ProjectDeploymentsPage = lazy(() => import('./pages/ProjectDeploymentsPage').then((m) => ({ default: m.ProjectDeploymentsPage })));
const SprintPlanningPage = lazy(() => import('./pages/SprintPlanningPage').then((m) => ({ default: m.SprintPlanningPage })));
const StandupPage = lazy(() => import('./pages/StandupPage').then((m) => ({ default: m.StandupPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: 1 },
  },
});

/**
 * /projects/:projectId/sprints → /projects/:projectId/backlog
 *
 * Older bookmarks land on this route; we redirect to the combined backlog page
 * where sprint lifecycle now lives. Using a small wrapper instead of a static
 * Navigate so we can read the :projectId param at runtime.
 */
function RedirectToBacklog(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={`/projects/${projectId}/backlog`} replace />;
}

/**
 * /projects/:projectId → the user's chosen default view (defaults to board).
 * The legacy ProjectOverviewPage is still mounted at
 * `/projects/:projectId/overview` for deep-links and the "Open overview"
 * affordance, but clicking on a project lands you in the place you'll
 * actually work — the board, unless you've picked otherwise.
 */
function RedirectToDefaultProjectView(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return <Navigate to="/projects" replace />;
  const view = getDefaultProjectView();
  return <Navigate to={defaultViewToPath(projectId, view)} replace />;
}

/**
 * RouteSkeleton — full-bleed placeholder shown while a lazy route chunk
 * downloads. Mirrors the rough shape of every page in the app (header bar +
 * toolbar + content grid) so the layout doesn't jump when the real component
 * mounts. Deliberately pure CSS so it ships with the shell bundle and
 * displays the instant the user clicks a route.
 */
function RouteSkeleton(): JSX.Element {
  return (
    <div className="h-full w-full p-4 sm:p-6 md:p-8 space-y-4" role="status" aria-label="Loading page">
      <div className="flex items-center justify-between gap-3">
        <div className="h-7 w-48 rounded-md bg-muted animate-pulse" />
        <div className="h-8 w-32 rounded-md bg-muted animate-pulse" />
      </div>
      <div className="flex items-center gap-2">
        <div className="h-6 w-20 rounded-md bg-muted animate-pulse" />
        <div className="h-6 w-24 rounded-md bg-muted animate-pulse" />
        <div className="h-6 w-16 rounded-md bg-muted animate-pulse" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

function ProtectedShell(): JSX.Element {
  const { tokens, user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!tokens) {
      navigate('/login', { replace: true, state: { from: location } });
      return;
    }
    if (!user) {
      void api
        .get<{
          id: string;
          email: string;
          companyRole: 'Admin' | 'Member' | null;
          kind: 'internal' | 'client';
          // Round 6 Pass A — workspaceId is now part of the /auth/me payload.
          // Optional so legacy backends (mid-deploy) still parse.
          workspaceId?: string;
        }>('/auth/me')
        .then((u) => setUser(u))
        .catch(() => navigate('/login', { replace: true }));
    }
  }, [tokens, user, navigate, location, setUser]);

  // (R6 follow-up) Removed the auto-redirect into /onboarding. The role
  // picker lives at /onboarding for users who want it, but it no longer
  // gates the dashboard on first login.

  // Drain the offline mutation queue whenever connectivity returns. The
  // executor reaches for the live access token at call time (so a token
  // rotated mid-queue still works) and routes through plain `fetch` because
  // the queued URLs are already absolute + the SDK client doesn't expose a
  // verbatim "send this exact URL" affordance.
  useEffect(() => {
    if (!tokens) return;
    const teardown = installAutoDrain(
      async (m: QueuedMutation) => {
        const accessToken = useAuth.getState().tokens?.accessToken;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (accessToken) headers.authorization = `Bearer ${accessToken}`;
        // Build init conditionally so we don't pass `body: undefined` under
        // exactOptionalPropertyTypes.
        const init: RequestInit = { method: m.method, headers };
        if (m.body !== undefined) init.body = JSON.stringify(m.body);
        return fetch(m.url, init);
      },
      (result) => {
        if (result.drained.length > 0) {
          toast.success(`Synced ${result.drained.length} offline change${result.drained.length === 1 ? '' : 's'}`);
          // Best-effort cache wipe — the synced mutations touched task state
          // somewhere, and we don't know exactly where, so blow the lot away
          // and let TanStack refetch lazily.
          void queryClient.invalidateQueries();
        }
        if (result.conflicts.length > 0) {
          toast.error(
            `${result.conflicts.length} offline change${result.conflicts.length === 1 ? '' : 's'} conflicted with remote updates. Refresh to see remote changes.`,
            { duration: 6000 },
          );
        }
      },
    );
    return teardown;
  }, [tokens, queryClient]);

  if (!tokens) return <></>;
  return (
    <>
      <Layout />
      {/* Mounted globally so Cmd+K works on every authenticated page */}
      <CommandPalette />
      <KeyboardShortcuts />
    </>
  );
}

export function App(): JSX.Element {
  return (
    <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<RouteSkeleton />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />
            <Route path="/auth/magic" element={<MagicLinkCallbackPage />} />
            <Route element={<ProtectedShell />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/my-tasks" element={<MyTasksPage />} />
              <Route path="/board" element={<AllTasksBoardPage />} />
              {/* /dashboards retired — workspace saved views ("Boards" sidebar)
                  replaced the widget-based custom dashboards. Redirect old
                  bookmarks to the all-tasks board. */}
              <Route path="/dashboards/:dashboardId" element={<Navigate to="/board" replace />} />
              <Route path="/workload" element={<WorkloadPage />} />
              <Route path="/projects" element={<ProjectsListPage />} />
              <Route path="/projects/archived" element={<ArchivedProjectsPage />} />
              <Route path="/projects/:projectId" element={<RedirectToDefaultProjectView />} />
              <Route path="/projects/:projectId/overview" element={<ProjectOverviewPage />} />
              <Route path="/projects/:projectId/dashboard" element={<ProjectDashboardPage />} />
              <Route path="/projects/:projectId/board" element={<ProjectBoardPage />} />
              <Route path="/projects/:projectId/backlog" element={<ProjectBacklogPage />} />
              <Route path="/projects/:projectId/timeline" element={<ProjectTimelinePage />} />
              <Route path="/projects/:projectId/worklog" element={<ProjectWorklogReportPage />} />
              <Route path="/projects/:projectId/deployments" element={<ProjectDeploymentsPage />} />
              {/* /sprints folded into /backlog — sprints + backlog live on one page.
                  Keep the route as a redirect so old bookmarks land on the right place. */}
              <Route
                path="/projects/:projectId/sprints"
                element={<RedirectToBacklog />}
              />
              <Route path="/projects/:projectId/sprints/:sprintId/plan" element={<SprintPlanningPage />} />
              <Route path="/projects/:projectId/settings" element={<ProjectSettingsPage />} />
              <Route path="/projects/:projectId/docs" element={<ProjectDocsPage />} />
              <Route path="/projects/:projectId/docs/:docId" element={<ProjectDocsPage />} />
              <Route path="/projects/:projectId/automations" element={<ProjectAutomationsPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/standup" element={<StandupPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings/*" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'hsl(var(--card))',
            color: 'hsl(var(--foreground))',
            border: '1px solid hsl(var(--border))',
            fontSize: 13,
          },
        }}
      />
    </QueryClientProvider>
    </ErrorBoundary>
  );
}
