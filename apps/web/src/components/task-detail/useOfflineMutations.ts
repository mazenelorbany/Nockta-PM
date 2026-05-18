import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';
import { enqueue as enqueueOffline } from '../../lib/offline-mutation-queue';
import { API_PREFIX, API_URL } from '../../lib/env';
import { queryKeys } from '../../lib/query-keys';
import { type Priority } from '../task-bits';

import type { TaskDetail } from './types';
import { apiErrorMessage } from './utils';

type TaskPatch = Partial<{
  title: string;
  description: string | null;
  priority: Priority;
  assigneeUserId: string | null;
  dueDate: string | null;
  estimate: number | null;
  sprintId: string | null;
}>;

/**
 * Offline-aware task update mutation. When the browser is online, performs a
 * normal PATCH /tasks/:id. When offline, stashes the mutation in IndexedDB
 * via the offline-mutation-queue so the drainer can replay it on reconnect.
 *
 * The drawer is rendered read-only when offline (pointer-events stripped on
 * inputs/buttons), but edits that slip through via keyboard shortcuts get
 * routed here instead of failing at the network layer. The hook returns the
 * full TanStack mutation object so the caller's `.mutate(...)` / `.isPending`
 * usage works without changes.
 */
export function useOfflineTaskUpdate({
  taskId,
  task,
  isOnline,
}: {
  taskId: string;
  task: TaskDetail | undefined;
  isOnline: boolean;
}): UseMutationResult<TaskDetail, unknown, TaskPatch, unknown> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: TaskPatch) => {
      if (!isOnline) {
        // Stash the mutation in IDB so the drainer replays it when we
        // come back online. The drawer is rendered read-only in this state
        // but inline edits that slip through (e.g. via keyboard shortcuts)
        // get queued instead of failing.
        await enqueueOffline({
          method: 'PATCH',
          url: `${API_URL}${API_PREFIX}/tasks/${taskId}`,
          body: patch,
          meta: { taskId, label: 'task.update' },
        });
        toast.success('Saved offline — will sync when you reconnect');
        return task as TaskDetail;
      }
      return api.patch<TaskDetail>(`/tasks/${taskId}`, patch);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(task?.projectId) });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Update failed')),
  });
}
