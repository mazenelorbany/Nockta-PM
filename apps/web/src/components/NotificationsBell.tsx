import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Check, Filter, Inbox, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { cn } from '@nockta/ui';

import { api } from '../lib/api';
import { getSocket } from '../lib/socket';
import { queryKeys } from '../lib/query-keys';

interface Notification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsList {
  items: Notification[];
  nextCursor: string | null;
}

interface ProjectSummary {
  id: string;
  key: string;
  name: string;
}

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'TaskAssigned', label: 'Assigned to me' },
  { value: 'MentionedInComment', label: '@Mentions' },
  { value: 'CommentAdded', label: 'Comments' },
  { value: 'TaskUpdated', label: 'Task updates' },
  { value: 'TaskStatusChanged', label: 'Status changes' },
  { value: 'TaskBlocked', label: 'Blocked' },
  { value: 'ClientReportedBug', label: 'Client bugs' },
  { value: 'DeploymentFailed', label: 'Deploy failed' },
];

type ReadFilter = 'all' | 'unread' | 'read';

interface BellFilters {
  types: Set<string>;
  projectIds: Set<string>;
  read: ReadFilter;
  since: 'all' | '24h' | '7d';
}

const DEFAULT_FILTERS: BellFilters = {
  types: new Set(),
  projectIds: new Set(),
  read: 'all',
  since: 'all',
};

export function NotificationsBell(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<BellFilters>(DEFAULT_FILTERS);
  const ref = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
  });

  // Server-side filters that the API natively supports. Everything else is
  // filtered client-side from the same `limit=20` response.
  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set('limit', '50');
    if (filters.read === 'unread') p.set('unreadOnly', 'true');
    if (filters.types.size > 0) p.set('type', Array.from(filters.types).join(','));
    if (filters.projectIds.size === 1) {
      const only = Array.from(filters.projectIds)[0];
      if (only) p.set('projectId', only);
    }
    return p.toString();
  }, [filters]);

  const listQuery = useQuery({
    queryKey: ['notifications', 'list', queryString],
    queryFn: () => api.get<NotificationsList>(`/notifications?${queryString}`),
    enabled: open,
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ProjectSummary[]>('/projects'),
    enabled: open,
  });

  // Realtime — new notifications bump the badge immediately.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const onNew = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      socket.on('notification.created', onNew);
      cleanup = () => {
        socket.off('notification.created', onNew);
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [queryClient]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/mark-all-read'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  const markOne = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
  // Quick-snooze from the bell: stamps the workspace-wide sentinel pref so
  // Chat + desktop notifications stay quiet for the chosen window. In-app
  // continues to count so the user can catch up after.
  const snooze = useMutation({
    mutationFn: (minutes: number) =>
      api.patch('/notifications/preferences/snooze-all', { minutes }),
    onSuccess: (_, _minutes) => {
      void queryClient.invalidateQueries({ queryKey: ['notification-prefs'] });
      // No invalidation of unread-count needed — in-app stays on by design.
    },
  });
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const unread = unreadQuery.data?.count ?? 0;
  const rawItems = listQuery.data?.items ?? [];
  // Client-side filters for read/since/multi-project. Server can only narrow
  // by one projectId + a comma-joined type list; the rest happens here.
  const items = useMemo(() => {
    const cutoff =
      filters.since === '24h'
        ? Date.now() - 24 * 60 * 60_000
        : filters.since === '7d'
          ? Date.now() - 7 * 24 * 60 * 60_000
          : 0;
    return rawItems.filter((n) => {
      if (filters.read === 'read' && !n.readAt) return false;
      if (filters.read === 'unread' && n.readAt) return false;
      if (cutoff > 0 && new Date(n.createdAt).getTime() < cutoff) return false;
      if (filters.projectIds.size > 1 && n.relatedProjectId) {
        if (!filters.projectIds.has(n.relatedProjectId)) return false;
      }
      return true;
    });
  }, [rawItems, filters]);

  const activeFilterCount =
    filters.types.size +
    filters.projectIds.size +
    (filters.read === 'all' ? 0 : 1) +
    (filters.since === 'all' ? 0 : 1);

  return (
    <div className="relative" ref={ref} data-tour="notifications-bell">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="tap relative rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-[transform,background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-brand text-brand-foreground text-[10px] font-bold flex items-center justify-center px-1">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="animate-popover-in absolute right-0 top-full mt-2 w-96 rounded-lg border border-border bg-popover shadow-2xl z-30 overflow-hidden"
          style={{ transformOrigin: 'top right' }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-semibold">{'Notifications'}</span>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => markAll.mutate()}
                  className="tap text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
                >
                  <Check className="h-3 w-3" />
                  {'Mark all read'}
                </button>
              )}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSnoozeOpen((v) => !v)}
                  className="tap text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  aria-haspopup="menu"
                  aria-expanded={snoozeOpen}
                  aria-label={'Snooze notifications'}
                  title={'Snooze notifications'}
                >
                  <BellOff className="h-3 w-3" aria-hidden="true" />
                </button>
                {snoozeOpen && (
                  <div
                    role="menu"
                    className="absolute end-0 top-full mt-1 w-48 rounded-md border border-border bg-popover shadow-xl z-40 py-1 text-xs"
                  >
                    {[
                      { label: 'Snooze 1 hour', minutes: 60 },
                      { label: 'Snooze 4 hours', minutes: 240 },
                      { label: 'Snooze until tomorrow', minutes: minutesUntilTomorrow9am() },
                      { label: 'Clear snooze', minutes: 0 },
                    ].map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          snooze.mutate(p.minutes);
                          setSnoozeOpen(false);
                        }}
                        className="block w-full text-start px-3 py-1.5 hover:bg-accent transition-colors"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <FilterChips
            filters={filters}
            onChange={setFilters}
            projects={projectsQuery.data ?? []}
            activeCount={activeFilterCount}
          />
          <div className="max-h-[420px] overflow-y-auto">
            {listQuery.isLoading ? (
              <div className="p-4 text-xs text-muted-foreground">{'Loading…'}</div>
            ) : items.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                {"You're all caught up."}
              </div>
            ) : (
              <ul className="stagger-list">
                {items.map((n) => (
                  <li key={n.id} className="stagger-item">
                    <NotificationItem
                      n={n}
                      onClick={() => {
                        if (!n.readAt) markOne.mutate(n.id);
                        setOpen(false);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Link
            to="/inbox"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border-t border-border px-3 py-2 transition-colors"
          >
            <Inbox className="h-3 w-3" />
            {'Open inbox'}
          </Link>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Filter chips — small multi-select bar above the notification list. Each
// chip opens a portal popover so the open dropdown isn't clipped by the
// notification panel's overflow:hidden.
// =============================================================================

function FilterChips({
  filters,
  onChange,
  projects,
  activeCount,
}: {
  filters: BellFilters;
  onChange: (next: BellFilters) => void;
  projects: ProjectSummary[];
  activeCount: number;
}): JSX.Element {
  function clear(): void {
    onChange(DEFAULT_FILTERS);
  }

  // Translate the TYPE_OPTIONS at render time so a language switch refreshes
  // the chip labels without remounting the component.
  const typeOptions = TYPE_OPTIONS.map((opt) => ({
    value: opt.value,
    label: opt.label,
  }));

  return (
    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border overflow-x-auto">
      <Filter className="h-3 w-3 text-muted-foreground shrink-0" />
      <Chip
        label={'Type'}
        count={filters.types.size}
        renderPopover={(close) => (
          <CheckboxList
            options={typeOptions}
            selected={filters.types}
            onChange={(next) => onChange({ ...filters, types: next })}
            onClose={close}
          />
        )}
      />
      <Chip
        label={'Project'}
        count={filters.projectIds.size}
        renderPopover={(close) => (
          <CheckboxList
            options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
            selected={filters.projectIds}
            onChange={(next) => onChange({ ...filters, projectIds: next })}
            onClose={close}
          />
        )}
      />
      <Chip
        label={
          filters.read === 'all'
            ? 'Read state'
            : filters.read === 'unread'
              ? 'Unread'
              : 'Read'
        }
        active={filters.read !== 'all'}
        renderPopover={(close) => (
          <RadioList
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread only' },
              { value: 'read', label: 'Read only' },
            ]}
            selected={filters.read}
            onChange={(v) => {
              onChange({ ...filters, read: v as ReadFilter });
              close();
            }}
          />
        )}
      />
      <Chip
        label={
          filters.since === 'all'
            ? 'Time'
            : filters.since === '24h'
              ? 'Last 24h'
              : 'Last 7d'
        }
        active={filters.since !== 'all'}
        renderPopover={(close) => (
          <RadioList
            options={[
              { value: 'all', label: 'Anytime' },
              { value: '24h', label: 'Last 24 hours' },
              { value: '7d', label: 'Last 7 days' },
            ]}
            selected={filters.since}
            onChange={(v) => {
              onChange({ ...filters, since: v as BellFilters['since'] });
              close();
            }}
          />
        )}
      />
      {activeCount > 0 && (
        <button
          type="button"
          onClick={clear}
          className="tap ms-auto rounded-md px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0"
        >
          <X className="h-2.5 w-2.5" /> {'Clear'}
        </button>
      )}
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  renderPopover,
}: {
  label: string;
  count?: number;
  active?: boolean;
  renderPopover: (close: () => void) => React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const isActive = active === true || (count !== undefined && count > 0);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'tap inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors shrink-0',
          isActive
            ? 'border-brand/50 bg-brand/10 text-brand'
            : 'border-border text-muted-foreground hover:bg-accent',
        )}
      >
        {label}
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-brand text-brand-foreground px-1 text-[9px] font-bold">
            {count}
          </span>
        )}
      </button>
      {open && (
        <PortalPopover anchor={anchorRef.current} onClose={() => setOpen(false)}>
          {renderPopover(() => setOpen(false))}
        </PortalPopover>
      )}
    </>
  );
}

function PortalPopover({
  anchor,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (!ref.current) return;
      if (
        ref.current.contains(e.target as Node) ||
        (anchor && anchor.contains(e.target as Node))
      ) {
        return;
      }
      onClose();
    }
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [anchor, onClose]);

  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[60] w-56 rounded-md border border-border bg-popover shadow-xl"
      style={{ top: rect.bottom + 4, left: Math.max(8, rect.left) }}
    >
      {children}
    </div>,
    document.body,
  );
}

function CheckboxList({
  options,
  selected,
  onChange,
  onClose: _onClose,
}: {
  options: Array<{ value: string; label: string }>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  onClose: () => void;
}): JSX.Element {
  if (options.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">No options.</div>;
  }
  return (
    <div className="max-h-60 overflow-y-auto py-1">
      {options.map((opt) => {
        const checked = selected.has(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              const next = new Set(selected);
              if (checked) next.delete(opt.value);
              else next.add(opt.value);
              onChange(next);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-start"
          >
            <span
              className={cn(
                'h-3.5 w-3.5 rounded-sm border flex items-center justify-center shrink-0',
                checked ? 'bg-brand border-brand text-brand-foreground' : 'border-border',
              )}
            >
              {checked && <Check className="h-2.5 w-2.5" />}
            </span>
            <span className="truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RadioList({
  options,
  selected,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  selected: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <div className="py-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent text-start',
            selected === opt.value && 'text-brand',
          )}
        >
          <span
            className={cn(
              'h-3 w-3 rounded-full border flex items-center justify-center shrink-0',
              selected === opt.value ? 'border-brand' : 'border-border',
            )}
          >
            {selected === opt.value && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
          </span>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function minutesUntilTomorrow9am(): number {
  const d = new Date();
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return Math.max(1, Math.round((tomorrow.getTime() - d.getTime()) / 60_000));
}

function NotificationItem({ n, onClick }: { n: Notification; onClick: () => void }): JSX.Element {
  const unread = !n.readAt;
  const href =
    n.relatedTaskId && n.relatedProjectId
      ? `/projects/${n.relatedProjectId}/board?task=${n.relatedTaskId}`
      : '#';
  const summary =
    typeof n.payload['title'] === 'string'
      ? (n.payload['title'] as string)
      : prettyType(n.type);

  return (
    <Link
      to={href}
      onClick={onClick}
      className={cn(
        'block px-3 py-2.5 border-b border-border last:border-b-0 hover:bg-accent/40 transition-colors',
        unread && 'bg-accent/20',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-1.5 h-1.5 w-1.5 rounded-full shrink-0',
            unread ? 'bg-brand' : 'bg-muted',
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs nockta-eyebrow text-muted-foreground mb-0.5">
            {prettyType(n.type)}
          </div>
          <div className="text-sm font-medium truncate">{summary}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {formatRelative(n.createdAt)}
          </div>
        </div>
      </div>
    </Link>
  );
}

function prettyType(t: string): string {
  return t.replace(/([A-Z])/g, ' $1').replace(/^_/, '').trim().toLowerCase();
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = 60_000, h = 60 * m, d = 24 * h;
  if (diff < m) return 'just now';
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 7 * d) return `${Math.floor(diff / d)}d ago`;
  return new Date(iso).toLocaleDateString();
}
