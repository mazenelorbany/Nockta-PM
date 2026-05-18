import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';

// ============================================================================
// TemplatesQuickCreate — header dropdown for quick-creating from a template.
// ============================================================================

interface TaskTemplate {
  id: string;
  name: string;
  description: string | null;
  titleTemplate: string;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
}

export function TemplatesQuickCreate({ projectId }: { projectId: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const templatesQuery = useQuery({
    queryKey: ['task-templates', projectId],
    queryFn: () => api.get<TaskTemplate[]>(`/projects/${projectId}/task-templates`),
  });
  const instantiate = useMutation({
    mutationFn: (id: string) => api.post(`/task-templates/${id}/instantiate`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      toast.success('Task created from template');
      setOpen(false);
    },
    onError: () => toast.error('Could not create from template'),
  });
  const templates = templatesQuery.data ?? [];
  if (templates.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="tap inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <FileText className="h-3.5 w-3.5" />
        Templates
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-transparent"
          />
          <div
            className="animate-popover-in absolute right-0 top-full z-40 mt-1 w-64 rounded-lg border border-border bg-popover shadow-xl"
            style={{ transformOrigin: 'top right' }}
          >
            <header className="border-b border-border px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Task templates
            </header>
            <ul className="max-h-72 overflow-y-auto stagger-list">
              {templates.map((t) => (
                <li key={t.id} className="stagger-item">
                  <button
                    type="button"
                    onClick={() => instantiate.mutate(t.id)}
                    className="tap w-full px-3 py-2 text-left text-sm hover:bg-muted/60 transition-colors"
                  >
                    <div className="font-medium">{t.name}</div>
                    {t.description && <div className="text-[11px] text-muted-foreground line-clamp-1">{t.description}</div>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
