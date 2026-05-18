import { useQuery } from '@tanstack/react-query';
import { cn, NocktaLogo } from '@nockta/ui';
import {
  Archive, BarChart3, Calendar, FolderKanban, Inbox,
  LayoutDashboard, LayoutGrid, ListTodo, LogOut, Search, Settings, Sun, Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { useNotificationsSurface } from '../lib/use-notifications';
import { ActiveTimerChip } from './ActiveTimerChip';
import { NotificationsBell } from './NotificationsBell';
import { PageTransition } from './PageTransition';
import { BoardsSection } from './layout/boards-section';
import { MoreProjectsTrigger } from './layout/more-projects-trigger';
import { ProjectTreeItem } from './layout/project-tree-item';
import { ProjectsPickerModal } from './layout/projects-picker-modal';
import { pushRecentProject, useRecentProjects } from './layout/recent-projects';
import { Section } from './layout/section';
import type { ProjectSummary } from './layout/types';

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

// `client` flag marks links that are valid for external (kind=client) users.
// Internal team rituals (Standup, Workload, Analytics) and team-specific
// surfaces (My tasks / Calendar are tuned for internal sprint context) stay
// hidden for clients to keep their shell coherent.
const PERSONAL_LINKS = [
  { to: '/',          label: 'Dashboard',  icon: LayoutDashboard, end: true,  client: true  },
  { to: '/inbox',     label: 'Inbox',      icon: Inbox,           end: false, client: true  },
  { to: '/my-tasks',  label: 'My tasks',   icon: ListTodo,        end: false, client: false },
  { to: '/board',     label: 'All tasks',  icon: LayoutGrid,      end: false, client: true  },
  { to: '/standup',   label: 'Standup',    icon: Sun,             end: false, client: false },
  { to: '/calendar',  label: 'Calendar',   icon: Calendar,        end: false, client: false },
  { to: '/workload',  label: 'Workload',   icon: Users,           end: false, client: false },
  { to: '/analytics', label: 'Analytics',  icon: BarChart3,       end: false, client: false },
] as const;

export function Layout(): JSX.Element {
  const navigate = useNavigate();
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
          aria-label={'Close menu'}
          onClick={() => setMobileOpen(false)}
          className="md:hidden fixed inset-0 z-30 bg-black/50 cursor-default"
        />
      )}
      <aside
        ref={sidebarRef}
        id="mobile-sidebar"
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? 'Navigation' : undefined}
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
          <span className="flex-1 text-start">{'Search…'}</span>
          <kbd className="text-[10px] px-1 py-0.5 rounded border border-border">⌘K</kbd>
        </button>

        {/* Scrollable nav */}
        <nav className="flex-1 overflow-y-auto p-2 pt-3 space-y-4">
          <Section title={'Personal'}>
            {PERSONAL_LINKS.filter((link) =>
              user?.kind === 'client' ? link.client : true,
            ).map(({ to, label, icon: Icon, end }) => (
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
                {label}
              </NavLink>
            ))}
          </Section>

          {user?.kind !== 'client' && <BoardsSection />}

          <Section
            title={'Projects'}
            count={projects.length}
            action={
              <Link
                to="/projects"
                aria-label={'All projects'}
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
                  {'Loading…'}
                </div>
              ) : projects.length === 0 ? (
                <Link
                  to="/projects"
                  className="block text-xs px-2 py-1.5 rounded text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors"
                >
                  {'+ Create a project'}
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
            {'Settings'}
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
              {'Archived projects'}
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
              aria-label={'Sign out'}
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
            aria-label={'Toggle menu'}
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
        <main className="flex-1 overflow-auto focus:outline-none">
          <PageTransition>
            <Outlet />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
