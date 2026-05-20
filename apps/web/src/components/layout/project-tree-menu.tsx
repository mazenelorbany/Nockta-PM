import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Archive, MoreHorizontal, Settings, Trash2, UserPlus } from 'lucide-react';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

import type { ProjectSummary } from './types';

// =============================================================================
// ProjectTreeMenu — the "…" affordance that hangs off each sidebar project
// row. Surfaces the four actions an operator commonly reaches for from this
// context without leaving the sidebar:
//
//   - Settings        → navigates to /projects/<KEY>/settings
//   - Manage access   → same destination, deep-linked to the Access section
//   - Archive project → PATCH /projects/:id { archivedAt: now }; hides it
//                        from the list, recoverable from Workspace Settings →
//                        Archived projects.
//   - Delete project  → currently delegates to the same archive endpoint
//                        (the API has no hard-delete surface yet) but gates
//                        behind a type-the-key confirmation so it feels — and
//                        behaves — as the more destructive option, matching
//                        ProjectsAdminTab's pattern.
//
// The menu portals to document.body so the sidebar's overflow-hidden /
// sticky layout doesn't clip it, and lives at z-[50] (sidebar is z-30/40
// in practice; the task drawer at z-[70] never coexists with the sidebar
// menu).
// =============================================================================

interface MenuCoords {
  top: number;
  left: number;
}

export function ProjectTreeMenu({ project }: { project: ProjectSummary }): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const slug = project.key || project.id;

  const archive = useMutation({
    mutationFn: () =>
      api.patch(`/projects/${project.id}`, { archivedAt: new Date().toISOString() }),
    onSuccess: () => {
      toast.success(`Archived ${project.key}`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    // The API throws 403 if the actor isn't Manager+ on the project; surface
    // that exactly so the user sees "Manager role required" rather than a
    // generic "Could not archive".
    onError: (err) => {
      const msg = (err as { message?: string })?.message ?? 'Could not archive';
      toast.error(msg);
    },
  });

  // Hard-delete from the UI's perspective. Currently maps to the same
  // soft-delete endpoint (the API exposes no hard delete), but gating behind
  // a typed-key confirm matches ProjectsAdminTab and avoids the surprise of
  // "click Delete, project just hides" — the user is told exactly what the
  // action does in the confirm copy.
  const remove = useMutation({
    mutationFn: () => api.delete(`/projects/${project.id}`),
    onSuccess: () => {
      toast.success(`Deleted ${project.key}`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
    onError: (err) => {
      const msg = (err as { message?: string })?.message ?? 'Could not delete';
      toast.error(msg);
    },
  });

  // Position the menu directly below the trigger. Recompute on open + window
  // resize + outer scroll so the menu doesn't drift when the sidebar scrolls.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    function reposition(): void {
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = popoverRef.current?.offsetWidth ?? 200;
      const height = popoverRef.current?.offsetHeight ?? 180;
      // Prefer to drop down + right, but clamp to viewport.
      let top = rect.bottom + 6;
      let left = rect.right - width;
      if (top + height > vh - 8) top = Math.max(8, rect.top - height - 6);
      left = Math.max(8, Math.min(left, vw - width - 8));
      setCoords({ top, left });
    }
    reposition();
    const raf = window.requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  // ESC closes — mirror of the picker popover's pattern.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  function close(): void {
    setOpen(false);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${project.name}`}
        // Stop click bubbling — the parent row is a <Link> that would
        // otherwise navigate into the project before the menu opens.
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={cn(
          'shrink-0 h-5 w-5 inline-flex items-center justify-center rounded transition-colors',
          // Hidden by default; revealed on hover of the parent row OR when
          // the menu is open. `.group` is applied by the parent ProjectTreeItem.
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          open && 'opacity-100 bg-accent text-foreground',
          'text-muted-foreground hover:text-foreground hover:bg-accent',
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {open && coords &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close menu"
              onClick={close}
              className="fixed inset-0 z-[60] cursor-default bg-transparent"
            />
            <div
              ref={popoverRef}
              className="animate-popover-in fixed z-[61] min-w-[200px] rounded-md border border-border bg-popover shadow-xl shadow-black/40 overflow-hidden py-1"
              style={{ top: coords.top, left: coords.left, transformOrigin: 'top right' }}
              role="menu"
              aria-label={`${project.name} actions`}
              onClick={(e) => e.stopPropagation()}
            >
              <MenuItem
                icon={<Settings className="h-3.5 w-3.5" />}
                label="Settings"
                onClick={() => {
                  navigate(`/projects/${slug}/settings`);
                  close();
                }}
              />
              <MenuItem
                icon={<UserPlus className="h-3.5 w-3.5" />}
                label="Manage access"
                onClick={() => {
                  // The Access section anchors itself with id="access" — using
                  // the hash means the settings page scrolls there on mount.
                  navigate(`/projects/${slug}/settings#access`);
                  close();
                }}
              />
              <MenuSeparator />
              <MenuItem
                icon={<Archive className="h-3.5 w-3.5" />}
                label={archive.isPending ? 'Archiving…' : 'Archive project'}
                disabled={archive.isPending || Boolean(project.archivedAt)}
                onClick={() => {
                  close();
                  if (
                    window.confirm(
                      `Archive ${project.key}? It hides from the sidebar; an admin can restore it from Workspace Settings → Archived projects.`,
                    )
                  ) {
                    archive.mutate();
                  }
                }}
              />
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label={remove.isPending ? 'Deleting…' : 'Delete project'}
                tone="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  close();
                  // Type-the-key confirmation mirrors ProjectsAdminTab so an
                  // accidental click can't take a project down. Comparing
                  // against project.key (already required to be uppercase
                  // 2-10 chars) keeps the prompt short.
                  const typed = window.prompt(
                    `This will delete ${project.key} ("${project.name}"). Type the project key to confirm:`,
                  );
                  if (typed && typed.trim().toUpperCase() === project.key.toUpperCase()) {
                    remove.mutate();
                  } else if (typed !== null) {
                    toast.error('Key did not match. Nothing was deleted.');
                  }
                }}
              />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'destructive';
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
        'hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed',
        tone === 'destructive'
          ? 'text-destructive hover:text-destructive'
          : 'text-foreground',
      )}
    >
      <span className={cn('shrink-0', tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

function MenuSeparator(): JSX.Element {
  return <div className="my-1 h-px bg-border" aria-hidden="true" />;
}
