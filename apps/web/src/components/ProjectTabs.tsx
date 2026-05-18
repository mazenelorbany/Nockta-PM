import {
  BarChart3,
  FileText,
  Gauge,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Pin,
  PinOff,
  Rocket,
  Settings as SettingsIcon,
  Timer,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@nockta/ui';

import { useAuth } from '../lib/auth-store';
import {
  type DefaultProjectView,
  getDefaultProjectView,
  setDefaultProjectView,
} from '../lib/default-project-view';

// =============================================================================
// ProjectTabs — Linear-style horizontal tab strip that lives at the top of
// every project page. Replaces the pile of inline buttons the project pages
// used to carry in their headers ("Backlog", "Docs", "Automations", "Settings"
// next to "Start standup" and "New task").
//
// One persistent navigation row instead of three locations (sidebar sub-menu,
// header buttons, toolbar view toggles) means the user always knows where to
// click to switch between Board / List / Backlog / Timeline / Docs /
// Automations / Settings.
//
// Active state is derived from the location: which path the user is on AND
// the `view=list` query param on the board route (so Board vs List feel like
// peer tabs even though they share /board).
// =============================================================================

interface ProjectTabsProps {
  projectId: string;
  /** Extra content rendered to the right of the tab strip — typically project
   *  action buttons like "Start standup" or "New task". Keeps related controls
   *  in one row so the page header stays compact. */
  actions?: React.ReactNode;
}

interface TabSpec {
  /** Identifier used for active-state matching. */
  key:
    | 'dashboard'
    | 'board'
    | 'list'
    | 'backlog'
    | 'timeline'
    | 'docs'
    | 'automations'
    | 'worklog'
    | 'deployments'
    | 'settings';
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string | undefined }>;
  /** When true, render as a trailing gear-icon button instead of a labeled tab. */
  trailingIcon?: boolean;
  /** Whether this tab is meaningful for external (kind=client) users.
   *  Internal operations surfaces (Automations, Worklog, Deployments) and
   *  Manager-only ones (Settings) stay hidden for clients. */
  client?: boolean;
}

export function ProjectTabs({ projectId, actions }: ProjectTabsProps): JSX.Element {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  const user = useAuth((s) => s.user);
  const isClient = user?.kind === 'client';

  // Build the tabs list once per render. The `view=list` query param flips
  // Board ↔ List without a route change, so we treat List as a peer tab.
  const tabs: TabSpec[] = [
    {
      key: 'dashboard',
      to: `/projects/${projectId}/dashboard`,
      label: 'Dashboard',
      icon: Gauge,
      client: true,
    },
    { key: 'board', to: `/projects/${projectId}/board`, label: 'Board', icon: LayoutDashboard, client: true },
    {
      key: 'list',
      to: `/projects/${projectId}/board?view=list`,
      label: 'List',
      icon: ListTodo,
      client: true,
    },
    { key: 'backlog', to: `/projects/${projectId}/backlog`, label: 'Backlog', icon: Inbox, client: true },
    { key: 'timeline', to: `/projects/${projectId}/timeline`, label: 'Timeline', icon: BarChart3, client: true },
    { key: 'docs', to: `/projects/${projectId}/docs`, label: 'Docs', icon: FileText, client: true },
    {
      key: 'automations',
      to: `/projects/${projectId}/automations`,
      label: 'Automations',
      icon: Zap,
      client: false,
    },
    {
      key: 'worklog',
      to: `/projects/${projectId}/worklog`,
      label: 'Worklog',
      icon: Timer,
      client: false,
    },
    {
      key: 'deployments',
      to: `/projects/${projectId}/deployments`,
      label: 'Deployments',
      icon: Rocket,
      client: false,
    },
    {
      key: 'settings',
      to: `/projects/${projectId}/settings`,
      label: 'Settings',
      icon: SettingsIcon,
      trailingIcon: true,
      client: false,
    },
  ];
  const visibleTabs = isClient ? tabs.filter((t) => t.client !== false) : tabs;

  const activeKey: TabSpec['key'] = (() => {
    const p = location.pathname;
    if (p.endsWith('/dashboard')) return 'dashboard';
    if (p.endsWith('/backlog')) return 'backlog';
    if (p.endsWith('/timeline')) return 'timeline';
    if (p.includes('/docs')) return 'docs';
    if (p.endsWith('/automations')) return 'automations';
    if (p.endsWith('/worklog')) return 'worklog';
    if (p.endsWith('/deployments')) return 'deployments';
    if (p.endsWith('/settings')) return 'settings';
    if (p.endsWith('/board')) {
      return search.get('view') === 'list' ? 'list' : 'board';
    }
    // /projects/:id (overview) doesn't match any tab — leave the row visible
    // but with nothing highlighted so the user can pick where to go.
    return 'board';
  })();

  // Split into labeled tabs and trailing icon tabs.
  const labeled = visibleTabs.filter((t) => !t.trailingIcon);
  const trailing = visibleTabs.filter((t) => t.trailingIcon);

  // Default-view pin. The active tab is "pinnable" iff it's one of the
  // legal default-view values (board / dashboard / list / backlog / timeline).
  // Tabs like Docs / Automations / Worklog / Deployments aren't worth
  // making someone's project home, so the pin button is hidden there.
  const PINNABLE: readonly TabSpec['key'][] = ['board', 'dashboard', 'list', 'backlog', 'timeline'];
  const isPinnable = (PINNABLE as readonly string[]).includes(activeKey);
  const [defaultView, setDefaultViewState] = useState<DefaultProjectView>(() => getDefaultProjectView());
  const isCurrentDefault = isPinnable && defaultView === (activeKey as DefaultProjectView);
  const onPin = (): void => {
    if (!isPinnable) return;
    setDefaultProjectView(activeKey as DefaultProjectView);
    setDefaultViewState(activeKey as DefaultProjectView);
    toast.success(`Default project view set to ${activeKey}`);
  };

  return (
    // Project sub-nav — Board / List / Backlog / Timeline / Docs / Automations
    // is too many to wrap on a phone. Horizontal scroll lives on the labeled-
    // tabs <ul> itself (not the parent <nav>) so the trailing icons (pin +
    // settings + Start standup + New task) stay pinned to the right edge
    // instead of being overrun by the tabs on narrow viewports.
    <nav className="px-4 sm:px-6 md:px-8 border-b border-border flex items-center gap-2">
      <ul className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
        {labeled.map((t) => {
          const Icon = t.icon;
          const isActive = t.key === activeKey;
          return (
            <li key={t.key} className="relative shrink-0">
              <Link
                to={t.to}
                replace={t.key === 'list' || t.key === 'board'}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 h-10 text-sm transition-colors',
                  isActive
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{t.label}</span>
              </Link>
              {/* Active underline — sits flush with the bottom border of the row */}
              {isActive && (
                <span
                  className="absolute left-2 right-2 bottom-0 h-0.5 rounded-t bg-brand"
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-1 shrink-0">
        {isPinnable && (
          <button
            type="button"
            onClick={onPin}
            aria-pressed={isCurrentDefault}
            aria-label={
              isCurrentDefault
                ? `${activeKey} is your default project view`
                : `Pin ${activeKey} as default project view`
            }
            title={
              isCurrentDefault
                ? `${activeKey} is your default project view`
                : `Make ${activeKey} the default view when opening a project`
            }
            className={cn(
              'inline-flex items-center justify-center w-9 h-9 rounded-md transition-colors',
              isCurrentDefault
                ? 'text-brand'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            {isCurrentDefault ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
          </button>
        )}
        {trailing.map((t) => {
          const Icon = t.icon;
          const isActive = t.key === activeKey;
          return (
            <Link
              key={t.key}
              to={t.to}
              className={cn(
                'inline-flex items-center justify-center w-9 h-9 rounded-md transition-colors',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
              aria-label={t.label}
              title={t.label}
            >
              <Icon className="h-4 w-4" />
            </Link>
          );
        })}
        {actions && (
          <div className="ml-1 pl-2 border-l border-border flex items-center gap-2">{actions}</div>
        )}
      </div>
    </nav>
  );
}
