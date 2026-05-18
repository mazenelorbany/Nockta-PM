import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ProjectTabs } from '../components/ProjectTabs';
import { api } from '../lib/api';
import { SettingsRail } from './project-settings/SettingsRail';
import { OverviewSection } from './project-settings/OverviewSection';
import { AccessSection } from './project-settings/AccessSection';
import { WorkflowSection } from './project-settings/WorkflowSection';
import { IntegrationsSection } from './project-settings/IntegrationsSection';
import { CustomFieldsSection } from './project-settings/CustomFieldsSection';
import { TemplatesSection } from './project-settings/TemplatesSection';
import { DangerSection } from './project-settings/DangerSection';
import { apiErrorMessage } from './project-settings/utils';
import type { Access, Project } from './project-settings/types';

// =============================================================================
// /projects/:projectId/settings — edit project metadata, sprints/github toggles,
// chat broadcast config, access grants, archive.
// =============================================================================

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

  function patch<K extends keyof Project>(key: K, value: Project[K]): void {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  }

  function commit<K extends keyof Project>(key: K): void {
    if (!draft || !project) return;
    if (draft[key] === project[key]) return;
    updateMutation.mutate({ [key]: draft[key] } as Partial<Project>);
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
            <OverviewSection
              draft={draft}
              setDraft={setDraft}
              patch={patch}
              commit={commit}
              updateMutation={updateMutation}
            />
            <AccessSection
              draft={draft}
              setDraft={setDraft}
              updateMutation={updateMutation}
              projectId={projectId}
              grants={accessQuery.data ?? []}
              loading={accessQuery.isLoading}
              grantSummary={grantSummary}
            />
            <WorkflowSection
              draft={draft}
              setDraft={setDraft}
              patch={patch}
              commit={commit}
              updateMutation={updateMutation}
            />
            <IntegrationsSection
              draft={draft}
              setDraft={setDraft}
              patch={patch}
              commit={commit}
              updateMutation={updateMutation}
            />
            <CustomFieldsSection projectId={projectId} />
            <TemplatesSection projectId={projectId} />
            <DangerSection project={project} projectId={projectId} />
          </div>
        </div>
      </div>
    </div>
  );
}
