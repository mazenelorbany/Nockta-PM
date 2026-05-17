import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AtSign, Bell, Check, CheckCheck, Inbox, RotateCcw, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn, EmptyState, QueryErrorState, SkeletonList } from '@nockta/ui';
import { api } from '../lib/api';
import { getSocket } from '../lib/socket';

// =============================================================================
// /inbox — full notifications inbox.
//
// The bell dropdown only fits ~20 rows. This page is the canonical view: tabs
// for All / Unread / Mentions, per-project filter, bulk + per-row read state,
// delete, and pagination via the cursor the API already returns.
// =============================================================================

type Tab = 'all' | 'unread' | 'mentions';

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

export function InboxPage(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('unread');
  const [projectId, setProjectId] = useState<string>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Selection set for bulk actions. Reset whenever the filter changes so the
  // bulk button doesn't hold IDs from a hidden tab.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { setSelected(new Set()); setCursor(undefined); }, [tab, projectId]);

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectSummary[]>('/projects'),
  });

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set('limit', '50');
    if (tab === 'unread') p.set('unreadOnly', 'true');
    if (tab === 'mentions') p.set('type', 'MentionedInComment');
    if (projectId) p.set('projectId', projectId);
    if (cursor) p.set('cursor', cursor);
    return p.toString();
  }, [tab, projectId, cursor]);

  const listQuery = useQuery({
    queryKey: ['inbox', queryString],
    queryFn: () => api.get<NotificationsList>(`/notifications?${queryString}`),
  });

  // Live update: when a new notification lands, invalidate the inbox.
  useEffect(() => {
    const socket = getSocket();
    const onNew = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    socket.on('notification.created', onNew);
    return () => { socket.off('notification.created', onNew); };
  }, [queryClient]);

  const invalidateAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markRead = useMutation({
    mutationFn: (ids: string[]) => api.post('/notifications/read', { ids }),
    onSuccess: invalidateAll,
    onError: (err) => toast.error(apiErr(err, 'Could not mark as read')),
  });
  const markUnread = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/unread`),
    onSuccess: invalidateAll,
    onError: (err) => toast.error(apiErr(err, 'Could not mark as unread')),
  });
  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/mark-all-read'),
    onSuccess: () => {
      invalidateAll();
      toast.success('All caught up.');
    },
    onError: (err) => toast.error(apiErr(err, 'Could not mark all read')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/${id}`),
    onSuccess: invalidateAll,
    onError: (err) => toast.error(apiErr(err, 'Could not delete')),
  });

  const items = listQuery.data?.items ?? [];
  const allSelectedOnPage = items.length > 0 && items.every((n) => selected.has(n.id));

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    if (allSelectedOnPage) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((n) => n.id)));
    }
  }

  function bulkMarkRead(): void {
    const unread = items.filter((n) => !n.readAt && selected.has(n.id)).map((n) => n.id);
    if (unread.length === 0) return;
    markRead.mutate(unread, {
      onSettled: () => setSelected(new Set()),
    });
  }

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border px-4 sm:px-6 md:px-8 py-5">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <span className="nockta-eyebrow text-muted-foreground inline-flex items-center gap-1.5">
              <Inbox className="h-3 w-3" /> {t('inbox.eyebrow', 'Inbox')}
            </span>
            <h1 className="text-xl font-semibold tracking-tight mt-1">
              {t('inbox.title', 'Notifications')}
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              {t('inbox.subtitle', 'Everything addressed to you across every project.')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="tap inline-flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-1.5 text-xs hover:bg-accent transition-colors disabled:opacity-50"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            {t('notifications_bell.mark_all_read', 'Mark all read')}
          </button>
        </div>

        {/* Tabs */}
        <div className="mt-5 flex items-center gap-1 flex-wrap">
          <TabButton active={tab === 'all'} onClick={() => setTab('all')} icon={<Bell className="h-3.5 w-3.5" />}>
            {t('inbox.tab_all', 'All')}
          </TabButton>
          <TabButton active={tab === 'unread'} onClick={() => setTab('unread')} icon={<Bell className="h-3.5 w-3.5" />}>
            {t('inbox.tab_unread', 'Unread')}
          </TabButton>
          <TabButton active={tab === 'mentions'} onClick={() => setTab('mentions')} icon={<AtSign className="h-3.5 w-3.5" />}>
            {t('inbox.tab_mentions', 'Mentions')}
          </TabButton>

          <div className="h-4 w-px bg-border mx-2" />

          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="field text-xs py-1.5"
          >
            <option value="">{t('inbox.all_projects', 'All projects')}</option>
            {(projectsQuery.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.key} · {p.name}</option>
            ))}
          </select>
        </div>
      </header>

      {selected.size > 0 && (
        <div className="border-b border-border bg-accent/30 px-4 sm:px-6 md:px-8 py-2 flex items-center justify-between text-xs">
          <span>{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={bulkMarkRead}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 hover:bg-accent transition-colors"
            >
              <Check className="h-3 w-3" /> Mark as read
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 md:px-8 py-4">
        {listQuery.isError ? (
          <QueryErrorState
            title="Couldn't load your inbox"
            error={listQuery.error}
            onRetry={() => void listQuery.refetch()}
          />
        ) : listQuery.isLoading ? (
          <SkeletonList rows={8} rowClassName="h-16" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-5 w-5" />}
            title={
              tab === 'unread'
                ? "You're all caught up"
                : tab === 'mentions'
                ? 'No mentions yet'
                : 'Nothing in your inbox'
            }
            description={
              tab === 'unread'
                ? 'New notifications will show up here in real time.'
                : 'When someone @-mentions you, the comment will land here.'
            }
          />
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2 px-1">
              <input
                type="checkbox"
                checked={allSelectedOnPage}
                onChange={toggleAll}
                aria-label="Select all on this page"
                className="rounded border-border"
              />
              <span className="text-xs text-muted-foreground">
                {items.length} {items.length === 1 ? 'notification' : 'notifications'}
              </span>
            </div>
            <ul className="rounded-lg border border-border divide-y divide-border overflow-hidden bg-card/40">
              {items.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  selected={selected.has(n.id)}
                  onToggleSelect={() => toggleSelect(n.id)}
                  onClickLink={() => { if (!n.readAt) markRead.mutate([n.id]); }}
                  onMarkRead={() => markRead.mutate([n.id])}
                  onMarkUnread={() => markUnread.mutate(n.id)}
                  onDelete={() => remove.mutate(n.id)}
                />
              ))}
            </ul>

            {/* Pagination — cursor-based. The bell stays at 20; we go 50 per page here. */}
            <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
              <button
                type="button"
                disabled={!cursor}
                onClick={() => setCursor(undefined)}
                className="rounded-md border border-border px-3 py-1 disabled:opacity-30 hover:bg-accent transition-colors"
              >
                Newest
              </button>
              <button
                type="button"
                disabled={!listQuery.data?.nextCursor}
                onClick={() => setCursor(listQuery.data?.nextCursor ?? undefined)}
                className="rounded-md border border-border px-3 py-1 disabled:opacity-30 hover:bg-accent transition-colors"
              >
                Older →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, icon, children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors',
        active
          ? 'bg-accent text-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function NotificationRow({
  n, selected, onToggleSelect, onClickLink, onMarkRead, onMarkUnread, onDelete,
}: {
  n: Notification;
  selected: boolean;
  onToggleSelect: () => void;
  onClickLink: () => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onDelete: () => void;
}): JSX.Element {
  const unread = !n.readAt;
  const href = deepLink(n);
  const summary =
    typeof n.payload['title'] === 'string'
      ? (n.payload['title'] as string)
      : prettyType(n.type);

  return (
    <li className="flex items-start gap-3 px-3 py-3 hover:bg-accent/30 transition-colors">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label="Select notification"
        className="mt-1 rounded border-border"
      />
      <span
        className={cn(
          'mt-1.5 h-1.5 w-1.5 rounded-full shrink-0',
          unread ? 'bg-brand' : 'bg-muted',
        )}
        aria-hidden="true"
      />
      <Link
        to={href}
        onClick={onClickLink}
        className="flex-1 min-w-0"
      >
        <div className="nockta-eyebrow text-muted-foreground mb-0.5">
          {prettyType(n.type)}
        </div>
        <div className={cn('text-sm truncate', unread && 'font-medium')}>{summary}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {formatRelative(n.createdAt)}
        </div>
      </Link>
      <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100">
        {unread ? (
          <button
            type="button"
            onClick={onMarkRead}
            title="Mark as read"
            className="rounded-md p-1 hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onMarkUnread}
            title="Mark as unread"
            className="rounded-md p-1 hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          className="rounded-md p-1 hover:bg-status-blocked/10 text-muted-foreground hover:text-status-blocked"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

// Build a deep-link for each notification type. Falls back to the project board
// when we can identify the project, and the inbox itself otherwise.
function deepLink(n: Notification): string {
  if (n.relatedTaskId && n.relatedProjectId) {
    return `/projects/${n.relatedProjectId}/board?task=${n.relatedTaskId}`;
  }
  if (n.relatedProjectId) {
    return `/projects/${n.relatedProjectId}`;
  }
  return '/inbox';
}

function prettyType(t: string): string {
  // "MentionedInComment" -> "mentioned in comment"
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

function apiErr(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.problem.title || err.message : fallback;
}
