import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';
import { api } from '../../lib/api';
import {
  BlockedBadge,
  PriorityDot,
  StatusPill,
  TypeBadge,
} from '../task-bits';
import { PresenceAvatars } from '../PresenceAvatars';
import type { TaskDetail } from './types';
import { apiErrorMessage } from './utils';

export function DrawerHeader({
  task,
  onClose,
  onDelete,
  onToggleBlocked,
  onToggleWatch,
  onOpenTask,
  blockedPending,
  watchPending,
  deleting,
}: {
  task: TaskDetail;
  onClose: () => void;
  onDelete: () => void;
  onToggleBlocked: () => void;
  onToggleWatch: (watching: boolean) => void;
  onOpenTask: (id: string) => void;
  blockedPending: boolean;
  watchPending: boolean;
  deleting: boolean;
}): JSX.Element {
  // We don't currently get back "is the current user watching" from the API,
  // so we offer both Watch / Unwatch and let the user pick. The endpoints
  // are idempotent.
  return (
    <header className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-6 py-3 flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1 min-w-0">
        {task.parent && (
          <button
            type="button"
            onClick={() => onOpenTask(task.parent!.id)}
            className="tap inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors max-w-fit"
            title="Open parent task"
          >
            <TypeBadge type={task.parent.type} size="xs" />
            <span className="font-mono">{task.project.key}-{task.parent.keyNumber}</span>
            <span className="truncate max-w-[280px]">{task.parent.title}</span>
            <span className="text-muted-foreground/50">/</span>
          </button>
        )}
        <div className="flex items-center gap-2.5 flex-wrap">
          <TypeBadge type={task.type} showLabel />
          <span className="text-xs font-mono text-muted-foreground">{task.key}</span>
          <StatusPill status={task.status} />
          <PriorityDot priority={task.priority} />
          <BlockedBadge blocked={task.isBlocked} />
          <PresenceAvatars room={`task:${task.id}`} size={20} />
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleBlocked}
          disabled={blockedPending}
          className={cn(
            'tap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 inline-flex items-center gap-1.5',
            task.isBlocked
              ? 'bg-status-blocked/20 text-status-blocked hover:bg-status-blocked/30'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          title={task.isBlocked ? 'Unblock' : 'Flag as blocked'}
        >
          <span aria-hidden="true">⚑</span>
          {task.isBlocked ? 'Unblock' : 'Flag'}
        </button>
        <WatchMenu onToggle={onToggleWatch} pending={watchPending} />
        <MuteTaskButton taskId={task.id} />
        <SaveAsTemplateButton task={task} />
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="tap rounded-md px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
        >
          {deleting
            ? 'Deleting…'
            : 'Delete'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={'Close'}
          className="tap rounded-md w-8 h-8 flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </header>
  );
}

export function SaveAsTemplateButton({ task }: { task: TaskDetail }): JSX.Element {
  const save = useMutation({
    mutationFn: (name: string) =>
      api.post(`/projects/${task.projectId}/task-templates`, {
        name,
        titleTemplate: task.title,
        bodyTemplate: task.description ?? null,
        priority: task.priority,
        estimate: task.estimate ?? null,
        defaultStatus: task.status,
      }),
    onSuccess: () => toast.success('Saved as template'),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not save template')),
  });
  return (
    <button
      type="button"
      onClick={() => {
        const name = prompt('Name for this template:', task.title);
        if (!name?.trim()) return;
        save.mutate(name.trim());
      }}
      disabled={save.isPending}
      className="tap rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
      title="Save this task as a template"
    >
      {save.isPending ? 'Saving…' : 'Save as template'}
    </button>
  );
}

/// Per-task mute toggle. Backed by the new `/notifications/mutes` endpoint —
/// distinct from `Watch` (which controls "do I get notified at all") in that
/// MUTE explicitly drops notifications for a task you ARE watching. The
/// dispatcher consults NotificationMute alongside the legacy TaskMute table.
export function MuteTaskButton({ taskId }: { taskId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const mutesQuery = useQuery({
    queryKey: ['notifications', 'mutes'],
    queryFn: () =>
      api.get<Array<{ id: string; entityType: string; entityId: string }>>(
        '/notifications/mutes',
      ),
  });
  const isMuted = (mutesQuery.data ?? []).some(
    (m) => m.entityType === 'task' && m.entityId === taskId,
  );

  const mute = useMutation({
    mutationFn: () =>
      api.post('/notifications/mutes', { entityType: 'task', entityId: taskId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'mutes'] });
      toast.success('Notifications muted for this task');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not mute')),
  });
  const unmute = useMutation({
    mutationFn: () => api.delete(`/notifications/mutes/task/${taskId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'mutes'] });
      toast.success('Notifications unmuted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not unmute')),
  });

  return (
    <button
      type="button"
      onClick={() => (isMuted ? unmute.mutate() : mute.mutate())}
      disabled={mute.isPending || unmute.isPending}
      className={cn(
        'tap rounded-md px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50 inline-flex items-center gap-1.5',
        isMuted
          ? 'bg-muted text-foreground hover:bg-muted/70'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      title={isMuted ? 'Notifications muted — click to unmute' : 'Mute notifications for this task'}
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        {isMuted ? (
          <>
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
            <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
            <path d="M18 8a6 6 0 0 0-9.33-5" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </>
        ) : (
          <>
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </>
        )}
      </svg>
      {isMuted ? 'Muted' : 'Mute'}
    </button>
  );
}

export function WatchMenu({ onToggle, pending }: { onToggle: (w: boolean) => void; pending: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        className="tap rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        title="Watch this task"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Watch
      </button>
      {open && (
        <div
          className="animate-popover-in absolute right-0 top-full mt-1 rounded-md border border-border bg-popover shadow-lg z-20 min-w-[160px]"
          style={{ transformOrigin: 'top right' }}
          onMouseLeave={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => { onToggle(true); setOpen(false); }}
            className="tap w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors"
          >
            Watch this task
          </button>
          <button
            type="button"
            onClick={() => { onToggle(false); setOpen(false); }}
            className="tap w-full text-left px-3 py-2 text-xs hover:bg-accent transition-colors border-t border-border"
          >
            Stop watching
          </button>
        </div>
      )}
    </div>
  );
}
