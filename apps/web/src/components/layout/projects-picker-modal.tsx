import { cn } from '@nockta/ui';
import { FolderKanban, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';

import { projectAccent } from './project-tree-item';
import { pushRecentProject } from './recent-projects';
import type { ProjectSummary } from './types';

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

export function ProjectsPickerModal({
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
        aria-label={'Close'}
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
            placeholder={'Search…'}
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
                ? `No projects match "${query}"`
                : 'No projects yet.'}
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
                <PickerGroup label={'Recent'}>
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
                <PickerGroup label={'All projects'}>
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
            <span className="flex-1">{'View all projects'}</span>
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
