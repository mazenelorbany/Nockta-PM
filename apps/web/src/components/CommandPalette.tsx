import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  BarChart3,
  Bookmark,
  Calendar,
  CornerDownLeft,
  FileText,
  LayoutDashboard,
  ListTodo,
  Search,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';
import { api } from '../lib/api';
import { StatusPill, TypeBadge, type TaskType } from './task-bits';

// =============================================================================
// Parsed-filter chip support (Search 7→9). We mirror the server-side grammar
// in `search.service.parseQuery` here so the chips can render BEFORE the
// query round-trips. The server is authoritative — if our parser disagrees
// the API still does the right thing — but a same-tick UI is the whole point
// of these chips. Keep the regex in sync with the backend.
// =============================================================================

const FILTER_TOKEN_REGEX = /(\w+):(?:"([^"]+)"|(\S+))/g;
const KNOWN_KEYS = new Set(['status', 'assignee', 'label', 'priority', 'created']);

interface ChipModel {
  key: string;
  value: string;
  raw: string; // the full matched token, used to strip from the input on dismiss
}

function parseChips(input: string): { chips: ChipModel[]; remainingText: string } {
  const chips: ChipModel[] = [];
  const matches: { start: number; end: number; chip: ChipModel | null }[] = [];
  for (const m of input.matchAll(FILTER_TOKEN_REGEX)) {
    const key = m[1]!.toLowerCase();
    const value = m[2] !== undefined ? m[2] : (m[3] ?? '');
    const start = m.index ?? 0;
    const end = start + m[0]!.length;
    if (KNOWN_KEYS.has(key)) {
      const chip: ChipModel = { key, value, raw: m[0]! };
      chips.push(chip);
      matches.push({ start, end, chip });
    } else {
      // Unknown keys aren't chips — they're free-text-with-a-colon.
    }
  }
  // Strip consumed ranges from the original input to compute remainingText.
  let text = input;
  matches
    .slice()
    .sort((a, b) => b.start - a.start)
    .forEach((m) => {
      text = text.slice(0, m.start) + text.slice(m.end);
    });
  return { chips, remainingText: text.replace(/\s+/g, ' ').trim() };
}

// -----------------------------------------------------------------------------
// Facets — return shape from /search/tasks/facets. Kept in lock-step with
// SearchService.facets server-side.
// -----------------------------------------------------------------------------

interface FacetsResponse {
  byStatus: { status: string; count: number }[];
  byPriority: { priority: string; count: number }[];
  byType: { type: string; count: number }[];
  byProject: { projectId: string; name: string; count: number }[];
  byAssignee: { userId: string; name: string; count: number }[];
  bySprint: { sprintId: string; name: string; count: number }[];
  byLabel: { labelId: string; name: string; count: number }[];
}

/**
 * Multi-select facet state — one Set of selected values per dimension. We
 * keep them as plain Sets in component state (not URL state) because the
 * Cmd+K panel is a transient surface; tearing it down resets the picks.
 */
interface FacetSelection {
  statuses: Set<string>;
  priorities: Set<string>;
  types: Set<string>;
  projectIds: Set<string>;
  assigneeUserIds: Set<string>;
  labelIds: Set<string>;
  sprintIds: Set<string>;
}

/**
 * Stable string representation of the facet picks for use as a React Query
 * cache key. Sets aren't structurally comparable, so we sort each dim's
 * values and concatenate.
 */
function serializeFacets(s: FacetSelection): string {
  const join = (set: Set<string>) => Array.from(set).sort().join(',');
  return [
    `s:${join(s.statuses)}`,
    `p:${join(s.priorities)}`,
    `t:${join(s.types)}`,
    `pj:${join(s.projectIds)}`,
    `as:${join(s.assigneeUserIds)}`,
    `lb:${join(s.labelIds)}`,
    `sp:${join(s.sprintIds)}`,
  ].join('|');
}

function emptyFacetSelection(): FacetSelection {
  return {
    statuses: new Set(),
    priorities: new Set(),
    types: new Set(),
    projectIds: new Set(),
    assigneeUserIds: new Set(),
    labelIds: new Set(),
    sprintIds: new Set(),
  };
}

function facetSelectionIsEmpty(s: FacetSelection): boolean {
  return (
    s.statuses.size === 0 &&
    s.priorities.size === 0 &&
    s.types.size === 0 &&
    s.projectIds.size === 0 &&
    s.assigneeUserIds.size === 0 &&
    s.labelIds.size === 0 &&
    s.sprintIds.size === 0
  );
}

function appendFacetParams(params: URLSearchParams, selection: FacetSelection): void {
  const join = (s: Set<string>) => Array.from(s).join(',');
  if (selection.statuses.size > 0) params.set('statuses', join(selection.statuses));
  if (selection.priorities.size > 0) params.set('priorities', join(selection.priorities));
  if (selection.types.size > 0) params.set('types', join(selection.types));
  if (selection.projectIds.size > 0) params.set('projectIds', join(selection.projectIds));
  if (selection.assigneeUserIds.size > 0)
    params.set('assigneeUserIds', join(selection.assigneeUserIds));
  if (selection.labelIds.size > 0) params.set('labelIds', join(selection.labelIds));
  if (selection.sprintIds.size > 0) params.set('sprintIds', join(selection.sprintIds));
}

interface SearchTask {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  project?: { id: string; key: string; name: string };
  assignee?: { id: string; name: string } | null;
}
interface SearchResp { items: SearchTask[]; nextCursor: string | null }
interface SearchDoc {
  id: string;
  title: string;
  projectId: string;
  projectKey: string;
  projectName: string;
}

type Hit =
  | { kind: 'task'; data: SearchTask }
  | { kind: 'doc'; data: SearchDoc }
  | { kind: 'route'; data: { id: string; label: string; description: string; to: string; icon: React.ComponentType<{ className?: string }> } }
  | { kind: 'recent'; data: { id: string; label: string; key?: string; to: string; type: 'task' | 'doc' } };

const RECENTS_KEY = 'nockta:cmdk:recents:v1';
const RECENTS_MAX = 6;

interface RecentEntry {
  id: string;
  label: string;
  key?: string;
  to: string;
  type: 'task' | 'doc';
  visitedAt: number;
}

const QUICK_ROUTES = [
  { id: 'r-dashboard', label: 'Dashboard', description: 'Personal command center', to: '/', icon: LayoutDashboard },
  { id: 'r-mytasks',   label: 'My tasks', description: 'Everything assigned to you', to: '/my-tasks', icon: ListTodo },
  { id: 'r-projects',  label: 'All projects', description: 'Browse the workspace', to: '/projects', icon: LayoutDashboard },
  { id: 'r-calendar',  label: 'Calendar', description: 'Deadlines + sprint dates', to: '/calendar', icon: Calendar },
  { id: 'r-analytics', label: 'Analytics', description: 'Throughput, cycle time, burndown', to: '/analytics', icon: BarChart3 },
  { id: 'r-settings',  label: 'Settings', description: 'Members, projects, integrations', to: '/settings', icon: Settings },
] as const;

function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}
function saveRecent(entry: Omit<RecentEntry, 'visitedAt'>): void {
  try {
    const cur = loadRecents().filter((r) => r.id !== entry.id);
    const next: RecentEntry[] = [{ ...entry, visitedAt: Date.now() }, ...cur].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {/* ignore */}
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CommandPalette(): JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [facetSelection, setFacetSelection] = useState<FacetSelection>(emptyFacetSelection);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const debouncedQuery = useDebounced(query.trim(), 110);

  // Parsed-filter chips reflect what the user typed as `key:value`. Same
  // grammar as the backend parseQuery so the UI agrees with the server. The
  // remaining text is shown as the "free text" portion of the search.
  const parsedChips = useMemo(() => parseChips(query), [query]);

  // Hotkey + escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setRecents(loadRecents());
      setFacetSelection(emptyFacetSelection());
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Build the URL query string once — both /search/tasks and /search/tasks/facets
  // consume the same set of params, so factoring it out keeps them in sync.
  const buildSearchUrl = (path: string, extraParams?: Record<string, string>): string => {
    const params = new URLSearchParams();
    if (debouncedQuery.length > 0) params.set('q', debouncedQuery);
    appendFacetParams(params, facetSelection);
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) params.set(k, v);
    }
    return `${path}?${params.toString()}`;
  };

  const searchEnabled =
    open && (debouncedQuery.length >= 2 || !facetSelectionIsEmpty(facetSelection));

  const searchQuery = useQuery({
    queryKey: ['palette-search', debouncedQuery, serializeFacets(facetSelection)],
    queryFn: () => api.get<SearchResp>(buildSearchUrl('/search/tasks', { limit: '12' })),
    enabled: searchEnabled,
  });
  const docsQuery = useQuery({
    queryKey: ['palette-docs', debouncedQuery],
    queryFn: () =>
      api.get<SearchDoc[]>(`/search/docs?q=${encodeURIComponent(debouncedQuery)}&limit=6`),
    enabled: open && debouncedQuery.length >= 2,
  });
  const facetsQuery = useQuery({
    queryKey: ['palette-facets', debouncedQuery, serializeFacets(facetSelection)],
    queryFn: () => api.get<FacetsResponse>(buildSearchUrl('/search/tasks/facets')),
    enabled: searchEnabled,
  });

  /**
   * Save the current query + facet picks as a SavedSearch, then promote it
   * to a SavedView in one click. Two round-trips because the existing API
   * shape is "save first, then promote" — kept that way so a user with only
   * a typed query (no chips/facets) can still hit Save.
   */
  const saveAsViewMutation = useMutation({
    mutationFn: async () => {
      const created = await api.post<{ id: string }>('/search/saved', {
        name: debouncedQuery ? `Search: ${debouncedQuery.slice(0, 60)}` : 'Untitled search',
        q: debouncedQuery,
        ...(facetSelection.statuses.size === 1
          ? { status: Array.from(facetSelection.statuses)[0] }
          : {}),
      });
      const view = await api.post<{ id: string }>(
        `/search/saved/${created.id}/promote-to-view`,
        {},
      );
      return view;
    },
    onSuccess: () => toast.success('Saved as view'),
    onError: () => toast.error('Could not save'),
  });

  function toggleFacet(dim: keyof FacetSelection, value: string): void {
    setFacetSelection((prev) => {
      const next = { ...prev, [dim]: new Set(prev[dim]) };
      if (next[dim].has(value)) next[dim].delete(value);
      else next[dim].add(value);
      return next;
    });
  }

  function dismissChip(chip: ChipModel): void {
    // Strip the matching raw token from the query string.
    setQuery((q) => q.replace(chip.raw, '').replace(/\s+/g, ' ').trim());
  }

  // ---- Hit assembly --------------------------------------------------------
  const taskHits: Hit[] = useMemo(
    () => (searchQuery.data?.items ?? []).map((t) => ({ kind: 'task' as const, data: t })),
    [searchQuery.data],
  );
  const docHits: Hit[] = useMemo(
    () => (docsQuery.data ?? []).map((d) => ({ kind: 'doc' as const, data: d })),
    [docsQuery.data],
  );
  const routeHits: Hit[] = useMemo(() => {
    const q = debouncedQuery.toLowerCase();
    const toHit = (r: typeof QUICK_ROUTES[number]): Hit => ({
      kind: 'route',
      data: {
        id: r.id,
        label: r.label,
        description: r.description,
        to: r.to,
        icon: r.icon as React.ComponentType<{ className?: string }>,
      },
    });
    if (q.length === 0) return QUICK_ROUTES.map(toHit);
    return QUICK_ROUTES
      .filter((r) => r.label.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
      .map(toHit);
  }, [debouncedQuery]);
  const recentHits: Hit[] = useMemo(
    () =>
      debouncedQuery.length === 0
        ? recents.map((r) => ({ kind: 'recent' as const, data: r }))
        : [],
    [recents, debouncedQuery],
  );

  // Result list — flat, in display order
  const items: Hit[] = debouncedQuery.length === 0
    ? [...recentHits, ...routeHits]
    : [...routeHits, ...taskHits, ...docHits];

  function openHit(hit: Hit): void {
    if (hit.kind === 'task') {
      if (!hit.data.project) return;
      saveRecent({
        id: `task-${hit.data.id}`,
        label: hit.data.title,
        key: hit.data.key,
        to: `/projects/${hit.data.project.id}/board?task=${hit.data.id}`,
        type: 'task',
      });
      navigate(`/projects/${hit.data.project.id}/board?task=${hit.data.id}`);
    } else if (hit.kind === 'doc') {
      saveRecent({
        id: `doc-${hit.data.id}`,
        label: hit.data.title,
        to: `/projects/${hit.data.projectId}/docs/${hit.data.id}`,
        type: 'doc',
      });
      navigate(`/projects/${hit.data.projectId}/docs/${hit.data.id}`);
    } else if (hit.kind === 'recent') {
      navigate(hit.data.to);
    } else {
      navigate(hit.data.to);
    }
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && items[activeIdx]) {
      e.preventDefault();
      openHit(items[activeIdx]);
    }
  }

  // Reset active index whenever the result count changes
  useEffect(() => { setActiveIdx(0); }, [items.length, debouncedQuery]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="cmdk-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="glass-scrim fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <motion.div
            key="cmdk-panel"
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="glass-strong w-full max-w-4xl rounded-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={t('command_palette.placeholder', 'Type a command, jump to a task, or search…')}
          >
            {/* Search */}
            <div className="flex items-center gap-3 px-4 h-14 border-b border-border/60">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t(
                  'command_palette.placeholder',
                  'Type a command, jump to a task, or search…',
                )}
                aria-label={t('common.search', 'Search')}
                className="flex-1 bg-transparent text-base placeholder:text-muted-foreground/60 focus:outline-none"
              />
              {(searchQuery.isFetching || docsQuery.isFetching || facetsQuery.isFetching) &&
                searchEnabled && (
                  <span className="h-2 w-2 rounded-full bg-brand animate-pulse" />
                )}
              <kbd className="kbd shrink-0">ESC</kbd>
            </div>

            {/* Parsed-filter chips — render only when there's something to show. */}
            {(parsedChips.chips.length > 0 || !facetSelectionIsEmpty(facetSelection)) && (
              <div className="px-4 py-2 border-b border-border/40 flex flex-wrap gap-1.5 items-center">
                {parsedChips.chips.map((chip, i) => (
                  <button
                    key={`${chip.key}-${i}-${chip.value}`}
                    type="button"
                    onClick={() => dismissChip(chip)}
                    className="inline-flex items-center gap-1 rounded-full bg-brand/10 text-foreground border border-brand/30 px-2 py-0.5 text-[11px] hover:bg-brand/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    aria-label={`Remove filter ${chip.key}: ${chip.value}`}
                    title="Remove this filter"
                  >
                    <span className="font-medium">{chip.key}:</span>
                    <span>{chip.value}</span>
                    <X className="h-2.5 w-2.5 opacity-60" aria-hidden="true" />
                  </button>
                ))}
                {/* Facet-selection chips — mirror in the chip row so the user
                    sees one consolidated source of truth. */}
                {Array.from(facetSelection.statuses).map((v) => (
                  <FacetChip
                    key={`fc-status-${v}`}
                    label={`status: ${v}`}
                    onRemove={() => toggleFacet('statuses', v)}
                  />
                ))}
                {Array.from(facetSelection.priorities).map((v) => (
                  <FacetChip
                    key={`fc-priority-${v}`}
                    label={`priority: ${v}`}
                    onRemove={() => toggleFacet('priorities', v)}
                  />
                ))}
                {Array.from(facetSelection.types).map((v) => (
                  <FacetChip
                    key={`fc-type-${v}`}
                    label={`type: ${v}`}
                    onRemove={() => toggleFacet('types', v)}
                  />
                ))}
                {/* Save-as-view button — promotes to a SavedView via the API.
                    Only visible once the user actually has filters worth saving. */}
                <div className="ml-auto">
                  <button
                    type="button"
                    onClick={() => saveAsViewMutation.mutate()}
                    disabled={saveAsViewMutation.isPending}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <Bookmark className="h-3 w-3" />
                    {saveAsViewMutation.isPending ? 'Saving…' : 'Save as view'}
                  </button>
                </div>
              </div>
            )}

            {/* Two-pane body: results on the left, facet sidebar on the right.
                The sidebar only shows when there's something searchable. */}
            <div className="flex min-h-0">
              <div className="flex-1 max-h-[56vh] overflow-y-auto py-1">
                <ResultsBody
                  items={items}
                  activeIdx={activeIdx}
                  setActiveIdx={setActiveIdx}
                  openHit={openHit}
                  query={debouncedQuery}
                  taskCount={taskHits.length}
                  docCount={docHits.length}
                  routeCount={routeHits.length}
                  recentCount={recentHits.length}
                  loading={searchQuery.isLoading || docsQuery.isLoading}
                />
              </div>
              {searchEnabled && (
                <aside className="w-60 max-h-[56vh] overflow-y-auto border-l border-border/40 p-3 text-xs">
                  <FacetSidebar
                    facets={facetsQuery.data ?? null}
                    selection={facetSelection}
                    onToggle={toggleFacet}
                    loading={facetsQuery.isLoading}
                  />
                </aside>
              )}
            </div>

            {/* Footer hints */}
            <div className="px-4 h-10 border-t border-border/60 flex items-center justify-between text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex items-center gap-1">
                  <kbd className="kbd">↑</kbd>
                  <kbd className="kbd">↓</kbd>
                  navigate
                </span>
                <span className="inline-flex items-center gap-1">
                  <kbd className="kbd inline-flex items-center"><CornerDownLeft className="h-2.5 w-2.5" /></kbd>
                  open
                </span>
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="kbd">⌘</kbd>
                <kbd className="kbd">K</kbd>
                toggle
              </span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* -----------------------------------------------------------------------------
 * Results body — segmented sections with eyebrow group labels. Each item is
 * indexed against the flat `items` array for keyboard nav.
 * -------------------------------------------------------------------------- */

function ResultsBody({
  items,
  activeIdx,
  setActiveIdx,
  openHit,
  query,
  taskCount,
  docCount,
  routeCount,
  recentCount,
  loading,
}: {
  items: Hit[];
  activeIdx: number;
  setActiveIdx: (i: number) => void;
  openHit: (h: Hit) => void;
  query: string;
  taskCount: number;
  docCount: number;
  routeCount: number;
  recentCount: number;
  loading: boolean;
}): JSX.Element {
  // Empty / loading / no-results states
  if (items.length === 0) {
    if (query.length === 0) {
      return (
        <div className="px-8 py-12 text-center">
          <Sparkles className="h-5 w-5 text-brand/60 mx-auto mb-2" />
          <div className="text-sm font-medium text-foreground">Jump anywhere.</div>
          <p className="text-xs text-muted-foreground mt-1.5 max-w-sm mx-auto leading-relaxed">
            Search any task or doc by keyword, or type the first letter of a destination
            to jump straight there.
          </p>
        </div>
      );
    }
    if (loading && query.length >= 2) {
      return <div className="px-4 py-6 text-xs text-muted-foreground">Searching…</div>;
    }
    return (
      <div className="px-8 py-10 text-center">
        <div className="text-sm text-foreground">No matches for "{query}"</div>
        <p className="text-xs text-muted-foreground mt-1.5">
          Try a key (e.g. NOCKTA-12), an assignee name, or a status.
        </p>
      </div>
    );
  }

  let cursor = 0;
  const sections: JSX.Element[] = [];

  // Recent (only when query is empty)
  if (recentCount > 0) {
    const slice = items.slice(cursor, cursor + recentCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-recent" label="Recent">
        {slice.map((hit, i) => {
          const idx = start + i;
          const r = (hit as Extract<Hit, { kind: 'recent' }>).data;
          return (
            <ResultRow
              key={`recent-${r.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={
                r.type === 'task'
                  ? <TypeBadge type="Task" />
                  : <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              }
              kicker={r.key}
              label={r.label}
            />
          );
        })}
      </ResultSection>,
    );
    cursor += recentCount;
  }

  // Routes (Jump To)
  if (routeCount > 0) {
    const slice = items.slice(cursor, cursor + routeCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-routes" label={query ? 'Jump to' : 'Anywhere'}>
        {slice.map((hit, i) => {
          const idx = start + i;
          const r = (hit as Extract<Hit, { kind: 'route' }>).data;
          const Icon = r.icon;
          return (
            <ResultRow
              key={`route-${r.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={<Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              label={r.label}
              hint={r.description}
              trailing={<ArrowRight className="h-3 w-3 text-muted-foreground/60" />}
            />
          );
        })}
      </ResultSection>,
    );
    cursor += routeCount;
  }

  // Tasks
  if (taskCount > 0) {
    const slice = items.slice(cursor, cursor + taskCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-tasks" label="Tasks">
        {slice.map((hit, i) => {
          const idx = start + i;
          const t = (hit as Extract<Hit, { kind: 'task' }>).data;
          return (
            <ResultRow
              key={`task-${t.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={<TypeBadge type={t.type ?? 'Task'} />}
              kicker={t.key}
              label={t.title}
              trailing={
                <span className="inline-flex items-center gap-2 shrink-0">
                  {t.project && (
                    <span className="text-[10px] nockta-eyebrow text-muted-foreground">
                      {t.project.key}
                    </span>
                  )}
                  <StatusPill status={t.status} />
                </span>
              }
            />
          );
        })}
      </ResultSection>,
    );
    cursor += taskCount;
  }

  // Docs
  if (docCount > 0) {
    const slice = items.slice(cursor, cursor + docCount);
    const start = cursor;
    sections.push(
      <ResultSection key="sec-docs" label="Docs">
        {slice.map((hit, i) => {
          const idx = start + i;
          const d = (hit as Extract<Hit, { kind: 'doc' }>).data;
          return (
            <ResultRow
              key={`doc-${d.id}`}
              active={idx === activeIdx}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => openHit(hit)}
              icon={<FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              label={d.title}
              trailing={
                <span className="text-[10px] nockta-eyebrow text-muted-foreground shrink-0">
                  {d.projectKey}
                </span>
              }
            />
          );
        })}
      </ResultSection>,
    );
  }

  return <>{sections}</>;
}

function ResultSection({
  label,
  children,
}: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="py-1">
      <div className="px-4 pt-2 pb-1 nockta-eyebrow text-muted-foreground/60">
        {label}
      </div>
      <ul>{children}</ul>
    </div>
  );
}

function ResultRow({
  active,
  onMouseEnter,
  onClick,
  icon,
  kicker,
  label,
  hint,
  trailing,
}: {
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  icon: React.ReactNode;
  kicker?: string | undefined;
  label: string;
  hint?: string | undefined;
  trailing?: React.ReactNode;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        data-no-press
        className={cn(
          'relative w-full text-left px-4 py-2 flex items-center gap-3 transition-colors duration-100',
          active ? 'bg-brand/12 text-foreground' : 'hover:bg-accent/40',
        )}
      >
        {/* Brand-colored left bar on the active row */}
        <span
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 h-6 w-[2px] rounded-r-full bg-brand transition-opacity duration-150',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
        {icon}
        {kicker && (
          <span className="text-[11px] font-mono text-muted-foreground shrink-0 w-16">
            {kicker}
          </span>
        )}
        <span className="flex-1 min-w-0">
          <span className="text-sm truncate block">{label}</span>
          {hint && (
            <span className="text-[11px] text-muted-foreground truncate block">{hint}</span>
          )}
        </span>
        {trailing}
      </button>
    </li>
  );
}

/* -----------------------------------------------------------------------------
 * Facet sidebar — multi-select checkboxes grouped by dimension. Each
 * dimension shows up to N entries (server returns 200 max); the UI cap is
 * tighter so the panel doesn't dominate. Counts come from the server's
 * groupBy aggregates over the SAME filtered set the results list uses.
 * -------------------------------------------------------------------------- */

function FacetSidebar({
  facets,
  selection,
  onToggle,
  loading,
}: {
  facets: FacetsResponse | null;
  selection: FacetSelection;
  onToggle: (dim: keyof FacetSelection, value: string) => void;
  loading: boolean;
}): JSX.Element {
  if (loading && !facets) {
    return <div className="text-muted-foreground">Loading facets…</div>;
  }
  if (!facets) {
    return <div className="text-muted-foreground">Type a query to see facets.</div>;
  }
  return (
    <div className="space-y-4">
      <FacetGroup
        title="Status"
        entries={facets.byStatus.map((s) => ({ value: s.status, label: s.status, count: s.count }))}
        selected={selection.statuses}
        onToggle={(v) => onToggle('statuses', v)}
      />
      <FacetGroup
        title="Priority"
        entries={facets.byPriority.map((p) => ({ value: p.priority, label: p.priority, count: p.count }))}
        selected={selection.priorities}
        onToggle={(v) => onToggle('priorities', v)}
      />
      <FacetGroup
        title="Type"
        entries={facets.byType.map((t) => ({ value: t.type, label: t.type, count: t.count }))}
        selected={selection.types}
        onToggle={(v) => onToggle('types', v)}
      />
      <FacetGroup
        title="Project"
        entries={facets.byProject.map((p) => ({ value: p.projectId, label: p.name, count: p.count }))}
        selected={selection.projectIds}
        onToggle={(v) => onToggle('projectIds', v)}
      />
      <FacetGroup
        title="Assignee"
        entries={facets.byAssignee.map((a) => ({ value: a.userId, label: a.name, count: a.count }))}
        selected={selection.assigneeUserIds}
        onToggle={(v) => onToggle('assigneeUserIds', v)}
      />
      <FacetGroup
        title="Label"
        entries={facets.byLabel.map((l) => ({ value: l.labelId, label: l.name, count: l.count }))}
        selected={selection.labelIds}
        onToggle={(v) => onToggle('labelIds', v)}
      />
      <FacetGroup
        title="Sprint"
        entries={facets.bySprint.map((s) => ({ value: s.sprintId, label: s.name, count: s.count }))}
        selected={selection.sprintIds}
        onToggle={(v) => onToggle('sprintIds', v)}
      />
    </div>
  );
}

function FacetGroup({
  title,
  entries,
  selected,
  onToggle,
}: {
  title: string;
  entries: { value: string; label: string; count: number }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="nockta-eyebrow text-muted-foreground/70 mb-1.5">{title}</div>
      <ul className="space-y-0.5">
        {entries.slice(0, 12).map((e) => {
          const isOn = selected.has(e.value);
          return (
            <li key={e.value}>
              <label
                className={cn(
                  'flex items-center gap-2 cursor-pointer rounded px-1.5 py-0.5 hover:bg-accent/40 transition-colors',
                  isOn && 'bg-accent/30',
                )}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => onToggle(e.value)}
                  className="h-3 w-3 accent-brand"
                />
                <span className="flex-1 truncate text-foreground/90">{e.label}</span>
                <span className="text-muted-foreground tabular-nums text-[10px]">{e.count}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FacetChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex items-center gap-1 rounded-full bg-accent/40 text-foreground border border-border px-2 py-0.5 text-[11px] hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      aria-label={`Remove filter ${label}`}
      title="Remove this filter"
    >
      <span>{label}</span>
      <X className="h-2.5 w-2.5 opacity-60" aria-hidden="true" />
    </button>
  );
}
