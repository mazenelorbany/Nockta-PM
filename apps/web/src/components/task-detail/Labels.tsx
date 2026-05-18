import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import type { Label } from './types';
import { apiErrorMessage } from './utils';

export function LabelsPicker({ taskId, projectId }: { taskId: string; projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const attachedQuery = useQuery({
    queryKey: ['labels', 'task', taskId],
    queryFn: () => api.get<Label[]>(`/tasks/${taskId}/labels`),
  });
  const projectLabelsQuery = useQuery({
    queryKey: ['labels', 'project', projectId],
    queryFn: () => api.get<Label[]>(`/projects/${projectId}/labels`),
    enabled: pickerOpen,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['labels', 'task', taskId] });
    void queryClient.invalidateQueries({ queryKey: ['labels', 'project', projectId] });
  };

  const attach = useMutation({
    mutationFn: (labelId: string) => api.post(`/tasks/${taskId}/labels/${labelId}`),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not add label')),
  });
  const detach = useMutation({
    mutationFn: (labelId: string) => api.delete(`/tasks/${taskId}/labels/${labelId}`),
    onSuccess: invalidate,
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove label')),
  });
  const create = useMutation({
    mutationFn: (input: { name: string; color: string }) =>
      api.post<Label>(`/projects/${projectId}/labels`, input),
    onSuccess: async (label) => {
      invalidate();
      await attach.mutateAsync(label.id);
      setNewName('');
      setCreating(false);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create label')),
  });

  const attached = attachedQuery.data ?? [];
  const attachedIds = new Set(attached.map((l) => l.id));
  const available = (projectLabelsQuery.data ?? []).filter((l) => !attachedIds.has(l.id));

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {attached.map((l) => (
        <LabelChip key={l.id} label={l} onRemove={() => detach.mutate(l.id)} />
      ))}
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          className="tap inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-brand transition-colors"
        >
          + Label
        </button>
        {pickerOpen && (
          <div
            className="animate-popover-in absolute left-0 top-full mt-1 w-64 rounded-md border border-border bg-popover shadow-xl z-20 p-2"
            style={{ transformOrigin: 'top left' }}
            onMouseLeave={() => setPickerOpen(false)}
          >
            <div className="max-h-48 overflow-y-auto">
              {projectLabelsQuery.isLoading ? (
                <div className="text-xs text-muted-foreground p-2">Loading…</div>
              ) : available.length === 0 ? (
                <div className="text-xs text-muted-foreground p-2">No more labels.</div>
              ) : (
                available.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      attach.mutate(l.id);
                      setPickerOpen(false);
                    }}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: `#${l.color}` }}
                    />
                    <span className="text-xs">{l.name}</span>
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-border mt-1 pt-1">
              {creating ? (
                <div className="flex items-center gap-1 p-1">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newName.trim()) {
                        const colors = ['A78BFA', 'D5E64A', 'F75F4F', '7DD3C0', 'F8A5A0', '7AAEF3'];
                        const color = colors[Math.floor(Math.random() * colors.length)]!;
                        create.mutate({ name: newName.trim(), color });
                      }
                      if (e.key === 'Escape') {
                        setCreating(false);
                        setNewName('');
                      }
                    }}
                    placeholder="New label"
                    maxLength={40}
                    className="flex-1 bg-background border border-input rounded px-2 py-1 text-xs"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="w-full text-left px-2 py-1.5 rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  + Create new label
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function LabelChip({ label, onRemove }: { label: Label; onRemove: () => void }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium group"
      style={{
        backgroundColor: `#${label.color}25`,
        color: `#${label.color}`,
        border: `1px solid #${label.color}40`,
      }}
    >
      {label.name}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label.name}`}
        className="opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/20 rounded-full w-3 h-3 flex items-center justify-center text-[10px] leading-none"
      >
        ✕
      </button>
    </span>
  );
}
