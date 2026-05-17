import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cn, NocktaLogo } from '@nockta/ui';
import {
  Archive, BarChart3, Bookmark, Calendar, ChevronRight, FolderKanban, Inbox,
  LayoutDashboard, LayoutGrid, ListTodo, LogOut, MoreHorizontal, Search, Settings, Sun, Users,
} from 'lucide-react';
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { useNotificationsSurface } from '../lib/use-notifications';
import { ActiveTimerChip } from './ActiveTimerChip';
import { MobileBottomNav } from './MobileBottomNav';
import { NotificationsBell } from './NotificationsBell';
import { PageTransition } from './PageTransition';

// =============================================================================
// ClickUp-style sidebar:
//   - Brand block
//   - Search trigger
//   - "Personal" section: Dashboard, My tasks, Calendar, Analytics
//   - "Workspace" section: collapsible Projects tree (each project expands to
//     Board / List / Sprints / Docs / Settings)
//   - "System" section: Settings
//   - User pill + logout
// =============================================================================

interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
  archivedAt: string | null;
}

// PERSONAL_LINKS keys are translated at render time via t(); the `i18nKey`
// here is the dotted path into the `nav` namespace. The literal `label` is the
// English fallback so the sidebar still renders sensibly if i18n init failed.
// `client` flag marks links that are valid for external (kind=client) users.
// Internal team rituals (Standup, Workload, Analytics) and team-specific
// surfaces (My tasks / Calendar are tuned for internal sprint context) stay
// hidden for clients to keep their shell coherent.
const PERSONAL_LINKS = [
  { to: '/',          i18nKey: 'nav.dashboard', label: 'Dashboard',  icon: LayoutDashboard, end: true,  client: true  },
  { to: '/inbox',     i18nKey: 'nav.inbox',     label: 'Inbox',      icon: Inbox,           end: false, client: true  },
  { to: '/my-tasks',  i18nKey: 'nav.my_tasks',  label: 'My tasks',   icon: ListTodo,        end: false, client: false },
  { to: '/board',     i18nKey: 'nav.all_tasks', label: 'All tasks',  icon: LayoutGrid,      end: false, client: true  },
  { to: '/standup',   i18nKey: 'nav.standup',   label: 'Standup',    icon: Sun,             end: false, client: false },
  { to: '/calendar',  i18nKey: 'nav.calendar',  label: 'Calendar',   icon: Calendar,        end: false, client: false },
  { to: '/workload',  i18nKey: 'nav.workload',  label: 'Workload',   icon: Users,           end: false, client: false },
  { to: '/analytics', i18nKey: 'nav.analytics', label: 'Analytics',  icon: BarChart3,       end: false, client: false },
] as const;

export function Layout(): JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, logout } = useAuth();

  // Title pulse + browser-push toast for new notifications. Mounted here so
  // the surface follows the user across every authenticated page.
  useNotificationsSurface();

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectSummary[]>('/projects'),
  });
  const projects = (projectsQuery.data ?? []).filter((p) => !p.archivedAt);

  // Per-project chevron-expand sub-menu retired: every project's sub-routes
  // (Board / List / Backlog / Timeline / Docs / Automations / Settings) now
  // live in the persistent ProjectTabs strip at the top of each project page.

  // Track recently-visited project ids. Jira-style: show only the recent few
  // in the sidebar; everything else lives behind a "More projects" popover.
  const recentIds = useRecentProjects();
  const location = useLocation();
  // Push the current /projects/:id into the recents stack whenever the user
  // navigates into a project page.
  useEffect(() => {
    const match = /^\/projects\/([^/?#]+)/.exec(location.pathname);
    if (match) pushRecentProject(match[1]!);
  }, [location.pathname]);

  // Derive the visible-in-sidebar set: union of (a) recently-visited projects,
  // (b) the currently-open one, ordered by recency. Cap at 5 to keep the
  // sidebar compact. Anything else is reachable via the popover.
  const RECENTS_CAP = 5;
  const visibleProjects = useMemo<ProjectSummary[]>(() => {
    if (projects.length === 0) return [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    const ordered: ProjectSummary[] = [];
    const seen = new Set<string>();
    // 1. current project first (if we're on one and it exists)
    const currentMatch = /^\/projects\/([^/?#]+)/.exec(location.pathname);
    const currentId = currentMatch?.[1];
    if (currentId && byId.has(currentId)) {
      ordered.push(byId.get(currentId)!);
      seen.add(currentId);
    }
    // 2. recents next
    for (const id of recentIds) {
      if (seen.has(id)) continue;
      const p = byId.get(id);
      if (p) {
        ordered.push(p);
        seen.add(id);
      }
      if (ordered.length >= RECENTS_CAP) break;
    }
    // 3. if still under cap, top up with alphabetically-first projects.
    if (ordered.length < RECENTS_CAP) {
      const remaining = projects
        .filter((p) => !seen.has(p.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const p of remaining) {
        ordered.push(p);
        if (ordered.length >= RECENTS_CAP) break;
      }
    }
    return ordered;
  }, [projects, recentIds, location.pathname]);
  const hasMoreProjects = projects.length > visibleProjects.length;
  const [pickerOpen, setPickerOpen] = useState(false);
  // Anchor ref for the "More projects" trigger. The picker reads its bounding
  // rect on open + on resize/scroll to position itself flush against the sidebar.
  const moreTriggerRef = useRef<HTMLButtonElement>(null);

  // Mobile sidebar drawer state — toggled by the hamburger in the top bar
  // on viewports <md. Always open on >=md.
  const [mobileOpen, setMobileOpen] = useState(false);
  // Auto-close on route change so the drawer doesn't stay over the new page.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);
  // Escape key closes the drawer while it's open. Listener only registers
  // when the drawer is open so we don't intercept Esc on the rest of the app.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMobileOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);
  // Focus trap: while the mobile drawer is open, Tab cycles only inside it.
  // We snapshot focusable descendants on each keydown so dynamic content
  // (e.g. expanding a section) doesn't break the trap. Restoring focus to
  // the trigger button on close is handled via the ref captured below.
  const sidebarRef = useRef<HTMLElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    const aside = sidebarRef.current;
    if (!aside) return;
    // Move focus into the drawer on open. Done in a microtask to clear React
    // reconciliation before measuring focusables.
    const raf = window.requestAnimationFrame(() => {
      const first = aside.querySelector<HTMLElement>(
        'a, button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      first?.focus();
    });
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return;
      const focusables = aside!.querySelectorAll<HTMLElement>(
        'a, button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !aside!.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      // Restore focus to the hamburger so keyboard users return to a sensible
      // anchor point after closing the drawer.
      hamburgerRef.current?.focus();
    };
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Mobile scrim — only renders when the drawer is open */}
      {mobileOpen && (
        <button
          type="button"
          aria-label={t('nav.close_menu', 'Close menu')}
          onClick={() => setMobileOpen(false)}
          className="md:hidden fixed inset-0 z-30 bg-black/50 cursor-default"
        />
      )}
      <aside
        ref={sidebarRef}
        id="mobile-sidebar"
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? t('nav.workspace', 'Navigation') : undefined}
        className={cn(
          'border-e border-border bg-card/95 md:bg-card/40 backdrop-blur-sm flex flex-col',
          // Default mobile: drawer (off-screen left until toggled).
          // Desktop: sticky to viewport so the user pill + System nav stay
          // in view regardless of how tall the main content is.
          'fixed md:sticky md:top-0 md:h-screen inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 md:transform-none',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        {/* Brand */}
        <div className="px-4 py-4 border-b border-border">
          <Link to="/" className="inline-flex items-center group">
            <NocktaLogo height={22} />
            <span className="nockta-eyebrow text-muted-foreground ms-2.5 ps-2.5 border-s border-border">
              Flow
            </span>
          </Link>
        </div>

        {/* Workspace pill — now with a subtle gradient and chevron tease so it
            reads like the start of a richer hierarchy, not a static label. */}
        <div className="px-3 pt-3">
          <div className="group rounded-lg border border-border/60 bg-gradient-to-br from-brand/5 via-card/60 to-card/30 px-2.5 py-2 flex items-center gap-2 hover:border-brand/30 transition-colors cursor-default">
            <span className="h-7 w-7 rounded-md bg-gradient-to-br from-brand to-brand/70 text-brand-foreground flex items-center justify-center text-[10px] font-bold flex-shrink-0 shadow-sm shadow-brand/30">
              N
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold truncate">Nockta Internal</div>
              <div className="nockta-eyebrow text-muted-foreground truncate">Workspace</div>
            </div>
            <span className="h-1.5 w-1.5 rounded-full bg-status-done animate-pulse" />
          </div>
        </div>

        {/* Cmd+K trigger */}
        <button
          type="button"
          data-tour="cmdk-button"
          onClick={() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
          }}
          className="tap mx-3 mt-2 flex items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-start">{t('nav.search_placeholder', 'Search…')}</span>
          <kbd className="text-[10px] px-1 py-0.5 rounded border border-border">⌘K</kbd>
        </button>

        {/* Scrollable nav */}
        <nav className="flex-1 overflow-y-auto p-2 pt-3 space-y-4">
          <Section title={t('nav.personal', 'Personal')}>
            {PERSONAL_LINKS.filter((link) =>
              user?.kind === 'client' ? link.client : true,
            ).map(({ to, i18nKey, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                    isActive
                      ? 'bg-accent text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                  )
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {t(i18nKey, label)}
              </NavLink>
            ))}
          </Section>

          {user?.kind !== 'client' && <BoardsSection />}

          <Section
            title={t('nav.projects', 'Projects')}
            count={projects.length}
            action={
              <Link
                to="/projects"
                aria-label={t('nav.all_projects_label', 'All projects')}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <FolderKanban className="h-3 w-3" />
              </Link>
            }
          >
            {/* data-tour anchor for the InteractiveTour. Wrapping inside the
                Section keeps the tour spotlight scoped to the project rows
                (not the section heading). */}
            <div data-tour="sidebar-projects">
              {projectsQuery.isLoading ? (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  {t('nav.loading', 'Loading…')}
                </div>
              ) : projects.length === 0 ? (
                <Link
                  to="/projects"
                  className="block text-xs px-2 py-1.5 rounded text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
                >
                  {t('nav.create_project', '+ Create a project')}
                </Link>
              ) : (
                <>
                  {visibleProjects.map((p) => (
                    <ProjectTreeItem key={p.id} project={p} />
                  ))}
                  {hasMoreProjects && (
                    <MoreProjectsTrigger
                      ref={moreTriggerRef}
                      totalCount={projects.length}
                      hiddenCount={projects.length - visibleProjects.length}
                      onOpen={() => setPickerOpen(true)}
                    />
                  )}
                </>
              )}
            </div>
          </Section>

        </nav>

        {/* System section + user pill — pinned to the bottom of the sidebar
            so Settings and the profile are reachable without scrolling the
            long projects list above. */}
        <div className="border-t border-border p-2 pt-3 space-y-1">
          <NavLink
            to="/settings"
            data-tour="settings-link"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )
            }
          >
            <Settings className="h-3.5 w-3.5" />
            {t('nav.settings', 'Settings')}
          </NavLink>
          {user?.companyRole === 'Admin' && (
            <NavLink
              to="/projects/archived"
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )
              }
              title="Archived projects (7-day grace window)"
            >
              <Archive className="h-3.5 w-3.5" />
              {t('nav.archived_projects', 'Archived projects')}
            </NavLink>
          )}
        </div>

        {/* User pill */}
        <div className="p-3 border-t border-border">
          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-8 w-8 rounded-md bg-brand text-brand-foreground flex items-center justify-center text-xs font-bold flex-shrink-0">
                {(user?.name ?? user?.email ?? '?').charAt(0).toUpperCase()}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="font-medium truncate text-sm">
                  {user?.name ?? user?.email}
                </span>
                <span className="nockta-eyebrow text-muted-foreground truncate">
                  {user?.companyRole ?? user?.kind}
                </span>
              </div>
            </div>
            <button
              onClick={() => {
                logout();
                navigate('/login');
              }}
              className="tap p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              aria-label={t('common.sign_out', 'Sign out')}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>

      <ProjectsPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        projects={projects}
        recentIds={recentIds}
        anchorRef={moreTriggerRef}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-between gap-2 px-3 md:px-4 bg-background/95 backdrop-blur-sm">
          {/* Hamburger toggle — only visible <md, where the sidebar is hidden. */}
          <button
            ref={hamburgerRef}
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={t('nav.toggle_menu', 'Toggle menu')}
            aria-expanded={mobileOpen}
            aria-controls="mobile-sidebar"
            className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <div className="md:hidden flex items-center gap-2">
            <NocktaLogo height={18} />
          </div>
          <div className="flex items-center gap-2 ms-auto">
            <ActiveTimerChip />
            <NotificationsBell />
          </div>
        </header>
        <main
          // pb-14 reserves space on mobile so content can scroll past the
          // fixed MobileBottomNav (which is sm:hidden). On sm+ the padding
          // collapses back to 0 because the bottom nav is gone.
          className="flex-1 overflow-auto focus:outline-none pb-14 sm:pb-0"
        >
          <PageTransition>
            <Outlet />
          </PageTransition>
        </main>
        {/* Bottom-nav: visible on mobile only. Sidebar/hamburger still works
            for deep project navigation; this gives one-tap access to the
            5 most-common destinations. */}
        <MobileBottomNav />
      </div>
    </div>
  );
}

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

function BoardsSection(): JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();
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
      title={t('nav.boards', 'Boards')}
      count={workspaceBoards.length}
      action={
        <Link
          to="/board"
          aria-label={t('nav.all_tasks_board', 'All-tasks board')}
          title={t('nav.all_tasks_board', 'All-tasks board')}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <LayoutGrid className="h-3 w-3" />
        </Link>
      }
    >
      {viewsQuery.isLoading ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">{t('nav.loading', 'Loading…')}</div>
      ) : workspaceBoards.length === 0 ? (
        <button
          type="button"
          onClick={() => navigate('/board')}
          className="w-full text-start text-xs px-2 py-1.5 rounded text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
          title={t('nav.save_board_from_filters', '+ Save a board from filters')}
        >
          {t('nav.save_board_from_filters', '+ Save a board from filters')}
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
            title={t('nav.open_board', 'Open the "{{name}}" board', { name: v.name })}
          >
            <Bookmark className="h-3.5 w-3.5" />
            <span className="truncate">{v.name}</span>
          </NavLink>
        ))
      )}
    </Section>
  );
}

// -----------------------------------------------------------------------------
// Section
// -----------------------------------------------------------------------------

function Section({
  title,
  count,
  action,
  children,
  storageKey,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** localStorage key for persisting open/closed state. Defaults to title. */
  storageKey?: string;
}): JSX.Element {
  const key = `nockta:sidebar:section:${storageKey ?? title.toLowerCase()}`;
  // Top-level sidebar sections (Personal / Projects / System) default to open;
  // a stored '0' means the user explicitly collapsed it.
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== '0';
    } catch {
      return true;
    }
  });
  function toggle(): void {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }
  return (
    <div>
      <div className="flex items-center justify-between px-1 mb-1 group/section">
        <button
          type="button"
          onClick={toggle}
          className="flex flex-1 items-center gap-1 px-1 py-0.5 rounded text-start hover:bg-accent/30 transition-colors"
          aria-expanded={open}
        >
          <ChevronRight
            className="h-2.5 w-2.5 text-muted-foreground/50 shrink-0 transition-transform duration-200 ease-out"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
          <span className="nockta-eyebrow text-muted-foreground/70 flex items-center gap-1.5">
            {title}
            {count !== undefined && (
              <span className="text-[10px] text-muted-foreground/50 font-medium">{count}</span>
            )}
          </span>
        </button>
        {action}
      </div>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Project tree item — single row, navigates straight to /projects/:id.
// -----------------------------------------------------------------------------

/**
 * Sidebar project row. Single click → /projects/:id (overview). All the per-
 * page navigation that used to live in a chevron-expand sub-menu (Board, List,
 * Backlog, Timeline, Docs, Automations, Settings) now lives in the
 * ProjectTabs strip at the top of each project page, so it's reachable in
 * one location and reflects which tab the user is on.
 *
 * `expanded`/`onToggle` are accepted but ignored so callers don't break; we
 * can clean those props up in a follow-up.
 */
function ProjectTreeItem({
  project,
}: {
  project: ProjectSummary;
  expanded?: boolean;
  onToggle?: () => void;
}): JSX.Element {
  const { projectId: activeProjectId } = useParams<{ projectId: string }>();
  const isActive = activeProjectId === project.id;
  const accent = projectAccent(project.key);

  return (
    <Link
      to={`/projects/${project.id}`}
      className={cn(
        'group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
        isActive
          ? 'bg-accent/70 text-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      <span
        className="shrink-0 h-5 w-5 rounded-md inline-flex items-center justify-center text-[10px] font-mono font-bold tracking-tight"
        style={{
          background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
          color: accent.fg,
        }}
        title={project.workflowPreset}
      >
        {project.key.slice(0, 2)}
      </span>
      <span className="truncate flex-1 text-start">{project.name}</span>
    </Link>
  );
}

/**
 * Generates a deterministic gradient + foreground color for a project key.
 * djb2 hash → hue rotated through a curated palette so each project has a
 * unique-but-tasteful badge in the sidebar. Pure function, no state.
 */
function projectAccent(key: string): { from: string; to: string; fg: string } {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  // Use HSL so the from/to are guaranteed-contrasting at the same lightness.
  return {
    from: `hsl(${hue}, 75%, 58%)`,
    to: `hsl(${(hue + 28) % 360}, 70%, 48%)`,
    fg: 'white',
  };
}

// -----------------------------------------------------------------------------
// Recent-projects tracker.
//
// Jira-style "Spaces" picker: we keep a small ordered list of recently-visited
// project ids in localStorage. The sidebar shows the top N inline; everything
// else lives behind the "More projects" popover. New visits push to the front,
// duplicates dedupe, the list is capped so it doesn't grow forever.
//
// Cross-tab sync via the `storage` event so opening a project in a second tab
// reorders the first tab's sidebar too.
// -----------------------------------------------------------------------------

const RECENT_PROJECTS_KEY = 'nockta:recent-projects';
const RECENT_PROJECTS_CAP = 20;

function readRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_PROJECTS_CAP);
  } catch {
    return [];
  }
}

function pushRecentProject(id: string): void {
  try {
    const current = readRecentProjects();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_PROJECTS_CAP);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
    // Notify same-tab listeners (the storage event only fires in *other* tabs).
    window.dispatchEvent(new CustomEvent('nockta:recent-projects-changed'));
  } catch {
    /* ignore */
  }
}

function useRecentProjects(): string[] {
  const [ids, setIds] = useState<string[]>(() => readRecentProjects());
  useEffect(() => {
    function refresh(): void {
      setIds(readRecentProjects());
    }
    window.addEventListener('storage', refresh);
    window.addEventListener('nockta:recent-projects-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('nockta:recent-projects-changed', refresh);
    };
  }, []);
  return ids;
}

// -----------------------------------------------------------------------------
// "More projects" sidebar trigger — replaces the long scrollable list with a
// single row that opens a searchable popover. Matches Jira's "More spaces".
// -----------------------------------------------------------------------------

const MoreProjectsTrigger = forwardRef<
  HTMLButtonElement,
  { totalCount: number; hiddenCount: number; onOpen: () => void }
>(function MoreProjectsTrigger({ totalCount, hiddenCount, onOpen }, ref): JSX.Element {
  const { t } = useTranslation();
  const ariaLabel = t('nav.show_all_projects', 'Show all {{count}} projects', {
    count: totalCount,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      className="group w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span className="shrink-0 h-5 w-5 inline-flex items-center justify-center rounded-md bg-muted/40 group-hover:bg-muted/70 transition-colors">
        <MoreHorizontal className="h-3 w-3" />
      </span>
      <span className="flex-1 text-start truncate">{t('nav.more_projects', 'More projects')}</span>
      <span className="text-[10px] text-muted-foreground/60">{hiddenCount}</span>
    </button>
  );
});

// -----------------------------------------------------------------------------
// Projects picker — Jira-style searchable popover. Anchored to the sidebar's
// "More projects" trigger via a fixed-position render. Portaled to document.body
// so the sidebar's overflow doesn't clip it.
//
// Behavior:
//   - Type to filter by name or key (case-insensitive).
//   - ↑/↓ to move highlight, Enter to navigate, Esc to close.
//   - Click any project row to navigate to /projects/:id.
//   - Footer link goes to /projects (full grid view).
//   - "Recent" cluster pinned at the top until the user starts searching.
// -----------------------------------------------------------------------------

function ProjectsPickerModal({
  open,
  onClose,
  projects,
  recentIds,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  projects: ProjectSummary[];
  recentIds: string[];
  anchorRef: React.RefObject<HTMLElement>;
}): JSX.Element | null {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Coords are fixed-position values computed from the anchor's bounding rect.
  // Recomputed on open, resize, and ancestor scroll so the popover always
  // tracks the trigger even if the sidebar scrolls.
  const [coords, setCoords] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;

    function reposition(): void {
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Popover width — wide enough to feel premium, narrow enough to feel
      // attached. Clamp to viewport on tiny screens.
      const popoverWidth = Math.min(440, vw - 24);
      // Position to the right of the sidebar, top-aligned to the trigger row.
      // 8px gap so it floats just clear of the sidebar border.
      let left = rect.right + 8;
      // If there's not enough room to the right (narrow viewport), fall back
      // to anchoring under the trigger inside the sidebar's column.
      if (left + popoverWidth > vw - 12) {
        left = Math.max(12, rect.left);
      }
      // Top-align with the trigger but keep at least 12px from the top edge.
      const top = Math.max(12, rect.top);
      const maxHeight = Math.max(240, vh - top - 24);
      setCoords({ top, left, maxHeight });
    }

    reposition();
    // Re-measure after first paint in case the popover changed size.
    const raf = window.requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, anchorRef]);

  // Reset state every time the picker opens so it always starts fresh.
  useLayoutEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlightIndex(0);
    // Autofocus after the paint so the popover animation doesn't fight it.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Build the rendered list. When the user is searching, hits are flat (no
  // section header). When idle, we group: Recent on top, Everything else
  // alphabetical below.
  const { recent, rest, flat } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const recentSet = new Set(recentIds);
    const recentList = projects
      .filter((p) => recentSet.has(p.id))
      .sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));
    const restList = projects
      .filter((p) => !recentSet.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (q) {
      const match = (p: ProjectSummary): boolean =>
        p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q);
      // Search results come back as a single flat list; recents that match
      // bubble to the top, the rest follow.
      const flatList = [...recentList.filter(match), ...restList.filter(match)];
      return { recent: [] as ProjectSummary[], rest: [] as ProjectSummary[], flat: flatList };
    }
    return { recent: recentList, rest: restList, flat: [...recentList, ...restList] };
  }, [projects, recentIds, query]);

  // Clamp highlight on filter change so it never points past the visible end.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = flat[highlightIndex];
        if (target) {
          pushRecentProject(target.id);
          navigate(`/projects/${target.id}`);
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, flat, highlightIndex, navigate]);

  if (!open || !coords) return null;

  return createPortal(
    <>
      {/* Transparent scrim — click anywhere outside to close. No backdrop
          darkening, since the popover is anchored to the sidebar rather than
          dominating the screen as a modal. */}
      <button
        type="button"
        aria-label={t('a11y.close', 'Close')}
        onClick={onClose}
        className="fixed inset-0 z-[80] cursor-default bg-transparent"
      />
      <div
        ref={popoverRef}
        className="animate-popover-in fixed z-[81] w-[440px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-popover shadow-2xl shadow-black/40 flex flex-col overflow-hidden"
        style={{
          top: coords.top,
          left: coords.left,
          maxHeight: coords.maxHeight,
          transformOrigin: 'top left',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Projects picker"
      >
        {/* Header: search */}
        <div className="px-3 py-2.5 border-b border-border flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search_dots', 'Search…')}
            className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] font-mono text-muted-foreground/60 border border-border rounded px-1 py-0.5">
            esc
          </kbd>
        </div>

        {/* Body: scrollable list */}
        <div className="flex-1 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {query
                ? t('nav.no_projects_match', 'No projects match "{{query}}"', { query })
                : t('nav.no_projects_yet', 'No projects yet.')}
            </div>
          ) : query ? (
            // Search mode — flat list, no headers.
            <ul className="px-1">
              {flat.map((p, i) => (
                <PickerRow
                  key={p.id}
                  project={p}
                  highlighted={i === highlightIndex}
                  onPick={() => {
                    pushRecentProject(p.id);
                    navigate(`/projects/${p.id}`);
                    onClose();
                  }}
                  onHover={() => setHighlightIndex(i)}
                />
              ))}
            </ul>
          ) : (
            <>
              {recent.length > 0 && (
                <PickerGroup label={t('nav.recent', 'Recent')}>
                  {recent.map((p, i) => (
                    <PickerRow
                      key={p.id}
                      project={p}
                      highlighted={i === highlightIndex}
                      onPick={() => {
                        pushRecentProject(p.id);
                        navigate(`/projects/${p.id}`);
                        onClose();
                      }}
                      onHover={() => setHighlightIndex(i)}
                    />
                  ))}
                </PickerGroup>
              )}
              {rest.length > 0 && (
                <PickerGroup label={t('nav.all_projects_label', 'All projects')}>
                  {rest.map((p, i) => {
                    const globalIndex = recent.length + i;
                    return (
                      <PickerRow
                        key={p.id}
                        project={p}
                        highlighted={globalIndex === highlightIndex}
                        onPick={() => {
                          pushRecentProject(p.id);
                          navigate(`/projects/${p.id}`);
                          onClose();
                        }}
                        onHover={() => setHighlightIndex(globalIndex)}
                      />
                    );
                  })}
                </PickerGroup>
              )}
            </>
          )}
        </div>

        {/* Footer: view-all link */}
        <div className="border-t border-border px-1 py-1">
          <Link
            to="/projects"
            onClick={onClose}
            className="flex items-center gap-2 px-2.5 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
          >
            <FolderKanban className="h-3.5 w-3.5" />
            <span className="flex-1">{t('nav.view_all_projects', 'View all projects')}</span>
            <kbd className="text-[10px] font-mono text-muted-foreground/60 border border-border rounded px-1 py-0.5">
              ↵
            </kbd>
          </Link>
        </div>
      </div>
    </>,
    document.body,
  );
}

function PickerGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="py-1">
      <div className="px-3 pt-1 pb-1 nockta-eyebrow text-muted-foreground/60">{label}</div>
      <ul className="px-1">{children}</ul>
    </div>
  );
}

function PickerRow({
  project,
  highlighted,
  onPick,
  onHover,
}: {
  project: ProjectSummary;
  highlighted: boolean;
  onPick: () => void;
  onHover: () => void;
}): JSX.Element {
  const accent = projectAccent(project.key);
  const rowRef = useRef<HTMLLIElement>(null);
  // Scroll the highlighted row into view when keyboard nav moves it offscreen.
  useEffect(() => {
    if (highlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [highlighted]);
  return (
    <li ref={rowRef}>
      <button
        type="button"
        onClick={onPick}
        onMouseMove={onHover}
        className={cn(
          'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-start transition-colors',
          highlighted
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
        )}
      >
        <span
          className="shrink-0 h-6 w-6 rounded-md inline-flex items-center justify-center text-[10px] font-mono font-bold tracking-tight"
          style={{
            background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
            color: accent.fg,
          }}
        >
          {project.key.slice(0, 2)}
        </span>
        <span className="flex-1 min-w-0 truncate">{project.name}</span>
        <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">{project.key}</span>
      </button>
    </li>
  );
}
