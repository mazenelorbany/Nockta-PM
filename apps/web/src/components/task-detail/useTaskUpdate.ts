import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';
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

export function useTaskUpdate({
  taskId,
  task,
}: {
  taskId: string;
  task: TaskDetail | undefined;
}): UseMutationResult<TaskDetail, unknown, TaskPatch, unknown> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: TaskPatch) => api.patch<TaskDetail>(`/tasks/${taskId}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(task?.projectId) });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Update failed')),
  });
}
