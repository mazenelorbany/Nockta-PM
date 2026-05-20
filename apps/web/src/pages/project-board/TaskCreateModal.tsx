import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';

import { TypeBadge, type TaskType } from '../../components/task-bits';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

import type { Priority, Project, Task, User } from './types';

// =============================================================================
// Create task dialog
// =============================================================================

interface CreateTaskInput {
  projectId: string;
  type: TaskType;
  title: string;
  description?: string;
  priority: Priority;
  assigneeUserId?: string;
  dueDate?: string;
  estimate?: number;
}

interface UserListResponse {
  items: User[];
  nextCursor: string | null;
}

// =============================================================================
// GalleryTemplate — workspace-wide template surfaced in the New Task drawer.
// Carries enough context (source project + tags + type) for the cards to
// render without an extra round-trip.
// =============================================================================
interface GalleryTemplate {
  id: string;
  name: string;
  description: string | null;
  titleTemplate: string;
  bodyTemplate: string | null;
  priority: Priority;
  estimate: number | null;
  taskType: TaskType | null;
  tags: string[];
  project: { id: string; key: string; name: string };
}

export function CreateTaskDialog({
  project,
  defaultStatus,
  onClose,
}: {
  project: Project;
  defaultStatus: string | null;
  onClose: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<TaskType>('Task');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('Medium');
  const [assigneeUserId, setAssigneeUserId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [estimate, setEstimate] = useState('');
  /// Two-pane drawer: gallery on the left, form on the right. The gallery
  /// stays mounted so toggling a filter doesn't refetch — react-query
  /// caches the underlying list. Hidden on mobile (xl: prefix) where the
  /// drawer's already narrow.
  const [galleryOpen, setGalleryOpen] = useState(true);
  const [galleryType, setGalleryType] = useState<'' | TaskType>('');
  const [galleryTag, setGalleryTag] = useState('');
  const [gallerySearch, setGallerySearch] = useState('');

  const usersQuery = useQuery({
    queryKey: queryKeys.usersList(),
    queryFn: () => api.get<UserListResponse>('/users?limit=100'),
  });

  const galleryQuery = useQuery({
    queryKey: ['task-templates', 'gallery', galleryType, galleryTag, gallerySearch],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (galleryType) qs.set('type', galleryType);
      if (galleryTag) qs.set('tag', galleryTag);
      if (gallerySearch) qs.set('q', gallerySearch);
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return api.get<GalleryTemplate[]>(`/task-templates/gallery${suffix}`);
    },
    // Keep stale data while filtering so the list doesn't visibly clear on
    // each keystroke — feels jumpy otherwise.
    placeholderData: (prev) => prev,
  });
  const tagsQuery = useQuery({
    queryKey: ['task-templates', 'tags'],
    queryFn: () => api.get<string[]>('/task-templates/tags'),
  });
  const templates = galleryQuery.data ?? [];
  const availableTags = tagsQuery.data ?? [];

  /// Pre-fill the form from a template. The form fields drive the eventual
  /// POST /tasks call exactly as if the user typed everything; we don't
  /// auto-instantiate so the user can still edit before committing.
  function applyTemplate(t: GalleryTemplate): void {
    setTitle(t.titleTemplate);
    setDescription(t.bodyTemplate ?? '');
    setPriority(t.priority);
    if (t.taskType) setType(t.taskType);
    if (t.estimate !== null) setEstimate(String(t.estimate));
    // Surface a toast so it's obvious which template populated the form —
    // otherwise the user can't tell whether they're editing from a template
    // or starting fresh.
    toast.success(`Loaded "${t.name}" from ${t.project.key}`);
  }

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: async (input: CreateTaskInput) => {
      const created = await api.post<Task & { status: string }>('/tasks', input);
      // If the user clicked "+ Add task" inside a column, move the task straight
      // to that column instead of leaving it in Todo.
      if (defaultStatus && defaultStatus !== created.status) {
        await api.patch(`/tasks/${created.id}/status`, { status: defaultStatus });
      }
      return created;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(project.id) });
      toast.success('Task created');
      onClose();
    },
    onError: (err) => {
      const detail =
        err instanceof ApiError
          ? err.problem.title || err.problem.detail || err.message
          : 'Failed to create task';
      toast.error(detail);
    },
  });

  const valid = title.trim().length > 0 && title.length <= 300;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!valid) return;
    const input: CreateTaskInput = {
      projectId: project.id,
      type,
      title: title.trim(),
      priority,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(assigneeUserId ? { assigneeUserId } : {}),
      ...(dueDate ? { dueDate: new Date(dueDate).toISOString() } : {}),
      ...(estimate ? { estimate: Number(estimate) } : {}),
    };
    await mutation.mutateAsync(input);
  }

  return (
    <div
      className="animate-overlay-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          'animate-dialog-in w-full rounded-lg border border-border bg-card shadow-xl flex flex-col xl:flex-row max-h-[90vh] overflow-hidden',
          galleryOpen ? 'max-w-5xl' : 'max-w-xl',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {galleryOpen && (
          <TemplateGalleryPane
            templates={templates}
            tags={availableTags}
            loading={galleryQuery.isLoading}
            galleryType={galleryType}
            galleryTag={galleryTag}
            gallerySearch={gallerySearch}
            onTypeChange={setGalleryType}
            onTagChange={setGalleryTag}
            onSearchChange={setGallerySearch}
            onApply={applyTemplate}
            onClose={() => setGalleryOpen(false)}
          />
        )}
        <form onSubmit={submit} className="flex-1 flex flex-col min-w-0">
          <div className="px-6 py-5 border-b border-border flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">New task</h2>
            <div className="flex items-center gap-3">
              {!galleryOpen && (
                <button
                  type="button"
                  onClick={() => setGalleryOpen(true)}
                  className="tap inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <FileText className="h-3 w-3" />
                  Templates
                </button>
              )}
              <span className="text-xs text-muted-foreground font-mono">
                {project.key} · {defaultStatus ?? 'Todo'}
              </span>
            </div>
          </div>
          <div className="px-6 py-5 space-y-4 flex-1 overflow-y-auto">
            <TaskField label="Type" htmlFor="task-type" hint="Subtasks need a parent — create one from a task drawer instead.">
              <div className="flex flex-wrap gap-1.5">
                {(['Epic', 'Story', 'Task', 'Bug'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      'tap inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                      type === t
                        ? 'border-brand/50 bg-accent text-foreground'
                        : 'border-border bg-background/40 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <TypeBadge type={t} />
                    {t}
                  </button>
                ))}
              </div>
            </TaskField>
            <TaskField label="Title" htmlFor="task-title">
              <input
                id="task-title"
                type="text"
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to happen?"
                maxLength={300}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </TaskField>
            <TaskField label="Description" htmlFor="task-description" hint="Optional. Markdown supported.">
              <textarea
                id="task-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={20_000}
                placeholder="Context, acceptance criteria, screenshots…"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              />
            </TaskField>
            <div className="grid grid-cols-2 gap-4">
              <TaskField label="Priority" htmlFor="task-priority">
                <select
                  id="task-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                  <option value="Critical">Critical</option>
                </select>
              </TaskField>
              <TaskField label="Assignee" htmlFor="task-assignee">
                <select
                  id="task-assignee"
                  value={assigneeUserId}
                  onChange={(e) => setAssigneeUserId(e.target.value)}
                  disabled={usersQuery.isLoading}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Unassigned</option>
                  {(usersQuery.data?.items ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email}
                    </option>
                  ))}
                </select>
              </TaskField>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <TaskField label="Due date" htmlFor="task-due" hint="Optional.">
                <input
                  id="task-due"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </TaskField>
              <TaskField label="Estimate" htmlFor="task-estimate" hint="Optional. Unit-agnostic.">
                <input
                  id="task-estimate"
                  type="number"
                  min={0}
                  step={1}
                  value={estimate}
                  onChange={(e) => setEstimate(e.target.value)}
                  placeholder="e.g. 3"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
              </TaskField>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-border flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="tap rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || mutation.isPending}
              className="tap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-[opacity,transform] duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mutation.isPending ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Cross-project template gallery shown to the left of the New Task form.
 * Filterable by issue type (Epic/Story/Task/Bug), tag, and free-text search.
 * Clicking a card pre-fills the form without committing — the user still has
 * to click "Create" so they can still tweak the title / assignee.
 */
function TemplateGalleryPane({
  templates,
  tags,
  loading,
  galleryType,
  galleryTag,
  gallerySearch,
  onTypeChange,
  onTagChange,
  onSearchChange,
  onApply,
  onClose,
}: {
  templates: GalleryTemplate[];
  tags: string[];
  loading: boolean;
  galleryType: '' | TaskType;
  galleryTag: string;
  gallerySearch: string;
  onTypeChange: (v: '' | TaskType) => void;
  onTagChange: (v: string) => void;
  onSearchChange: (v: string) => void;
  onApply: (t: GalleryTemplate) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside className="w-full xl:w-80 shrink-0 border-b xl:border-b-0 xl:border-r border-border bg-background/40 flex flex-col">
      <header className="px-4 py-3 border-b border-border flex items-baseline justify-between gap-2">
        <div>
          <p className="nockta-eyebrow text-muted-foreground">Templates</p>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            Across every project you can see
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Hide template gallery"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="px-4 py-3 space-y-2 border-b border-border">
        <input
          type="search"
          value={gallerySearch}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search templates…"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        />
        <div className="flex gap-2">
          <select
            value={galleryType}
            onChange={(e) => onTypeChange(e.target.value as '' | TaskType)}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label="Filter templates by type"
          >
            <option value="">All types</option>
            <option value="Epic">Epic</option>
            <option value="Story">Story</option>
            <option value="Task">Task</option>
            <option value="Bug">Bug</option>
          </select>
          <select
            value={galleryTag}
            onChange={(e) => onTagChange(e.target.value)}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label="Filter templates by tag"
          >
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        {(galleryType || galleryTag || gallerySearch) && (
          <button
            type="button"
            onClick={() => {
              onTypeChange('');
              onTagChange('');
              onSearchChange('');
            }}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" /> Clear filters
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 max-h-[40vh] xl:max-h-none">
        {loading && templates.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-8">Loading…</p>
        )}
        {!loading && templates.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-8">
            No templates match these filters.
          </p>
        )}
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onApply(t)}
            className="tap w-full text-left rounded-md border border-border/60 bg-card/60 px-3 py-2 hover:border-primary/40 hover:bg-accent/40 transition-colors"
          >
            <div className="flex items-center gap-2 mb-0.5">
              {t.taskType && <TypeBadge type={t.taskType} />}
              <span className="font-medium text-xs truncate flex-1">{t.name}</span>
              <span
                title={`${t.project.name} (${t.project.key})`}
                className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded shrink-0"
              >
                {t.project.key}
              </span>
            </div>
            {t.description && (
              <p className="text-[11px] text-muted-foreground line-clamp-2">{t.description}</p>
            )}
            {t.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {t.tags.slice(0, 4).map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-secondary/60 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
    </aside>
  );
}

function TaskField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground mb-1">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}
