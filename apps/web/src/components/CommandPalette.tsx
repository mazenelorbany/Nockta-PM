import { useMutation, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bookmark,
  CornerDownLeft,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { FacetChip } from './command-palette/FacetChip';
import { FacetSidebar } from './command-palette/FacetSidebar';
import { ResultsBody } from './command-palette/ResultsBody';
import {
  appendFacetParams,
  emptyFacetSelection,
  facetSelectionIsEmpty,
  serializeFacets,
  type FacetSelection,
  type FacetsResponse,
} from './command-palette/facets';
import { parseChips, type ChipModel } from './command-palette/parseChips';
import { loadRecents, saveRecent } from './command-palette/recents';
import {
  QUICK_ROUTES,
  type Hit,
  type RecentEntry,
  type SearchDoc,
  type SearchResp,
} from './command-palette/types';
import { useDebounced } from './command-palette/useDebounced';

export function CommandPalette(): JSX.Element | null {
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
            aria-label={'Type a command, jump to a task, or search…'}
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
                placeholder={'Type a command, jump to a task, or search…'}
                aria-label={'Search'}
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
