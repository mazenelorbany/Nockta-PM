import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowUpRight, FolderPlus, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn, QueryErrorState } from '@nockta/ui';
import { api } from '../lib/api';

interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
  archivedAt: string | null;
}

type Visibility = 'public' | 'teams' | 'private';
type Preset = Project['workflowPreset'];

interface CreateProjectInput {
  key: string;
  name: string;
  description?: string;
  visibility: Visibility;
  workflowPreset: Preset;
  sprintsEnabled?: boolean;
}

/** Auto-derive a 2-10 char uppercase key from the project name. */
function suggestKey(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  let candidate = '';
  if (words.length >= 2) {
    candidate = words.map((w) => w[0] ?? '').join('');
  } else if (words[0]) {
    candidate = words[0];
  }
  return candidate.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 10);
}

export function ProjectsListPage(): JSX.Element {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/projects'),
  });
  const { data, isLoading, isError } = projectsQuery;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const projects = (data ?? []).filter((p) => !p.archivedAt);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q),
    );
  }, [projects, filter]);

  return (
    <div className="pb-12">
      {/* Cinematic header — gradient mesh band, oversized N watermark, brand voice */}
      <header className="relative overflow-hidden border-b border-border gradient-mesh-subtle">
        {/* Brand cube — "scale" (stacked cubes) sits bottom-right of the
            workspace projects list. Many projects = scale. */}
        <img
          src="/scale.png"
          alt=""
          aria-hidden="true"
          className="absolute -right-8 -bottom-12 h-[300px] w-[300px] object-contain pointer-events-none select-none opacity-65"
        />
        <div className="relative px-8 pt-10 pb-10 flex items-end justify-between gap-6 flex-wrap">
          <div>
            <span className="nockta-eyebrow text-brand">
              {'Workspace'}
            </span>
            <h1
              className="display-heading mt-2 leading-[1.04]"
              style={{ fontSize: 'clamp(2rem, 4vw, 3.2rem)' }}
            >
              {'Projects'}
            </h1>
            <p className="mt-3 text-sm text-muted-foreground max-w-xl">
              {'Every project gets a board, sprints, docs, and an audit trail. Pick one to dive in or spin up a new one.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={'Filter projects'}
                className="field text-sm py-2 ps-9 pe-3 w-64"
              />
            </div>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="tap inline-flex items-center gap-2 rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              <FolderPlus className="h-4 w-4" />
              {'New project'}
            </button>
          </div>
        </div>
      </header>

      <div className="px-8 pt-8">
        {isLoading ? (
          <ProjectsSkeleton />
        ) : isError ? (
          <QueryErrorState
            title="Couldn't load projects"
            error={projectsQuery.error}
            onRetry={() => void projectsQuery.refetch()}
          />
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setOpen(true)} />
        ) : filtered.length === 0 ? (
          <NoMatches query={filter} onClear={() => setFilter('')} />
        ) : (
          <ProjectBento projects={filtered} />
        )}
      </div>

      {open && <CreateProjectDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Bento — first project gets a 2x2 hero tile, rest are 1x1 (alternating with
 * an occasional 2x1 feature tile every 5th card so the grid stays interlocked
 * even with mismatched counts. grid-flow-dense fills the gaps. */
function ProjectBento({ projects }: { projects: Project[] }): JSX.Element {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 auto-rows-[180px] md:auto-rows-[200px] gap-3 md:gap-4 grid-flow-dense">
      {projects.map((p, i) => {
        const isHero = i === 0 && projects.length > 2;
        const isFeatured = !isHero && (i % 5 === 0 || i % 7 === 0);
        const span = isHero
          ? 'md:col-span-2 md:row-span-2'
          : isFeatured
            ? 'md:col-span-2'
            : '';
        return <ProjectTile key={p.id} project={p} span={span} prominent={isHero} index={i} />;
      })}
    </div>
  );
}

function ProjectTile({
  project,
  span,
  prominent,
  index,
}: {
  project: Project;
  span: string;
  prominent: boolean;
  index: number;
}): JSX.Element {
  const accent =
    project.workflowPreset === 'engineering'
      ? 'bg-brand/15 text-brand'
      : project.workflowPreset === 'design'
        ? 'bg-status-in-review/15 text-status-in-review'
        : 'bg-muted text-muted-foreground';

  return (
    <Link
      to={`/projects/${project.id}/board`}
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
      className={cn(
        'stagger-item magnetic relative overflow-hidden rounded-xl border border-border bg-card group transition-colors hover:border-ring',
        span,
      )}
    >
      {/* Image bed — keyed by project.key so each project keeps a stable visual */}
      <div
        className="absolute inset-0 bg-cover bg-center transition-transform duration-[1100ms] ease-out group-hover:scale-[1.04]"
        style={{
          backgroundImage: `url('https://picsum.photos/seed/nockta-${project.key.toLowerCase()}/1280/720')`,
          filter: 'grayscale(0.6) contrast(1.1) brightness(0.5)',
        }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-card via-card/80 to-card/30 group-hover:from-card group-hover:via-card/60 transition-all duration-500" />

      <div className="relative h-full p-5 md:p-6 flex flex-col justify-between">
        <div className="flex items-start justify-between">
          <span className="nockta-eyebrow text-muted-foreground font-mono">{project.key}</span>
          <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-brand transition-colors" />
        </div>
        <div>
          <div
            className="display-heading text-foreground leading-tight"
            style={{
              fontSize: prominent
                ? 'clamp(1.6rem, 3vw, 2.4rem)'
                : 'clamp(1.05rem, 1.6vw, 1.25rem)',
            }}
          >
            {project.name}
          </div>
          {prominent && project.description && (
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed max-w-md line-clamp-2">
              {project.description}
            </p>
          )}
          <div className="mt-3 flex items-center gap-1.5">
            <span
              className={cn(
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold',
                accent,
              )}
            >
              {project.workflowPreset}
            </span>
            {project.sprintsEnabled && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-secondary text-muted-foreground">
                Sprints
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function ProjectsSkeleton(): JSX.Element {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 auto-rows-[200px] gap-4 grid-flow-dense">
      <div className="md:col-span-2 md:row-span-2 rounded-xl border border-border bg-card animate-pulse" />
      <div className="md:col-span-2 rounded-xl border border-border bg-card animate-pulse" />
      <div className="rounded-xl border border-border bg-card animate-pulse" />
      <div className="rounded-xl border border-border bg-card animate-pulse" />
    </div>
  );
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/30 p-12 text-center">
      <div className="text-sm text-foreground">No projects match "{query}"</div>
      <button
        type="button"
        onClick={onClear}
        className="tap mt-3 text-xs text-brand hover:underline"
      >
        Clear filter
      </button>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-12 md:p-16">
      <div
        className="absolute inset-0 bg-cover bg-center opacity-25 mix-blend-luminosity pointer-events-none"
        style={{
          backgroundImage: "url('https://picsum.photos/seed/nockta-empty-projects/1600/700')",
        }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-card via-card/85 to-card/40 pointer-events-none" />
      <div className="relative max-w-md">
        <span className="nockta-eyebrow text-brand">Your workspace is quiet</span>
        <h3
          className="display-heading mt-3 leading-tight"
          style={{ fontSize: 'clamp(1.6rem, 2.8vw, 2.2rem)' }}
        >
          Spin up your first project.
        </h3>
        <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
          A project bundles a board, sprints, docs, automations, and an audit trail.
          Three presets cover most teams: Engineering, Design, or Generic.
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="tap mt-6 inline-flex items-center gap-2 rounded-md bg-foreground text-background px-5 py-2.5 text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <FolderPlus className="h-4 w-4" />
          Create your first project
        </button>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Create dialog — same logic as before, glass treatment + .field inputs.
 * -------------------------------------------------------------------------- */

function CreateProjectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [workflowPreset, setWorkflowPreset] = useState<Preset>('engineering');
  const [sprintsEnabled, setSprintsEnabled] = useState(false);

  useEffect(() => {
    if (!keyEdited) setKey(suggestKey(name));
  }, [name, keyEdited]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (input: CreateProjectInput) => api.post<Project>('/projects', input),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`Created ${project.key}`);
      onClose();
      navigate(`/projects/${project.id}/board`);
    },
    onError: (err) => {
      const detail =
        err instanceof ApiError ? err.problem.title || err.problem.detail || err.message : 'Failed to create project';
      toast.error(detail);
    },
  });

  const valid =
    name.trim().length > 0 &&
    /^[A-Z]{2,10}$/.test(key) &&
    description.length <= 2000;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!valid) return;
    const input: CreateProjectInput = {
      name: name.trim(),
      key,
      visibility,
      workflowPreset,
      sprintsEnabled,
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    await mutation.mutateAsync(input);
  }

  return (
    <div
      className="animate-overlay-in glass-scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="animate-dialog-in glass-strong w-full max-w-lg rounded-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit}>
          <div className="px-6 py-5 border-b border-border/60">
            <h2 className="text-lg font-semibold tracking-tight">New project</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Pick a workflow preset — you can't change it later.
            </p>
          </div>
          <div className="px-6 py-5 space-y-4">
            <Field label="Name" htmlFor="name">
              <input
                id="name"
                type="text"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mobile App"
                maxLength={120}
                className="field text-sm"
              />
            </Field>
            <Field
              label="Key"
              htmlFor="key"
              hint="2–10 uppercase letters. Used in task IDs (e.g. MOB-142). Immutable."
            >
              <input
                id="key"
                type="text"
                required
                value={key}
                onChange={(e) => {
                  setKeyEdited(true);
                  setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10));
                }}
                placeholder="MOB"
                className="field text-sm font-mono"
              />
              {key && !/^[A-Z]{2,10}$/.test(key) && (
                <div className="text-xs text-destructive mt-1">Key must be 2–10 uppercase letters.</div>
              )}
            </Field>
            <Field label="Description" htmlFor="description" hint="Optional. Up to 2000 characters.">
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={2000}
                className="field text-sm resize-none"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Workflow" htmlFor="workflow">
                <select
                  id="workflow"
                  value={workflowPreset}
                  onChange={(e) => setWorkflowPreset(e.target.value as Preset)}
                  className="field text-sm"
                >
                  <option value="engineering">Engineering</option>
                  <option value="design">Design</option>
                  <option value="generic">Generic</option>
                </select>
              </Field>
              <Field label="Visibility" htmlFor="visibility">
                <select
                  id="visibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as Visibility)}
                  className="field text-sm"
                >
                  <option value="public">Public (all members)</option>
                  <option value="teams">Teams only</option>
                  <option value="private">Private (per-user)</option>
                </select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sprintsEnabled}
                onChange={(e) => setSprintsEnabled(e.target.checked)}
              />
              Enable sprints
            </label>
          </div>
          <div className="px-6 py-4 border-t border-border/60 flex items-center justify-end gap-2">
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
              className="tap rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mutation.isPending ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
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
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground mb-1.5">
        {label}
      </label>
      {children}
      {hint && <div className="text-xs text-muted-foreground mt-1.5">{hint}</div>}
    </div>
  );
}
