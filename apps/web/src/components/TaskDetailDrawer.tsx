import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@nockta/ui';
import { CheckCircle2, MessageSquarePlus, UserPlus } from 'lucide-react';

import { api } from '../lib/api';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { usePresence } from '../hooks/usePresence';
import { getSocket } from '../lib/socket';
import { queryKeys } from '../lib/query-keys';

import { ConfirmDialog, PromptDialog } from './dialogs';
import { ActivitySection, ActivityTab, CommentsThread } from './task-detail/Activity';
import { AttachmentsSection } from './task-detail/Attachments';
import { CustomFieldsSection } from './task-detail/CustomFields';
import { DescriptionField } from './task-detail/DescriptionField';
import { DrawerHeader } from './task-detail/DrawerHeader';
import { MetaGrid } from './task-detail/MetaGrid';
import { RecurrenceSection } from './task-detail/Recurrence';
import { SimilarTasksSection } from './task-detail/SimilarTasks';
import { LinkedTasksSection, SubtasksSection } from './task-detail/Subtasks';
import { TitleField } from './task-detail/TitleField';
import type {
  Comment,
  TaskDetail,
  UserListResponse,
} from './task-detail/types';
import { apiErrorMessage } from './task-detail/utils';
import { useTaskDrawerState } from './task-detail/useTaskDrawerState';
import { useTaskUpdate } from './task-detail/useTaskUpdate';


export function TaskDetailDrawer({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}): JSX.Element {
  // Mobile detection — drives layout (bottom sheet vs. centered modal),
  // tabs (instead of side-by-side panes), and the swipe-down-to-dismiss
  // gesture. Matches the same breakpoint Tailwind uses for md:.
  // Use the bottom-sheet pattern only on actual phone widths. Tablet /
  // narrow-laptop viewports (640–768px) used to flip to the mobile branch
  // and ended up showing a half-height drawer pinned to the bottom of the
  // screen, with the rest of the ticket content hidden below the fold.
  // The centered-modal branch already handles narrow viewports via
  // `h-full sm:h-[min(92vh,1000px)]`, so we just need to raise the
  // threshold for the mobile branch.
  const isMobile = useMediaQuery('(max-width: 640px)');
  const {
    closing,
    requestClose,
    activityTab,
    setActivityTab,
    mobileTab,
    setMobileTab,
    dragOffsetY,
    dragHandlers,
  } = useTaskDrawerState({ isMobile, onClose });
  const queryClient = useQueryClient();
  // Drawer-internal navigation: clicking a subtask or the parent breadcrumb
  // updates ?task=ID, which re-renders this drawer with the new id. Pages that
  // mount this drawer all read the same `?task=` param, so swapping in the URL
  // works regardless of which page is hosting the drawer.
  const [, setSearchParams] = useSearchParams();
  function openTask(id: string): void {
    setSearchParams((sp) => {
      sp.set('task', id);
      return sp;
    }, { replace: false });
  }

  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${taskId}`),
  });
  const commentsQuery = useQuery({
    queryKey: ['comments', taskId],
    queryFn: () => api.get<Comment[]>(`/tasks/${taskId}/comments`),
  });
  const usersQuery = useQuery({
    queryKey: queryKeys.usersList(),
    queryFn: () => api.get<UserListResponse>('/users?limit=100'),
  });

  // Pass I (Realtime 8→9). Join the task's presence sub-room so the gateway
  // pings every other viewer with our cursor heartbeat. The activeUserIds
  // result drives a "viewing now" pill alongside the existing PresenceAvatars
  // (which tracks the legacy `task:<id>` room — they share most users in
  // practice but the presence room is specifically the open-drawer set).
  usePresence(taskId);

  // Realtime: join the task room and refetch on relevant events.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const refetchTask = () => queryClient.invalidateQueries({ queryKey: ['task', taskId] });
    const refetchComments = () => queryClient.invalidateQueries({ queryKey: ['comments', taskId] });
    const refetchActivity = () => queryClient.invalidateQueries({ queryKey: ['activity', taskId] });
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      socket.emit('task:join', { taskId });
      socket.on('task.updated', refetchTask);
      socket.on('task.status_changed', refetchTask);
      socket.on('task.blocked', refetchTask);
      socket.on('task.unblocked', refetchTask);
      socket.on('comment.added', refetchComments);
      socket.on('comment.edited', refetchComments);
      socket.on('comment.deleted', refetchComments);
      socket.on('comment.reaction_added', refetchComments);
      socket.on('comment.reaction_removed', refetchComments);
      socket.on('event.created', refetchActivity);
      cleanup = () => {
        socket.emit('task:leave', { taskId });
        socket.off('task.updated', refetchTask);
        socket.off('task.status_changed', refetchTask);
        socket.off('task.blocked', refetchTask);
        socket.off('task.unblocked', refetchTask);
        socket.off('comment.added', refetchComments);
        socket.off('comment.edited', refetchComments);
        socket.off('comment.deleted', refetchComments);
        socket.off('comment.reaction_added', refetchComments);
        socket.off('comment.reaction_removed', refetchComments);
        socket.off('event.created', refetchActivity);
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [taskId, queryClient]);

  const task = taskQuery.data;
  const users = usersQuery.data?.items ?? [];

  const updateMutation = useTaskUpdate({ taskId, task });

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      api.patch<TaskDetail>(`/tasks/${taskId}/status`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(task?.projectId) });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Status change failed')),
  });

  const blockMutation = useMutation({
    mutationFn: ({ blocked, reason }: { blocked: boolean; reason?: string }) =>
      api.patch(`/tasks/${taskId}/blocked`, { blocked, ...(reason ? { reason } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(task?.projectId) });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update blocked')),
  });

  const watchMutation = useMutation({
    mutationFn: (watching: boolean) =>
      watching
        ? api.post(`/tasks/${taskId}/watch`)
        : api.delete(`/tasks/${taskId}/watch`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update watch')),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<void>(`/tasks/${taskId}`),
    onSuccess: () => {
      toast.success('Task deleted');
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(task?.projectId) });
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });

  // Dialog state — replaces native window.confirm / window.prompt so the
  // delete + blocked flows use the same dark in-app modal as every other
  // confirmation in the app. Two separate flags so they can't overlap.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [blockReasonOpen, setBlockReasonOpen] = useState(false);

  function onDelete(): void {
    if (!task) return;
    setDeleteConfirmOpen(true);
  }

  function onToggleBlocked(): void {
    if (!task) return;
    if (task.isBlocked) {
      blockMutation.mutate({ blocked: false });
    } else {
      setBlockReasonOpen(true);
    }
  }

  // -------------------------------------------------------------------------
  // Mobile bottom-bar action handlers. Reassign / Status open lightweight
  // native selects (the rich pickers live in the Details tab); Comment jumps
  // to the Activity tab and focuses the composer.
  // -------------------------------------------------------------------------
  const commentComposerRef = useRef<HTMLDivElement | null>(null);
  function focusComment(): void {
    setMobileTab('activity');
    setActivityTab('comments');
    // Defer so the tab body has time to render the composer.
    window.setTimeout(() => {
      const el = commentComposerRef.current?.querySelector<HTMLTextAreaElement>(
        'textarea, [contenteditable="true"]',
      );
      el?.focus();
    }, 60);
  }
  function quickAssign(): void {
    if (!task) return;
    // Lightweight prompt — full picker available on Details tab.
    const names = users.map((u, i) => `${i + 1}. ${u.name || u.email}`).join('\n');
    const currentAssignee = users.find((u) => u.id === task.assigneeUserId);
    const choice = window.prompt(
      `Assign to (enter number, blank to unassign):\n${names}`,
      currentAssignee?.name ?? '',
    );
    if (choice === null) return;
    const n = Number(choice);
    if (Number.isFinite(n) && n >= 1 && n <= users.length) {
      updateMutation.mutate({ assigneeUserId: users[n - 1]!.id });
    } else if (choice.trim() === '') {
      updateMutation.mutate({ assigneeUserId: null });
    }
  }
  function quickStatus(): void {
    if (!task) return;
    const choice = window.prompt(
      `New status for ${task.key} (Todo / In Progress / In Review / Done):`,
      task.status,
    );
    if (choice && choice.trim()) statusMutation.mutate(choice.trim());
  }

  // ---------------------------------------------------------------------
  // Render — branches on isMobile. We keep both branches in one component
  // so all the query/mutation state (and the realtime subscription) is
  // shared between layouts.
  // ---------------------------------------------------------------------

  // Shared dialog block — rendered as a sibling in both mobile and desktop
  // branches so the modals overlay correctly regardless of which drawer
  // layout is active.
  const dialogs = (
    <>
      {deleteConfirmOpen && task && (
        <ConfirmDialog
          title={`Delete ${task.key}?`}
          body="This cannot be undone."
          destructive
          confirmLabel="Delete task"
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={() => {
            setDeleteConfirmOpen(false);
            deleteMutation.mutate();
          }}
        />
      )}
      {blockReasonOpen && task && (
        <PromptDialog
          title="Mark as blocked"
          body="What's blocking this task? You can leave it empty."
          placeholder="e.g. Waiting on design approval"
          required={false}
          submitLabel="Mark blocked"
          onCancel={() => setBlockReasonOpen(false)}
          onSubmit={(reason) => {
            setBlockReasonOpen(false);
            const trimmed = reason.trim();
            blockMutation.mutate({ blocked: true, ...(trimmed ? { reason: trimmed } : {}) });
          }}
        />
      )}
    </>
  );

  if (isMobile) {
    return createPortal(
      <>
      <div
        className="animate-overlay-in glass-scrim fixed inset-0 z-[70] flex items-end justify-center"
        data-state={closing ? 'closed' : 'open'}
        onClick={requestClose}
        role="presentation"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={task ? `Task ${task.key}: ${task.title}` : 'Task detail'}
          className="animate-drawer-in-bottom w-full h-[92vh] bg-card border-t border-border rounded-t-2xl shadow-2xl overflow-hidden flex flex-col will-change-transform"
          data-state={closing ? 'closed' : 'open'}
          onClick={(e) => e.stopPropagation()}
          style={
            dragOffsetY
              ? { transform: `translateY(${dragOffsetY}px)`, transition: 'none' }
              : undefined
          }
        >
          {/* Drag handle + header — pointer events here drive swipe-down. */}
          <div {...dragHandlers} className="touch-none">
            <div className="flex items-center justify-center pt-2 pb-1" aria-hidden="true">
              <span className="block h-1 w-10 rounded-full bg-muted-foreground/40" />
            </div>
            {taskQuery.isLoading || !task ? null : (
              <DrawerHeader
                task={task}
                onClose={requestClose}
                onDelete={onDelete}
                onToggleBlocked={onToggleBlocked}
                onToggleWatch={(w) => watchMutation.mutate(w)}
                onOpenTask={openTask}
                blockedPending={blockMutation.isPending}
                watchPending={watchMutation.isPending}
                deleting={deleteMutation.isPending}
              />
            )}
          </div>
          {/* Tab strip — sticky just under the header. */}
          {task && (
            <div
              role="tablist"
              aria-label="Task sections"
              className="flex border-b border-border bg-card/80 backdrop-blur-sm shrink-0"
            >
              {(
                [
                  ['details', 'Details'],
                  ['activity', 'Activity'],
                  ['subtasks', 'Subtasks'],
                  ['attachments', 'Files'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mobileTab === id}
                  onClick={() => setMobileTab(id)}
                  className={cn(
                    'tap flex-1 px-3 py-2.5 text-xs font-medium transition-colors border-b-2',
                    mobileTab === id
                      ? 'text-foreground border-primary'
                      : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/30',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {taskQuery.isLoading || !task ? (
            <div className="p-8 text-muted-foreground flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden="true"
              />
              <span>Loading task…</span>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {mobileTab === 'details' && (
                <div className="p-4 pb-24 space-y-5">
                  <TitleField
                    value={task.title}
                    onSave={(title) => updateMutation.mutate({ title })}
                  />
                  {task.isBlocked && task.blockedReason && (
                    <div className="rounded-md border border-status-blocked/30 bg-status-blocked/10 p-3 text-sm">
                      <div className="flex items-start gap-2">
                        <span className="text-status-blocked">⚑</span>
                        <div className="flex-1">
                          <div className="font-medium text-status-blocked text-xs uppercase tracking-wider mb-0.5">
                            Blocked
                          </div>
                          <div className="text-foreground/90">{task.blockedReason}</div>
                        </div>
                      </div>
                    </div>
                  )}
                  <MetaGrid
                    task={task}
                    users={users}
                    onStatusChange={(s) => statusMutation.mutate(s)}
                    onPatch={(p) => updateMutation.mutate(p)}
                  />
                  <DescriptionField
                    value={task.description ?? ''}
                    taskId={taskId}
                    onSave={(description) =>
                      updateMutation.mutate({ description: description || null })
                    }
                  />
                  <SimilarTasksSection taskId={taskId} />
                  <CustomFieldsSection taskId={taskId} projectId={task.projectId} />
                  <RecurrenceSection taskId={taskId} />
                </div>
              )}
              {mobileTab === 'activity' && (
                <div className="p-4 pb-24" ref={commentComposerRef}>
                  <div className="flex border-b border-border bg-card/80 mb-3">
                    <ActivityTab
                      active={activityTab === 'comments'}
                      onClick={() => setActivityTab('comments')}
                      label={`Comments${
                        commentsQuery.data?.length ? ` (${commentsQuery.data.length})` : ''
                      }`}
                    />
                    <ActivityTab
                      active={activityTab === 'activity'}
                      onClick={() => setActivityTab('activity')}
                      label="Activity"
                    />
                  </div>
                  {activityTab === 'comments' ? (
                    <CommentsThread
                      taskId={taskId}
                      projectId={task.projectId}
                      comments={commentsQuery.data ?? []}
                      loading={commentsQuery.isLoading}
                    />
                  ) : (
                    <ActivitySection taskId={taskId} projectId={task.projectId} />
                  )}
                </div>
              )}
              {mobileTab === 'subtasks' && (
                <div className="p-4 pb-24 space-y-5">
                  <SubtasksSection task={task} onOpenTask={openTask} />
                  <LinkedTasksSection task={task} onOpenTask={openTask} />
                </div>
              )}
              {mobileTab === 'attachments' && (
                <div className="p-4 pb-24">
                  <AttachmentsSection taskId={taskId} projectId={task.projectId} />
                </div>
              )}
            </div>
          )}

          {/* Sticky bottom action bar. Three primary actions a mobile user is
              most likely to want: reassign, change status, comment. The full
              field-level pickers still live in the Details tab. */}
          {task && (
            <div className="sticky bottom-0 inset-x-0 border-t border-border bg-card/95 backdrop-blur-sm flex items-center gap-2 px-3 py-2 shrink-0 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={quickAssign}
                className="tap flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 h-10 text-xs font-medium hover:bg-accent transition-colors"
              >
                <UserPlus className="h-4 w-4" />
                Reassign
              </button>
              <button
                type="button"
                onClick={quickStatus}
                className="tap flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 h-10 text-xs font-medium hover:bg-accent transition-colors"
              >
                <CheckCircle2 className="h-4 w-4" />
                Status
              </button>
              <button
                type="button"
                onClick={focusComment}
                className="tap flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 h-10 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity"
              >
                <MessageSquarePlus className="h-4 w-4" />
                Comment
              </button>
            </div>
          )}
        </div>
      </div>
      {dialogs}
      </>,
      document.body,
    );
  }

  // ---------------------------------------------------------------------
  // Desktop layout — two-pane centered modal. Preserves the existing UX
  // exactly so we don't regress muscle memory.
  // ---------------------------------------------------------------------
  return createPortal(
    <>
    <div
      className="animate-overlay-in glass-scrim fixed inset-0 z-[70] flex items-stretch sm:items-center justify-center sm:p-4 md:p-8"
      data-state={closing ? 'closed' : 'open'}
      onClick={requestClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={task ? `Task ${task.key}: ${task.title}` : 'Task detail'}
        className="animate-drawer-in-right w-full max-w-7xl bg-card border-0 sm:border border-border rounded-none sm:rounded-xl shadow-2xl overflow-hidden flex flex-col will-change-transform h-full sm:h-[min(92vh,1000px)]"
        data-state={closing ? 'closed' : 'open'}
        onClick={(e) => e.stopPropagation()}
      >
        {taskQuery.isLoading || !task ? (
          <div className="p-8 text-muted-foreground flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
            <span>Loading task…</span>
          </div>
        ) : (
          <>
            <DrawerHeader
              task={task}
              onClose={requestClose}
              onDelete={onDelete}
              onToggleBlocked={onToggleBlocked}
              onToggleWatch={(watching) => watchMutation.mutate(watching)}
              onOpenTask={openTask}
              blockedPending={blockMutation.isPending}
              watchPending={watchMutation.isPending}
              deleting={deleteMutation.isPending}
            />
              {/* Two-pane body: main details on the left, comments/activity on the right.
                  On narrow viewports the activity column drops below the main. */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_400px] divide-y lg:divide-y-0 lg:divide-x divide-border overflow-hidden">
              {/* Main pane — scrollable */}
              <div className="overflow-y-auto p-6 space-y-6">
                <TitleField
                  value={task.title}
                  onSave={(title) => updateMutation.mutate({ title })}
                />
                {task.isBlocked && task.blockedReason && (
                  <div className="rounded-md border border-status-blocked/30 bg-status-blocked/10 p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <span className="text-status-blocked">⚑</span>
                      <div className="flex-1">
                        <div className="font-medium text-status-blocked text-xs uppercase tracking-wider mb-0.5">
                          Blocked
                        </div>
                        <div className="text-foreground/90">{task.blockedReason}</div>
                      </div>
                    </div>
                  </div>
                )}
                <MetaGrid
                  task={task}
                  users={users}
                  onStatusChange={(s) => statusMutation.mutate(s)}
                  onPatch={(p) => updateMutation.mutate(p)}
                />
                <DescriptionField
                  value={task.description ?? ''}
                  taskId={taskId}
                  onSave={(description) =>
                    updateMutation.mutate({ description: description || null })
                  }
                />
                <SimilarTasksSection taskId={taskId} />
                <CustomFieldsSection taskId={taskId} projectId={task.projectId} />
                <SubtasksSection task={task} onOpenTask={openTask} />
                <LinkedTasksSection task={task} onOpenTask={openTask} />
                <AttachmentsSection taskId={taskId} projectId={task.projectId} />
                <RecurrenceSection taskId={taskId} />
              </div>

              {/* Activity pane — tabbed Comments | Activity, sticky tabs */}
              <aside className="flex flex-col min-h-0 bg-card/60">
                <div className="flex border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
                  <ActivityTab
                    active={activityTab === 'comments'}
                    onClick={() => setActivityTab('comments')}
                    label={`Comments${commentsQuery.data?.length ? ` (${commentsQuery.data.length})` : ''}`}
                  />
                  <ActivityTab
                    active={activityTab === 'activity'}
                    onClick={() => setActivityTab('activity')}
                    label="Activity"
                  />
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {activityTab === 'comments' ? (
                    <CommentsThread
                      taskId={taskId}
                      projectId={task.projectId}
                      comments={commentsQuery.data ?? []}
                      loading={commentsQuery.isLoading}
                    />
                  ) : (
                    <ActivitySection taskId={taskId} projectId={task.projectId} />
                  )}
                </div>
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
    {dialogs}
    </>,
    document.body,
  );
}
