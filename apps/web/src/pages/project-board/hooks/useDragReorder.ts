import type { DragEndEvent } from '@dnd-kit/core';
import type { QueryClient } from '@tanstack/react-query';
import { generateKeyBetween } from 'fractional-indexing';
import { useCallback } from 'react';
import toast from 'react-hot-toast';
import { ApiError } from '@nockta/sdk';
import { api } from '../../../lib/api';
import type { Task } from '../types';

/**
 * Board drop handler — handles three cases in a unified flow:
 *
 *   1. Same-column reorder. Drop on another card in the same column →
 *      compute the (before, after) neighbour pair and PATCH /reorder.
 *
 *   2. Cross-column drop on a specific card. Drop on a card in a different
 *      column → set status (which the backend lands at the bottom of the
 *      new column), then PATCH /reorder to slide it next to the target.
 *
 *   3. Cross-column drop on the column body (id="col:<status>"). Same as
 *      (2) but no specific target — the card lands at the bottom and we
 *      skip the reorder call.
 *
 * The optimistic cache update reflects the final state for the visible
 * column rendering. Position is tracked via the existing `boardPosition`
 * fractional-index field; computing a local key with fractional-indexing
 * here keeps the optimistic order stable for the brief window before the
 * server response invalidates the cache.
 */
export function useDragReorder({
  tasks,
  projectId,
  queryClient,
}: {
  tasks: Task[];
  projectId: string | undefined;
  queryClient: QueryClient;
}): (event: DragEndEvent) => Promise<void> {
  return useCallback(
    async function onDragEnd(event: DragEndEvent): Promise<void> {
      const { active, over } = event;
      if (!over) return;

      const overId = String(over.id);
      const activeId = String(active.id);
      if (overId === activeId) return;

      const task = tasks.find((t) => t.id === activeId);
      if (!task) return;

      // Resolve destination status + target card (if any).
      let destStatus = task.status;
      let targetCard: Task | undefined;
      if (overId.startsWith('col:')) {
        destStatus = overId.slice(4);
      } else {
        targetCard = tasks.find((t) => t.id === overId);
        if (targetCard) destStatus = targetCard.status;
      }

      // Same column, same position → no-op.
      if (destStatus === task.status && !targetCard) return;
      if (destStatus === task.status && targetCard?.id === task.id) return;

      // -------- compute (before, after) neighbours in the destination column --
      //
      // We sort the destination column by boardPosition, find where the dragged
      // card should land relative to the target, and snapshot the neighbour
      // ids. `before` is the card whose boardPosition is < the new pos;
      // `after` is the one whose boardPosition is > the new pos. Either or
      // both may be null (end / start / empty column).
      const destList = tasks
        .filter((t) => t.status === destStatus && t.id !== activeId)
        .sort((a, b) => (a.boardPosition < b.boardPosition ? -1 : 1));

      let beforeId: string | null = null;
      let afterId: string | null = null;
      if (!targetCard) {
        // Drop on column body → append to bottom.
        beforeId = destList[destList.length - 1]?.id ?? null;
        afterId = null;
      } else {
        const targetIdx = destList.findIndex((t) => t.id === targetCard!.id);
        // Insert ABOVE the target (typical dnd-kit semantics on a vertical
        // sortable list).
        beforeId = destList[targetIdx - 1]?.id ?? null;
        afterId = destList[targetIdx]?.id ?? null;
      }

      // -------- optimistic local position + status update -------------------
      const beforePos = beforeId ? destList.find((t) => t.id === beforeId)?.boardPosition ?? null : null;
      const afterPos = afterId ? destList.find((t) => t.id === afterId)?.boardPosition ?? null : null;
      let newPos = task.boardPosition;
      try {
        newPos = generateKeyBetween(beforePos, afterPos);
      } catch {
        // generateKeyBetween throws if before >= after — should never happen
        // with a correctly-sorted list, but fall back to existing pos rather
        // than crash the drop.
      }

      const previousStatus = task.status;
      const previousPos = task.boardPosition;
      const queryKey = ['tasks', 'project', projectId] as const;
      // Optimistic update — mutate the dragged card AND re-sort so it lands in
      // its new slot immediately. Without the sort the card stays visually in
      // its old position until the refetch round-trip completes, which makes
      // the drop feel broken ("the order didn't change").
      //
      // Match the API's orderBy: status asc, then boardPosition asc.
      queryClient.setQueryData<Task[]>(queryKey, (old) => {
        if (!old) return old;
        return old
          .map((t) =>
            t.id === task.id ? { ...t, status: destStatus, boardPosition: newPos } : t,
          )
          .sort((a, b) => {
            if (a.status !== b.status) return a.status < b.status ? -1 : 1;
            return a.boardPosition < b.boardPosition ? -1 : 1;
          });
      });

      // Build the reorder payload. The backend's /reorder endpoint accepts
      // boardPosition fractional-index keys (NOT task IDs) — it feeds them
      // directly into generateKeyBetween() server-side. We resolved both ends
      // above. Send strings only; omit either side if it's a column edge so
      // the @IsOptional() DTO sees `undefined` rather than `null`.
      const reorderBody: { before?: string; after?: string } = {};
      if (beforePos !== null) reorderBody.before = beforePos;
      if (afterPos !== null) reorderBody.after = afterPos;

      try {
        // Same column → reorder only.
        if (destStatus === previousStatus) {
          await api.patch(`/tasks/${task.id}/reorder`, reorderBody);
        } else {
          // Cross column → status first (backend appends to bottom), then
          // reorder if the user dropped on a specific target (i.e. not the
          // very bottom of the column).
          await api.patch(`/tasks/${task.id}/status`, { status: destStatus });
          if (afterPos !== null) {
            await api.patch(`/tasks/${task.id}/reorder`, reorderBody);
          }
        }
        void queryClient.invalidateQueries({ queryKey });
      } catch (err) {
        // Roll back the optimistic update (restore prior status + position +
        // re-sort).
        queryClient.setQueryData<Task[]>(queryKey, (old) => {
          if (!old) return old;
          return old
            .map((t) =>
              t.id === task.id
                ? { ...t, status: previousStatus, boardPosition: previousPos }
                : t,
            )
            .sort((a, b) => {
              if (a.status !== b.status) return a.status < b.status ? -1 : 1;
              return a.boardPosition < b.boardPosition ? -1 : 1;
            });
        });
        const detail =
          err instanceof ApiError ? err.problem.title || err.message : 'Could not move task';
        toast.error(detail);
      }
    },
    [tasks, projectId, queryClient],
  );
}
