import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileText } from 'lucide-react';

import { api } from '../../lib/api';

import { Section } from './shared';
import { apiErrorMessage } from './utils';
import type { TaskTemplate } from './types';

// =============================================================================
// TaskTemplatesAdmin — list, edit, delete task templates for the project. New
// templates are created via "Save as template" on any task; this panel exists
// to manage them after the fact (rename, tweak default fields, prune).
// =============================================================================

export function TemplatesSection({ projectId }: { projectId: string }): JSX.Element {
  return (
    <Section
      id="templates"
      icon={<FileText className="h-4 w-4" />}
      title="Task templates"
      hint="Reusable task blueprints. Create one via 'Save as template' in any task drawer."
    >
      <TaskTemplatesAdmin projectId={projectId} />
    </Section>
  );
}

function TaskTemplatesAdmin({ projectId }: { projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const templatesQuery = useQuery({
    queryKey: ['task-templates', projectId],
    queryFn: () => api.get<TaskTemplate[]>(`/projects/${projectId}/task-templates`),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<TaskTemplate> }) =>
      api.patch(`/task-templates/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-templates', projectId] });
      toast.success('Template saved');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Save failed')),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/task-templates/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task-templates', projectId] });
      toast.success('Template deleted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Delete failed')),
  });
  const templates = templatesQuery.data ?? [];

  // Outer page renders the Section frame — keep this component content-only.
  return (
    <div>
      {templates.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No templates yet. Open any task and click "Save as template" in the drawer header to create one.
        </p>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => (
            <TaskTemplateRow
              key={t.id}
              template={t}
              onRename={(name) => updateMutation.mutate({ id: t.id, body: { name } })}
              onUpdate={(body) => updateMutation.mutate({ id: t.id, body })}
              onDelete={() => {
                if (window.confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskTemplateRow({
  template,
  onRename,
  onUpdate,
  onDelete,
}: {
  template: TaskTemplate;
  onRename: (name: string) => void;
  onUpdate: (body: Partial<TaskTemplate>) => void;
  onDelete: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-1 text-left text-sm font-medium hover:text-primary transition-colors"
        >
          {template.name}
        </button>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono uppercase text-muted-foreground">
          {template.priority}
        </span>
        {template.estimate !== null && (
          <span className="text-[10px] text-muted-foreground">{template.estimate} pts</span>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-muted-foreground hover:text-destructive"
        >
          Delete
        </button>
      </div>
      {open && (
        <div className="border-t border-border p-3 space-y-2 text-xs">
          <label className="block">
            <span className="text-muted-foreground">Name</span>
            <input
              type="text"
              defaultValue={template.name}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== template.name) {
                  onRename(e.target.value.trim());
                }
              }}
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-muted-foreground">Title template</span>
            <input
              type="text"
              defaultValue={template.titleTemplate}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== template.titleTemplate) {
                  onUpdate({ titleTemplate: e.target.value.trim() });
                }
              }}
              className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-muted-foreground">Body template</span>
            <textarea
              defaultValue={template.bodyTemplate ?? ''}
              rows={3}
              onBlur={(e) => {
                if (e.target.value !== (template.bodyTemplate ?? '')) {
                  onUpdate({ bodyTemplate: e.target.value || null });
                }
              }}
              className="mt-1 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-muted-foreground">Default priority</span>
              <select
                value={template.priority}
                onChange={(e) => onUpdate({ priority: e.target.value as TaskTemplate['priority'] })}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
              >
                {(['Low', 'Medium', 'High', 'Critical'] as const).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-muted-foreground">Estimate (pts)</span>
              <input
                type="number"
                defaultValue={template.estimate ?? ''}
                onBlur={(e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  if (v !== template.estimate) onUpdate({ estimate: v });
                }}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
