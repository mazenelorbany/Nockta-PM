import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Database,
  FileText,
  Layers,
  MessageSquare,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { ProjectTabs } from '../components/ProjectTabs';
import { AvatarCircle } from '../components/task-bits';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';
import { api } from '../lib/api';

// =============================================================================
// /projects/:projectId/settings — edit project metadata, sprints/github toggles,
// chat broadcast config, access grants, archive.
// =============================================================================

interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'teams' | 'private';
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
  githubAutoStatus: boolean;
  maxAttachmentMb: number;
  chatSpaceId: string | null;
  chatBroadcastEvents: string[];
  /** When 'client_visible', guests on this project see every task regardless
   *  of the per-task visibility flag, and new tasks default to client-visible. */
  defaultTaskVisibility: 'internal' | 'client_visible';
  archivedAt: string | null;
}

interface Access {
  id: string;
  subjectKind: 'user' | 'team';
  userId: string | null;
  teamId: string | null;
  role: 'Manager' | 'Contributor' | 'Viewer' | 'Client';
  user?: { id: string; name: string; email: string } | null;
  team?: { id: string; slug: string; name: string } | null;
}

const BROADCAST_EVENTS = [
  'SprintStarted',
  'SprintCompleted',
  'DeploymentSucceeded',
  'DeploymentFailed',
  'ProductionReleaseTagged',
  'CriticalTaskBlocked',
  'ClientReportedBug',
];

export function ProjectSettingsPage(): JSX.Element {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => api.get<Access[]>(`/projects/${projectId}/access`),
    enabled: Boolean(projectId),
  });

  const project = projectQuery.data;

  const [draft, setDraft] = useState<Project | null>(null);
  useEffect(() => {
    if (project) setDraft(project);
  }, [project]);

  /**
   * Dirty flag — derived directly from a draft↔server diff on every render so
   * it never gets out of sync with the actual unsaved state. Text fields (name,
   * description, chatSpaceId, maxAttachmentMb) commit on blur, so there's a
   * real window between typing and saving where this page is dirty.
   */
  const dirty = useMemo(() => {
    if (!project || !draft) return false;
    return (
      draft.name !== project.name ||
      (draft.description ?? '') !== (project.description ?? '') ||
      (draft.chatSpaceId ?? '') !== (project.chatSpaceId ?? '') ||
      draft.maxAttachmentMb !== project.maxAttachmentMb
    );
  }, [draft, project]);

  // Track dirty state in a ref so the navigation-blocking effects don't need
  // to re-attach their listeners on every keystroke.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  /**
   * Tab-close + refresh guard. Modern browsers ignore returnValue contents and
   * show their own dialog, but they DO honour the "I'm preventing default"
   * signal which is all we need.
   */
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      if (!dirtyRef.current) return;
      e.preventDefault();
      // Legacy browsers still surface this string; modern ones use their own.
      e.returnValue = 'You have unsaved changes';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /**
   * Internal-link guard. We're on a BrowserRouter (not a data router) so
   * `useBlocker` isn't available — instead we intercept clicks on every
   * <a> in capture phase. Cheap because the listener exits in O(1) when the
   * page isn't dirty, and we never block external-target links or modified
   * clicks (cmd/ctrl/middle).
   */
  useEffect(() => {
    function onClick(e: MouseEvent): void {
      if (!dirtyRef.current) return;
      // Modified clicks open in a new tab anyway, so the current page (with
      // dirty state) doesn't navigate.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const anchor = (e.target as HTMLElement | null)?.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      // Same-page hashes are fine — they're for the rail's section nav.
      if (href.startsWith('#')) return;
      // External targets open in a new tab, so the dirty page stays put.
      if (anchor.target && anchor.target !== '_self') return;
      // Absolute URLs to a different origin route as external; let them go.
      if (/^[a-z]+:/i.test(href) && !href.startsWith(window.location.origin)) return;
      const ok = window.confirm('You have unsaved changes — leave anyway?');
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  /**
   * Back-button + programmatic-navigation guard. Detect a pathname change
   * (the rail's hash-only changes don't change pathname) and, if dirty, ask
   * the user. If they cancel we push back to the previous pathname.
   *
   * We track the last "approved" pathname so the rollback push doesn't itself
   * re-trigger the prompt.
   */
  const approvedPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname === approvedPath.current) return;
    if (!dirtyRef.current) {
      approvedPath.current = location.pathname;
      return;
    }
    const ok = window.confirm('You have unsaved changes — leave anyway?');
    if (ok) {
      approvedPath.current = location.pathname;
    } else {
      // Roll back. We can't synchronously prevent the navigation that just
      // happened, but pushing the previous path restores it in the URL bar
      // and (because <Routes> reads location) flips the rendered view back.
      navigate(approvedPath.current, { replace: true });
    }
  }, [location.pathname, navigate]);

  const updateMutation = useMutation({
    mutationFn: (patch: Partial<Project>) =>
      api.patch<Project>(`/projects/${projectId}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Saved');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Save failed')),
  });

  const archiveMutation = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}`),
    onSuccess: () => {
      toast.success('Project archived');
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate('/projects');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Archive failed')),
  });

  function patch<K extends keyof Project>(key: K, value: Project[K]): void {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  }

  function commit<K extends keyof Project>(key: K): void {
    if (!draft || !project) return;
    if (draft[key] === project[key]) return;
    updateMutation.mutate({ [key]: draft[key] } as Partial<Project>);
  }

  function toggleBroadcastEvent(event: string): void {
    if (!draft) return;
    const next = draft.chatBroadcastEvents.includes(event)
      ? draft.chatBroadcastEvents.filter((e) => e !== event)
      : [...draft.chatBroadcastEvents, event];
    setDraft({ ...draft, chatBroadcastEvents: next });
    updateMutation.mutate({ chatBroadcastEvents: next });
  }

  /**
   * On initial mount (and on any subsequent hash change) scroll the target
   * section into view. We use scrollIntoView with smooth behavior because the
   * page is short enough that a hard jump feels jarring; sections have
   * scroll-mt-32 (account for header + ProjectTabs strip) so the title
   * doesn't end up under page chrome.
   */
  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.slice(1);
    // Wait a tick so the section has been rendered before we try to scroll.
    const t = window.setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => window.clearTimeout(t);
  }, [location.hash]);

  // Access summary chips at the top of the page give a Manager a one-glance
  // read on who has what before they dig in. Computed unconditionally so the
  // hook order stays stable across the load → loaded transition (Rules of
  // Hooks: never put hooks below early returns).
  const grantSummary = useMemo(() => {
    const grants = accessQuery.data ?? [];
    let members = 0;
    let teams = 0;
    let guests = 0;
    for (const g of grants) {
      if (g.subjectKind === 'team') teams += 1;
      else if (g.role === 'Client') guests += 1;
      else members += 1;
    }
    return { members, teams, guests, total: grants.length };
  }, [accessQuery.data]);

  if (!project || !draft) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
            {project.key}
          </span>
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">{project.name}</h1>
          <span className="text-muted-foreground/60 hidden sm:inline">·</span>
          <span className="text-sm text-muted-foreground hidden sm:inline">Settings</span>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-priority-medium/15 text-priority-medium font-semibold"
              title="You have edits that haven't saved yet. Click outside the field, or change focus, to commit."
            >
              Unsaved
            </span>
          )}
          {project.archivedAt && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-status-blocked/15 text-status-blocked font-semibold">
              Archived
            </span>
          )}
        </div>
      </header>

      <ProjectTabs projectId={projectId ?? ''} />

      {/* Two-column layout: anchor nav on the left, content on the right.
          The right column is the only thing that scrolls, so the nav stays
          put as the user scans long Custom-fields / Templates sections.
          Mobile: nav collapses; content is the full width. */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <SettingsRail
          archived={Boolean(project.archivedAt)}
          accessTotal={grantSummary.total}
        />
        <div className="flex-1 overflow-auto">
          <div className="px-4 sm:px-6 md:px-10 py-6 sm:py-8 space-y-10 max-w-4xl">
            {/* ============ Overview ============ */}
            <Section
              id="overview"
              icon={<SettingsIcon className="h-4 w-4" />}
              title="Overview"
              hint="The basics — name, description, visibility, workflow."
            >
              <Field label="Name">
                <input
                  value={draft.name}
                  onChange={(e) => patch('name', e.target.value)}
                  onBlur={() => commit('name')}
                  maxLength={120}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Description">
                <textarea
                  rows={3}
                  value={draft.description ?? ''}
                  onChange={(e) => patch('description', e.target.value)}
                  onBlur={() => commit('description')}
                  maxLength={2000}
                  placeholder="What this project is about — visible to everyone with access."
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field
                  label="Visibility"
                  hint={
                    draft.visibility === 'public'
                      ? 'Every workspace member can see this project (read-only) without a grant.'
                      : draft.visibility === 'teams'
                        ? 'Only teams + people listed under Access can see it.'
                        : 'Tightly locked — only people in the Access list can see it.'
                  }
                >
                  <select
                    value={draft.visibility}
                    onChange={(e) => {
                      const v = e.target.value as Project['visibility'];
                      setDraft({ ...draft, visibility: v });
                      updateMutation.mutate({ visibility: v });
                    }}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="public">Public</option>
                    <option value="teams">Teams only</option>
                    <option value="private">Private</option>
                  </select>
                </Field>
                <Field label="Workflow preset" hint="Immutable after project creation.">
                  <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-sm text-muted-foreground capitalize">
                    {draft.workflowPreset}
                  </div>
                </Field>
              </div>
            </Section>

            {/* ============ Access ============ */}
            <Section
              id="access"
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Access"
              hint="Who can see this project, and at what level. Members are internal teammates. Teams roll up everyone on the team. Guests use the client portal and only see what's marked client-visible."
            >
              {/* Chips strip — quick read on the shape of access. Clickable
                  to scroll to the relevant subsection below. */}
              <div className="flex flex-wrap gap-2 mb-1">
                <AccessChip
                  label="Members"
                  count={grantSummary.members}
                  icon={<Users className="h-3 w-3" />}
                  href="#access-members"
                />
                <AccessChip
                  label="Teams"
                  count={grantSummary.teams}
                  icon={<Layers className="h-3 w-3" />}
                  href="#access-teams"
                />
                <AccessChip
                  label="Guests"
                  count={grantSummary.guests}
                  icon={<Sparkles className="h-3 w-3" />}
                  tone="guest"
                  href="#access-guests"
                />
              </div>

              {/* Guest sharing mode — sits ABOVE the grant manager so it's the
                  first decision a Manager makes when configuring access. The
                  default ("Per-task") matches the legacy strict behavior; the
                  Open option is what most client engagements want. */}
              <GuestSharingMode
                value={draft.defaultTaskVisibility}
                onChange={(v) => {
                  setDraft({ ...draft, defaultTaskVisibility: v });
                  updateMutation.mutate({ defaultTaskVisibility: v });
                }}
                hasGuests={grantSummary.guests > 0}
              />

              <ProjectAccessManager
                projectId={projectId}
                grants={accessQuery.data ?? []}
                loading={accessQuery.isLoading}
              />
            </Section>

            {/* ============ Workflow ============ */}
            <Section
              id="workflow"
              icon={<Workflow className="h-4 w-4" />}
              title="Workflow"
              hint="How work flows through this project — sprints, GitHub automation, file sizes."
            >
              <ToggleRow
                label="Sprints"
                hint="Turn on Scrum-style sprint planning. Adds the Sprints UI to the Backlog tab."
                checked={draft.sprintsEnabled}
                onChange={(v) => {
                  setDraft({ ...draft, sprintsEnabled: v });
                  updateMutation.mutate({ sprintsEnabled: v });
                }}
              />
              <ToggleRow
                label="GitHub auto-status"
                hint="PR / commit events transition linked tasks automatically (e.g. PR merged → Testing)."
                checked={draft.githubAutoStatus}
                onChange={(v) => {
                  setDraft({ ...draft, githubAutoStatus: v });
                  updateMutation.mutate({ githubAutoStatus: v });
                }}
              />
              <Field
                label="Per-file upload cap (MB)"
                hint="1..500. Default 100. Enforced on every attachment uploaded into this project."
              >
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={draft.maxAttachmentMb}
                  onChange={(e) =>
                    patch('maxAttachmentMb', Math.max(1, Math.min(500, Number(e.target.value) || 1)))
                  }
                  onBlur={() => commit('maxAttachmentMb')}
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm w-32"
                />
              </Field>
            </Section>

            {/* ============ Integrations ============ */}
            <Section
              id="integrations"
              icon={<MessageSquare className="h-4 w-4" />}
              title="Integrations"
              hint="Where this project broadcasts its events outside Nockta."
            >
              <Field label="Google Chat space ID" hint="Find this in the space URL: spaces/AAAA…">
                <input
                  value={draft.chatSpaceId ?? ''}
                  onChange={(e) => patch('chatSpaceId', e.target.value || null)}
                  onBlur={() => commit('chatSpaceId')}
                  placeholder="spaces/AAAA…"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                />
              </Field>
              <div>
                <div className="nockta-eyebrow text-muted-foreground mb-2">
                  Events to broadcast
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {BROADCAST_EVENTS.map((ev) => {
                    const on = draft.chatBroadcastEvents.includes(ev);
                    return (
                      <button
                        key={ev}
                        type="button"
                        onClick={() => toggleBroadcastEvent(ev)}
                        className={cn(
                          'rounded-md border px-2.5 py-1.5 text-xs text-left transition-colors',
                          on
                            ? 'border-brand/50 bg-accent text-foreground'
                            : 'border-border bg-background/40 text-muted-foreground hover:text-foreground hover:bg-accent/40',
                        )}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              on ? 'bg-brand' : 'bg-muted-foreground/40',
                            )}
                          />
                          {prettyEventName(ev)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </Section>

            {/* ============ Custom fields ============ */}
            <Section
              id="custom-fields"
              icon={<Database className="h-4 w-4" />}
              title="Custom fields"
              hint="Per-project user-defined fields shown on every task in this project."
            >
              <CustomFieldsAdmin projectId={projectId} />
            </Section>

            {/* ============ Templates ============ */}
            <Section
              id="templates"
              icon={<FileText className="h-4 w-4" />}
              title="Task templates"
              hint="Reusable task blueprints. Create one via 'Save as template' in any task drawer."
            >
              <TaskTemplatesAdmin projectId={projectId} />
            </Section>

            {/* ============ Danger ============ */}
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
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// SettingsRail — left-side anchor navigation. Updates the URL hash on click
// so deep-links work (`/projects/:id/settings#access`), and supports keyboard
// navigation: Up/Down cycle through entries (focus only), Enter navigates.
// Stays sticky as the user moves through the sections.
// =============================================================================

function SettingsRail({
  archived,
  accessTotal,
}: {
  archived: boolean;
  accessTotal: number;
}): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const railRef = useRef<HTMLElement | null>(null);

  const items: { href: string; label: string; icon: JSX.Element; tail?: string | undefined }[] = [
    { href: '#overview', label: 'Overview', icon: <SettingsIcon className="h-3.5 w-3.5" /> },
    {
      href: '#access',
      label: 'Access',
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      tail: accessTotal > 0 ? String(accessTotal) : undefined,
    },
    { href: '#workflow', label: 'Workflow', icon: <Workflow className="h-3.5 w-3.5" /> },
    {
      href: '#integrations',
      label: 'Integrations',
      icon: <MessageSquare className="h-3.5 w-3.5" />,
    },
    {
      href: '#custom-fields',
      label: 'Custom fields',
      icon: <Database className="h-3.5 w-3.5" />,
    },
    { href: '#templates', label: 'Templates', icon: <FileText className="h-3.5 w-3.5" /> },
    {
      href: '#danger',
      label: 'Danger zone',
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    },
  ];

  /**
   * Keyboard nav. Up/Down move focus between rail entries, Enter activates the
   * focused entry, Home/End jump to first/last. Listens at the <aside> level
   * via React's onKeyDown so we don't pollute the global document listeners.
   *
   * Focus management is left to the browser's default <a> focus behavior; we
   * only intervene to redirect arrow keys.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const root = railRef.current;
      if (!root) return;
      const links = Array.from(
        root.querySelectorAll<HTMLAnchorElement>('a[data-rail-item]'),
      );
      if (links.length === 0) return;
      const activeIdx = links.findIndex((l) => l === document.activeElement);

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        // If no rail item is focused yet, start at the top (Down) or bottom (Up).
        let nextIdx: number;
        if (activeIdx === -1) {
          nextIdx = e.key === 'ArrowDown' ? 0 : links.length - 1;
        } else {
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          nextIdx = (activeIdx + dir + links.length) % links.length;
        }
        links[nextIdx]?.focus();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        links[0]?.focus();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        links[links.length - 1]?.focus();
        return;
      }
      // Enter on a focused rail link triggers a normal click. We don't need
      // to do anything — the browser already fires the click handler — but
      // we surface it here so future maintainers can find the keymap.
    },
    [],
  );

  return (
    <aside
      ref={railRef}
      onKeyDown={onKeyDown}
      role="navigation"
      aria-label="Project settings sections"
      className="hidden md:flex w-56 shrink-0 border-r border-border flex-col overflow-y-auto p-3 gap-0.5"
    >
      {items.map((i) => {
        const active = location.hash === i.href;
        return (
          <a
            key={i.href}
            href={i.href}
            data-rail-item
            {...(active ? { 'aria-current': 'true' as const } : {})}
            onClick={(e) => {
              // Intercept so we push the hash through React Router's location.
              // This makes the deep-link round-trip work: `useEffect[location.hash]`
              // on the page sees the change and scrolls the section into view.
              // Default <a href="#x"> works too, but it doesn't update React
              // Router's location object — so our scroll effect wouldn't fire.
              e.preventDefault();
              navigate(`${location.pathname}${i.href}`, { replace: false });
            }}
            className={cn(
              'group flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40',
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  'shrink-0',
                  i.href === '#danger' ? 'text-destructive/70' : 'text-muted-foreground/70',
                )}
              >
                {i.icon}
              </span>
              <span className="truncate">{i.label}</span>
            </span>
            {i.tail && (
              <span className="text-[10px] font-mono text-muted-foreground/70 group-hover:text-foreground/70 shrink-0">
                {i.tail}
              </span>
            )}
          </a>
        );
      })}
      {archived && (
        <div className="mt-3 rounded-md border border-status-blocked/30 bg-status-blocked/5 px-2.5 py-2 text-[10px] text-status-blocked">
          This project is archived. Most actions are disabled.
        </div>
      )}
    </aside>
  );
}

function GuestSharingMode({
  value,
  onChange,
  hasGuests,
}: {
  value: 'internal' | 'client_visible';
  onChange: (v: 'internal' | 'client_visible') => void;
  hasGuests: boolean;
}): JSX.Element {
  // Two clearly-labeled cards rather than a toggle, because the implication
  // ("guests see every task" vs "guests see nothing by default") needs more
  // than a single sentence to land. Card layout keeps the chosen mode
  // visually obvious.
  const opts: {
    value: 'internal' | 'client_visible';
    label: string;
    body: string;
  }[] = [
    {
      value: 'internal',
      label: 'Curated',
      body:
        'Guests only see tasks marked client-visible. Default — picks safer for projects with sensitive internal work alongside client deliverables.',
    },
    {
      value: 'client_visible',
      label: 'Open',
      body:
        'Guests see every task on the project. New tasks default to client-visible. Use this when the whole project IS the client deliverable.',
    },
  ];
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <div className="text-xs font-semibold tracking-tight">Guest sharing mode</div>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            What guests on this project see by default. You can still flip any
            individual task with the visibility toggle in its drawer.
          </p>
        </div>
        {!hasGuests && (
          <span className="text-[10px] text-muted-foreground/60 italic shrink-0 ml-2">
            No guests yet — this setting kicks in when you add one.
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {opts.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                'text-left rounded-md border px-3 py-2.5 transition-colors',
                active
                  ? 'border-brand bg-brand/10 ring-1 ring-brand/30'
                  : 'border-border bg-background/40 hover:bg-accent/40 hover:border-foreground/20',
              )}
              aria-pressed={active}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className={cn(
                    'text-sm font-semibold',
                    active ? 'text-brand' : 'text-foreground',
                  )}
                >
                  {opt.label}
                </span>
                <span
                  className={cn(
                    'h-3 w-3 rounded-full border',
                    active ? 'border-brand bg-brand' : 'border-border bg-background',
                  )}
                  aria-hidden="true"
                />
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {opt.body}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AccessChip({
  label,
  count,
  icon,
  href,
  tone,
}: {
  label: string;
  count: number;
  icon: JSX.Element;
  href: string;
  tone?: 'guest';
}): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <a
      href={href}
      onClick={(e) => {
        // Push through React Router so the page-level hash-scroll effect fires.
        e.preventDefault();
        navigate(`${location.pathname}${href}`);
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        count > 0
          ? tone === 'guest'
            ? 'border-priority-medium/40 bg-priority-medium/5 text-foreground hover:bg-priority-medium/10'
            : 'border-brand/40 bg-brand/5 text-foreground hover:bg-brand/10'
          : 'border-border bg-card/40 text-muted-foreground hover:text-foreground hover:bg-accent/40',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{count}</span>
    </a>
  );
}

// =============================================================================
// CustomFieldsAdmin — manage per-project custom field definitions.
//
// Round 6 / Pass C extends this beyond the original text/number/select scope
// with three new field shapes:
//   - formula  — read-only expression evaluated server-side at fetch time
//   - rollup   — aggregate over subtasks or linked tasks
//   - any kind — can carry a `visibilityRule` that hides it conditionally
//
// The editor uses the API's parse-only `validate-formula` endpoint (debounced
// 500ms) for live syntax checking, and the per-field `:id/validate-formula`
// endpoint for the "Test expression" button which evaluates against a real
// task and returns a sampleResult preview.
// =============================================================================

type FieldKind =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'url'
  | 'checkbox'
  | 'formula'
  | 'rollup';

interface RollupConfig {
  relation: 'subtasks' | 'linkedTasks';
  field: string;
  agg: 'sum' | 'avg' | 'min' | 'max' | 'count';
}

interface VisibilityRule {
  when: {
    fieldKey: string;
    op: 'equals' | 'in' | 'isSet';
    value?: unknown;
  };
}

interface CustomFieldDef {
  id: string;
  name: string;
  kind: FieldKind;
  options: { value: string; label: string; color?: string }[];
  required: boolean;
  position: number;
  formulaExpression?: string | null;
  rollupConfig?: RollupConfig | null;
  visibilityRule?: VisibilityRule | null;
}

function CustomFieldsAdmin({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const fieldsQuery = useQuery({
    queryKey: ['custom-fields', projectId],
    queryFn: () => api.get<CustomFieldDef[]>(`/projects/${projectId}/custom-fields`),
  });
  const [draft, setDraft] = useState<{
    name: string;
    kind: FieldKind;
    optionsText: string;
    required: boolean;
    formulaExpression: string;
    rollupRelation: 'subtasks' | 'linkedTasks';
    rollupField: string;
    rollupAgg: RollupConfig['agg'];
    visibilityEnabled: boolean;
    visibilityFieldKey: string;
    visibilityOp: 'equals' | 'in' | 'isSet';
    visibilityValue: string;
  }>({
    name: '',
    kind: 'text',
    optionsText: '',
    required: false,
    formulaExpression: '',
    rollupRelation: 'subtasks',
    rollupField: 'estimate',
    rollupAgg: 'sum',
    visibilityEnabled: false,
    visibilityFieldKey: '',
    visibilityOp: 'equals',
    visibilityValue: '',
  });

  // Live formula syntax check — debounced 500ms. The user gets a green
  // "Valid" or a red error inline, and the Add button stays enabled either
  // way (we don't block the server-side recheck on the editor's opinion).
  const [formulaSyntax, setFormulaSyntax] = useState<{ ok: boolean; error?: string } | null>(null);
  useEffect(() => {
    if (draft.kind !== 'formula' || !draft.formulaExpression.trim()) {
      setFormulaSyntax(null);
      return;
    }
    const t = setTimeout(() => {
      void api
        .post<{ ok: boolean; error?: string }>('/custom-fields/validate-formula', {
          expression: draft.formulaExpression,
        })
        .then(setFormulaSyntax)
        .catch(() => setFormulaSyntax({ ok: false, error: 'Server unreachable' }));
    }, 500);
    return () => clearTimeout(t);
  }, [draft.kind, draft.formulaExpression]);

  // Same debounce for the visibility-rule expression-like input. We DON'T
  // call the formula validator for visibility (the schema differs — it's a
  // structured rule, not a free expression), so the check is purely
  // structural: fieldKey must be non-empty.
  const visibilityValid =
    !draft.visibilityEnabled ||
    (draft.visibilityFieldKey.trim() !== '' &&
      (draft.visibilityOp === 'isSet' || draft.visibilityValue.trim() !== ''));

  const create = useMutation({
    mutationFn: () => {
      const needsOptions = draft.kind === 'select' || draft.kind === 'multiselect';
      const options = needsOptions
        ? draft.optionsText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((label) => ({ value: label, label }))
        : undefined;
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        kind: draft.kind,
        options,
        required: draft.required,
      };
      if (draft.kind === 'formula') {
        body.formulaExpression = draft.formulaExpression.trim();
      }
      if (draft.kind === 'rollup') {
        body.rollupConfig = {
          relation: draft.rollupRelation,
          field: draft.rollupField.trim(),
          agg: draft.rollupAgg,
        } satisfies RollupConfig;
      }
      if (draft.visibilityEnabled && draft.visibilityFieldKey.trim()) {
        let value: unknown = draft.visibilityValue;
        if (draft.visibilityOp === 'in') {
          value = draft.visibilityValue
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        } else if (draft.visibilityOp === 'isSet') {
          value = undefined;
        }
        body.visibilityRule = {
          when: {
            fieldKey: draft.visibilityFieldKey.trim(),
            op: draft.visibilityOp,
            ...(value !== undefined ? { value } : {}),
          },
        } satisfies VisibilityRule;
      }
      return api.post(`/projects/${projectId}/custom-fields`, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-fields', projectId] });
      setDraft({
        name: '',
        kind: 'text',
        optionsText: '',
        required: false,
        formulaExpression: '',
        rollupRelation: 'subtasks',
        rollupField: 'estimate',
        rollupAgg: 'sum',
        visibilityEnabled: false,
        visibilityFieldKey: '',
        visibilityOp: 'equals',
        visibilityValue: '',
      });
      setFormulaSyntax(null);
      toast.success('Field created');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Create failed')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/custom-fields/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-fields', projectId] });
    },
  });

  // Section header is rendered by the outer page; this component just emits
  // its content so it can sit cleanly inside the unified Section frame.
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {(fieldsQuery.data ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">No custom fields yet.</p>
        )}
        {(fieldsQuery.data ?? []).map((f) => (
          <div key={f.id} className="flex items-center gap-3 rounded-md border border-border bg-card/40 px-3 py-2 text-xs">
            <span className="font-medium">{f.name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
              {f.kind}
            </span>
            {f.required && <span className="text-destructive">required</span>}
            {(f.kind === 'select' || f.kind === 'multiselect') && (
              <span className="text-muted-foreground">{f.options.length} options</span>
            )}
            <button
              type="button"
              onClick={() => {
                if (confirm(`Delete field "${f.name}"? Existing values will be hidden.`)) remove.mutate(f.id);
              }}
              className="ml-auto text-muted-foreground hover:text-destructive"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card/40 p-3 space-y-2 mt-3">
        <div className="text-xs nockta-eyebrow text-muted-foreground">Add field</div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Field name"
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as FieldKind })}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="select">Select</option>
            <option value="multiselect">Multi-select</option>
            <option value="date">Date</option>
            <option value="url">URL</option>
            <option value="checkbox">Checkbox</option>
            <option value="formula">Formula (computed)</option>
            <option value="rollup">Rollup (aggregate)</option>
          </select>
          <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.required}
              onChange={(e) => setDraft({ ...draft, required: e.target.checked })}
              disabled={draft.kind === 'formula' || draft.kind === 'rollup'}
            />
            Required
          </label>
        </div>
        {(draft.kind === 'select' || draft.kind === 'multiselect') && (
          <textarea
            value={draft.optionsText}
            onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })}
            placeholder="One option per line"
            rows={3}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
        )}
        {draft.kind === 'formula' && (
          <div className="space-y-1.5">
            <textarea
              value={draft.formulaExpression}
              onChange={(e) => setDraft({ ...draft, formulaExpression: e.target.value })}
              placeholder={`Expression — references other fields via {fieldName}\n  e.g. {estimate} * 2\n  e.g. if({status} == "Done", 1, 0)\n  e.g. daysBetween({startDate}, {dueDate})`}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs font-mono"
            />
            <div className="flex items-center justify-between text-[11px]">
              {formulaSyntax === null && (
                <span className="text-muted-foreground">
                  References: <code>{'{fieldName}'}</code> · functions: if, sum, min, max, avg, count, len, lower, upper, daysBetween, now
                </span>
              )}
              {formulaSyntax?.ok && (
                <span className="text-emerald-600 dark:text-emerald-400">Valid syntax</span>
              )}
              {formulaSyntax && !formulaSyntax.ok && (
                <span className="text-destructive">{formulaSyntax.error}</span>
              )}
            </div>
          </div>
        )}
        {draft.kind === 'rollup' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Relation</span>
              <select
                value={draft.rollupRelation}
                onChange={(e) =>
                  setDraft({ ...draft, rollupRelation: e.target.value as 'subtasks' | 'linkedTasks' })
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="subtasks">Subtasks</option>
                <option value="linkedTasks">Linked tasks</option>
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Target field</span>
              <input
                type="text"
                value={draft.rollupField}
                onChange={(e) => setDraft({ ...draft, rollupField: e.target.value })}
                placeholder="estimate or sibling field name"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">Aggregator</span>
              <select
                value={draft.rollupAgg}
                onChange={(e) =>
                  setDraft({ ...draft, rollupAgg: e.target.value as RollupConfig['agg'] })
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                <option value="sum">Sum</option>
                <option value="avg">Average</option>
                <option value="min">Min</option>
                <option value="max">Max</option>
                <option value="count">Count</option>
              </select>
            </label>
          </div>
        )}
        <div className="space-y-1.5 border-t border-border/40 pt-2">
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.visibilityEnabled}
              onChange={(e) => setDraft({ ...draft, visibilityEnabled: e.target.checked })}
            />
            Show this field only when…
          </label>
          {draft.visibilityEnabled && (
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_1fr] gap-2 pl-5">
              <input
                type="text"
                value={draft.visibilityFieldKey}
                onChange={(e) => setDraft({ ...draft, visibilityFieldKey: e.target.value })}
                placeholder="Other field name (e.g. priority)"
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              />
              <select
                value={draft.visibilityOp}
                onChange={(e) =>
                  setDraft({ ...draft, visibilityOp: e.target.value as 'equals' | 'in' | 'isSet' })
                }
                className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              >
                <option value="equals">equals</option>
                <option value="in">in (comma-separated)</option>
                <option value="isSet">is set</option>
              </select>
              {draft.visibilityOp !== 'isSet' && (
                <input
                  type="text"
                  value={draft.visibilityValue}
                  onChange={(e) => setDraft({ ...draft, visibilityValue: e.target.value })}
                  placeholder={draft.visibilityOp === 'in' ? 'High, Critical' : 'High'}
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                />
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={
              !draft.name.trim() ||
              create.isPending ||
              (draft.kind === 'formula' && !draft.formulaExpression.trim()) ||
              (draft.kind === 'rollup' && !draft.rollupField.trim()) ||
              !visibilityValid
            }
            onClick={() => create.mutate()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? 'Adding…' : 'Add field'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  id,
  icon,
  title,
  hint,
  danger,
  children,
}: {
  id?: string;
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  /** Adds a subtle red accent — used for the archive panel. */
  danger?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  // scroll-mt accounts for the page header + ProjectTabs strip so anchor
  // navigation doesn't land with the section title hidden under the chrome.
  return (
    <section id={id} className="scroll-mt-32">
      <div className="mb-4 flex items-start gap-3">
        {icon && (
          <span
            className={cn(
              'mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md border',
              danger
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-border bg-card/60 text-muted-foreground',
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {hint && <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{hint}</p>}
        </div>
      </div>
      <div className="space-y-3 pl-0 sm:pl-10">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <div className="nockta-eyebrow text-muted-foreground mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex items-start justify-between gap-4 rounded-md border border-border bg-background/40 px-3 py-2.5 cursor-pointer hover:bg-background/70 transition-colors">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors shrink-0 mt-1',
          checked ? 'bg-brand' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </span>
    </label>
  );
}

function prettyEventName(t: string): string {
  return t.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

// =============================================================================
// TaskTemplatesAdmin — list, edit, delete task templates for the project. New
// templates are created via "Save as template" on any task; this panel exists
// to manage them after the fact (rename, tweak default fields, prune).
// =============================================================================

interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  titleTemplate: string;
  bodyTemplate: string | null;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  estimate: number | null;
  defaultStatus: string | null;
  labelIds: string[];
}

function TaskTemplatesAdmin({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const templatesQuery = useQuery({
    queryKey: ['task-templates', projectId],
    queryFn: () => api.get<TaskTemplate[]>(`/projects/${projectId}/task-templates`),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<TaskTemplate> }) =>
      api.patch(`/task-templates/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-templates', projectId] });
      toast.success('Template saved');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Save failed')),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/task-templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-templates', projectId] });
      toast.success('Template deleted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });
  const templates = templatesQuery.data ?? [];

  // Outer page renders the Section frame — keep this component content-only.
  return (
    <div>
      {templates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No templates yet. Open any task and click "Save as template" in the drawer header to create one.
        </p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <TaskTemplateRow
              key={t.id}
              template={t}
              onRename={(name) => updateMutation.mutate({ id: t.id, body: { name } })}
              onUpdate={(body) => updateMutation.mutate({ id: t.id, body })}
              onDelete={() => {
                if (window.confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskTemplateRow({
  template,
  onRename,
  onUpdate,
  onDelete,
}: {
  template: TaskTemplate;
  onRename: (name: string) => void;
  onUpdate: (body: Partial<TaskTemplate>) => void;
  onDelete: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-1 text-left text-sm font-medium hover:text-primary transition-colors"
        >
          {template.name}
        </button>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">
          {template.priority}
        </span>
        {template.estimate !== null && (
          <span className="text-[10px] text-muted-foreground">{template.estimate} pts</span>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-muted-foreground hover:text-destructive"
        >
          Delete
        </button>
      </div>
      {open && (
        <div className="border-t border-border p-3 space-y-2 text-xs">
          <label className="block">
            <span className="text-muted-foreground">Name</span>
            <input
              type="text"
              defaultValue={template.name}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== template.name) {
                  onRename(e.target.value.trim());
                }
              }}
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-muted-foreground">Title template</span>
            <input
              type="text"
              defaultValue={template.titleTemplate}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== template.titleTemplate) {
                  onUpdate({ titleTemplate: e.target.value.trim() });
                }
              }}
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-muted-foreground">Body template</span>
            <textarea
              defaultValue={template.bodyTemplate ?? ''}
              rows={3}
              onBlur={(e) => {
                if (e.target.value !== (template.bodyTemplate ?? '')) {
                  onUpdate({ bodyTemplate: e.target.value || null });
                }
              }}
              className="mt-1 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-muted-foreground">Default priority</span>
              <select
                value={template.priority}
                onChange={(e) => onUpdate({ priority: e.target.value as TaskTemplate['priority'] })}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                {(['Low', 'Medium', 'High', 'Critical'] as const).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-muted-foreground">Estimate (pts)</span>
              <input
                type="number"
                defaultValue={template.estimate ?? ''}
                onBlur={(e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  if (v !== template.estimate) onUpdate({ estimate: v });
                }}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ProjectAccessManager — the "who has access" panel inside Project Settings.
//
// Shows the existing grants, plus an "Add" row that lets a Manager pick a
// user OR a team and assign a role. Three rules baked in:
//
//   1. Clients (kind='client') can only get the 'Client' role. The role is
//      auto-selected and locked when a client is picked so a Manager can't
//      accidentally promote a guest to Contributor.
//   2. Teams can never carry the 'Client' role (spec §4 — clients are always
//      per-user). When the subject is a Team, the Client role is hidden.
//   3. Granting an internal user the 'Client' role is allowed but discouraged
//      — the form labels it as a downgrade so the operator sees the implication.
// =============================================================================

type ProjectRole = 'Manager' | 'Contributor' | 'Viewer' | 'Client';
type SubjectKind = 'user' | 'team';

interface AccessUserOption {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  kind: 'internal' | 'client';
}

interface AccessTeamOption {
  id: string;
  name: string;
  slug: string;
}

const ROLE_HINTS: Record<ProjectRole, string> = {
  Manager: 'Full control — settings, access, every task.',
  Contributor: 'Create + edit tasks, comment, log work.',
  Viewer: 'Read-only.',
  Client: 'Client portal access — only sees client-visible content.',
};

function ProjectAccessManager({
  projectId,
  grants,
  loading,
}: {
  projectId: string;
  grants: Access[];
  loading: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);

  const usersQuery = useQuery({
    queryKey: ['users', 'list-all', 'with-guests'],
    queryFn: () =>
      // `kind=all` is the critical bit — the default returns only internal
      // members, which is why guests previously never appeared in the
      // grant picker. Without this the "Add Guest to project" flow simply
      // didn't surface any candidates and the team grouping appeared empty.
      api.get<{ items: AccessUserOption[]; nextCursor: string | null }>(
        '/users?limit=200&kind=all',
      ),
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<AccessTeamOption[]>('/teams'),
  });

  const grantMutation = useMutation({
    mutationFn: (body: {
      subjectKind: SubjectKind;
      userId?: string;
      teamId?: string;
      role: ProjectRole;
    }) => api.post(`/projects/${projectId}/access`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
      toast.success('Access granted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Grant failed')),
  });

  const revokeMutation = useMutation({
    mutationFn: (grantId: string) =>
      api.delete(`/projects/${projectId}/access/${grantId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
      toast.success('Access revoked');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Revoke failed')),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ grant, role }: { grant: Access; role: ProjectRole }) =>
      // The backend doesn't expose a PATCH on grants, so we delete + re-create.
      // Atomic enough for this UI — the row briefly shows the new role optimistically.
      (async () => {
        await api.delete(`/projects/${projectId}/access/${grant.id}`);
        return api.post(`/projects/${projectId}/access`, {
          subjectKind: grant.subjectKind,
          ...(grant.userId ? { userId: grant.userId } : {}),
          ...(grant.teamId ? { teamId: grant.teamId } : {}),
          role,
        });
      })(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Role update failed')),
  });

  const allUsers = usersQuery.data?.items ?? [];
  const teams = teamsQuery.data ?? [];

  // Already-granted subject ids — used to suppress them from the add picker so
  // a Manager can't double-grant the same user/team.
  const grantedUserIds = new Set(grants.filter((g) => g.userId).map((g) => g.userId!));
  const grantedTeamIds = new Set(grants.filter((g) => g.teamId).map((g) => g.teamId!));

  const internalUsers = allUsers
    .filter((u) => u.kind === 'internal' && !grantedUserIds.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const clientUsers = allUsers
    .filter((u) => u.kind === 'client' && !grantedUserIds.has(u.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const availableTeams = teams
    .filter((t) => !grantedTeamIds.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Bucket existing grants by kind for the grouped rendering below. Doing this
  // once at the top means the three groups iterate over disjoint slices and
  // can each render their own empty state.
  const memberGrants: Access[] = [];
  const teamGrants: Access[] = [];
  const guestGrants: Access[] = [];
  for (const g of grants) {
    if (g.subjectKind === 'team') {
      teamGrants.push(g);
    } else if (g.role === 'Client') {
      guestGrants.push(g);
    } else {
      memberGrants.push(g);
    }
  }

  // Resolve a grant to a typed display row. Looking up the user/team object
  // from the local lists gives us names + avatars without an extra query.
  function resolveUser(g: Access): AccessUserOption | null {
    if (!g.userId) return null;
    const u = allUsers.find((u) => u.id === g.userId);
    if (u) return u;
    if (g.user) {
      return {
        id: g.user.id,
        name: g.user.name,
        email: g.user.email,
        avatarUrl: null,
        kind: g.role === 'Client' ? 'client' : 'internal',
      };
    }
    return null;
  }

  return (
    <div className="space-y-6">
      {/* ----- Members ----- */}
      <AccessGroup
        id="access-members"
        title="Members"
        icon={<Users className="h-3.5 w-3.5" />}
        hint="Internal teammates with an explicit role on this project."
        empty={memberGrants.length === 0}
        emptyHint={
          loading
            ? 'Loading…'
            : 'No members yet. Add an internal teammate below, or add a Team to grant everyone on it at once.'
        }
      >
        {memberGrants.map((g) => {
          const u = resolveUser(g);
          return (
            <GrantRow
              key={g.id}
              avatar={
                <AvatarCircle
                  user={
                    u
                      ? {
                          id: u.id,
                          name: u.name,
                          ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
                        }
                      : null
                  }
                  size={32}
                />
              }
              primary={u?.name ?? u?.email ?? g.userId ?? ''}
              secondary={u?.email}
              currentRole={g.role}
              availableRoles={['Manager', 'Contributor', 'Viewer', 'Client']}
              onRoleChange={(role) => updateRoleMutation.mutate({ grant: g, role })}
              onRevoke={() => {
                if (window.confirm('Revoke this access grant?')) revokeMutation.mutate(g.id);
              }}
            />
          );
        })}
        <AddMemberInline
          internalUsers={internalUsers}
          pending={grantMutation.isPending}
          onSubmit={(userId, role) =>
            grantMutation.mutate({ subjectKind: 'user', userId, role })
          }
        />
      </AccessGroup>

      {/* ----- Teams ----- */}
      <AccessGroup
        id="access-teams"
        title="Teams"
        icon={<Layers className="h-3.5 w-3.5" />}
        hint="Granting a team grants every current and future member of that team in one shot."
        empty={teamGrants.length === 0}
        emptyHint={
          teams.length === 0 ? (
            <>
              No teams in this workspace yet. Create one under{' '}
              <a href="/settings/teams" className="text-brand hover:underline">
                Settings → Teams
              </a>
              .
            </>
          ) : (
            'No team grants yet. Add a team below to give everyone on it access at once.'
          )
        }
      >
        {teamGrants.map((g) => (
          <GrantRow
            key={g.id}
            avatar={
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand/15 text-brand">
                <Layers className="h-3.5 w-3.5" />
              </span>
            }
            primary={g.team?.name ?? g.teamId ?? ''}
            secondary={g.team?.slug ? `@${g.team.slug}` : undefined}
            badge={{ label: 'Team', tone: 'brand' }}
            currentRole={g.role}
            availableRoles={['Manager', 'Contributor', 'Viewer']}
            onRoleChange={(role) => updateRoleMutation.mutate({ grant: g, role })}
            onRevoke={() => {
              if (window.confirm('Revoke this team grant?')) revokeMutation.mutate(g.id);
            }}
          />
        ))}
        {availableTeams.length > 0 && (
          <AddTeamInline
            availableTeams={availableTeams}
            pending={grantMutation.isPending}
            onSubmit={(teamId, role) =>
              grantMutation.mutate({ subjectKind: 'team', teamId, role })
            }
          />
        )}
      </AccessGroup>

      {/* ----- Guests ----- */}
      <AccessGroup
        id="access-guests"
        title="Guests"
        icon={<Sparkles className="h-3.5 w-3.5" />}
        hint="External collaborators who sign in via magic link. They only see content marked client-visible, and can comment + report bugs."
        empty={guestGrants.length === 0}
        emptyHint={
          loading
            ? 'Loading…'
            : 'No guests on this project yet. Invite one below — the magic link will land in their inbox.'
        }
        action={
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Invite new guest
          </button>
        }
      >
        {guestGrants.map((g) => {
          const u = resolveUser(g);
          return (
            <GrantRow
              key={g.id}
              avatar={
                <AvatarCircle
                  user={
                    u
                      ? {
                          id: u.id,
                          name: u.name,
                          ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
                        }
                      : null
                  }
                  size={32}
                />
              }
              primary={u?.name ?? u?.email ?? g.userId ?? ''}
              secondary={u?.email}
              badge={{ label: 'Guest', tone: 'guest' }}
              currentRole={g.role}
              // Guests are locked to Client — surfacing other roles here would
              // be a footgun (and the backend would reject the change anyway).
              availableRoles={['Client']}
              onRoleChange={() => undefined}
              onRevoke={() => {
                if (window.confirm('Remove this guest from the project?')) revokeMutation.mutate(g.id);
              }}
            />
          );
        })}
        <AddGuestInline
          clientUsers={clientUsers}
          pending={grantMutation.isPending}
          onSubmit={(userId) =>
            grantMutation.mutate({ subjectKind: 'user', userId, role: 'Client' })
          }
          onInvite={() => setInviteOpen(true)}
        />
      </AccessGroup>

      {/* Inline invite-guest dialog. After a successful invite we refresh the
          users list so the new guest shows up in the dropdown immediately. */}
      {inviteOpen && (
        <InlineInviteGuestDialog
          onClose={() => setInviteOpen(false)}
          onInvited={(user) => {
            // Refresh the user picker, then auto-grant the new guest to this
            // project so the Admin doesn't have to re-pick them.
            void queryClient.invalidateQueries({ queryKey: ['users', 'list-all'] });
            grantMutation.mutate({
              subjectKind: 'user',
              userId: user.id,
              role: 'Client',
            });
            setInviteOpen(false);
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// AccessGroup — subsection container that gives Members/Teams/Guests a
// consistent header, optional inline action button, and an empty state. The
// id is used by anchor chips at the top of the Access section so clicking
// "Guests · 2" scrolls right to the group.
// =============================================================================

function AccessGroup({
  id,
  title,
  icon,
  hint,
  empty,
  emptyHint,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  hint: string;
  /** Caller signals whether the grant list is empty. Inferring this from
   *  children was unreliable because empty arrays / `false` branches still
   *  occupy a child slot in React. */
  empty: boolean;
  emptyHint: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section id={id} className="scroll-mt-24">
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        </div>
        {action}
      </header>
      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{hint}</p>
      <div className="rounded-lg border border-border bg-card/40 overflow-hidden">
        {empty && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {emptyHint}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

// GrantRow — one access row with avatar, role select, revoke button.
function GrantRow({
  avatar,
  primary,
  secondary,
  badge,
  currentRole,
  availableRoles,
  onRoleChange,
  onRevoke,
}: {
  avatar: React.ReactNode;
  primary: string;
  secondary?: string | undefined;
  badge?: { label: string; tone: 'brand' | 'guest' } | undefined;
  currentRole: ProjectRole;
  availableRoles: ProjectRole[];
  onRoleChange: (role: ProjectRole) => void;
  onRevoke: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/20 transition-colors">
      <div className="shrink-0">{avatar}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium truncate">{primary}</span>
          {badge && (
            <span
              className={cn(
                'text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold shrink-0',
                badge.tone === 'brand'
                  ? 'bg-brand/15 text-brand'
                  : 'bg-priority-medium/15 text-priority-medium',
              )}
            >
              {badge.label}
            </span>
          )}
        </div>
        {secondary && (
          <div className="text-[11px] text-muted-foreground truncate">{secondary}</div>
        )}
      </div>
      <select
        value={currentRole}
        onChange={(e) => onRoleChange(e.target.value as ProjectRole)}
        disabled={availableRoles.length === 1}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-60 disabled:cursor-not-allowed"
        title={ROLE_HINTS[currentRole]}
      >
        {availableRoles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onRevoke}
        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
        aria-label="Revoke access"
        title="Revoke"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// AddMemberInline — pick an internal user + role, hit Add.
function AddMemberInline({
  internalUsers,
  pending,
  onSubmit,
}: {
  internalUsers: AccessUserOption[];
  pending: boolean;
  onSubmit: (userId: string, role: ProjectRole) => void;
}): JSX.Element {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectRole>('Contributor');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!userId) return;
        onSubmit(userId, role);
        setUserId('');
        setRole('Contributor');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">
          {internalUsers.length === 0 ? 'Everyone is already a member' : 'Pick a member…'}
        </option>
        {internalUsers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name || u.email}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as ProjectRole)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="Manager">Manager</option>
        <option value="Contributor">Contributor</option>
        <option value="Viewer">Viewer</option>
      </select>
      <button
        type="submit"
        disabled={!userId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add member
      </button>
    </form>
  );
}

// AddTeamInline — pick a team + role.
function AddTeamInline({
  availableTeams,
  pending,
  onSubmit,
}: {
  availableTeams: AccessTeamOption[];
  pending: boolean;
  onSubmit: (teamId: string, role: ProjectRole) => void;
}): JSX.Element {
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState<ProjectRole>('Contributor');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!teamId) return;
        onSubmit(teamId, role);
        setTeamId('');
        setRole('Contributor');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">Pick a team…</option>
        {availableTeams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as ProjectRole)}
        className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="Manager">Manager</option>
        <option value="Contributor">Contributor</option>
        <option value="Viewer">Viewer</option>
      </select>
      <button
        type="submit"
        disabled={!teamId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add team
      </button>
    </form>
  );
}

// AddGuestInline — pick an existing client user (always at role=Client) OR
// jump to the inline invite dialog if the right person isn't in the list yet.
function AddGuestInline({
  clientUsers,
  pending,
  onSubmit,
  onInvite,
}: {
  clientUsers: AccessUserOption[];
  pending: boolean;
  onSubmit: (userId: string) => void;
  onInvite: () => void;
}): JSX.Element {
  const [userId, setUserId] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!userId) return;
        onSubmit(userId);
        setUserId('');
      }}
      className="flex flex-wrap items-center gap-2 px-3 py-2 bg-background/40 border-t border-border"
    >
      <select
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        className="flex-1 min-w-[180px] rounded-md border border-input bg-background px-2 py-1.5 text-xs"
      >
        <option value="">
          {clientUsers.length === 0
            ? 'No guests in the workspace yet — invite one →'
            : 'Pick an existing guest…'}
        </option>
        {clientUsers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name || u.email}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!userId || pending}
        className="rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        Add guest
      </button>
      <span className="text-muted-foreground/70 text-xs">or</span>
      <button
        type="button"
        onClick={onInvite}
        className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
      >
        Invite new guest by email
        <ArrowRight className="h-3 w-3" />
      </button>
    </form>
  );
}

// InlineInviteGuestDialog — slim local version of the workspace-level
// InviteGuestDialog. Lives inline here so a Manager can spin up a brand-new
// guest and grant them access to this project without leaving Settings.
function InlineInviteGuestDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: (user: { id: string; email: string; name: string }) => void;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');

  const invite = useMutation({
    mutationFn: () =>
      api.post<{
        id: string;
        email: string;
        name: string;
        kind: 'client';
        alreadyExisted: boolean;
      }>('/users/invite-guest', {
        email: email.trim().toLowerCase(),
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: (resp) => {
      toast.success(
        resp.alreadyExisted
          ? `Re-sent magic link to ${resp.email}`
          : `Invited ${resp.email}`,
      );
      onInvited({ id: resp.id, email: resp.email, name: resp.name });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Invite failed')),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) invite.mutate();
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl max-h-[85vh] overflow-y-auto"
      >
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-brand" />
            Invite a guest to this project
          </h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            We'll email them a one-time sign-in link. After the invite sends
            we'll automatically grant them Client access to this project.
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              Email <span className="text-destructive">*</span>
            </label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="someone@partner-co.com"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Must NOT be on the company domain — internal accounts use Google OAuth instead.
            </p>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              Display name <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to the email's local part"
              maxLength={120}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!email.trim() || invite.isPending}
            className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {invite.isPending ? 'Sending…' : 'Send invite + grant access'}
          </button>
        </div>
      </form>
    </div>
  );
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.problem.title || err.problem.detail || err.message || fallback;
  return fallback;
}
