import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, History, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { cn, QueryErrorState, SkeletonList, Spinner } from '@nockta/ui';

import { ProjectTabs } from '../components/ProjectTabs';
import { AvatarCircle } from '../components/task-bits';
import { DocEditor as TiptapDocEditor } from '../components/DocEditor';
import {
  coarseBlockDiff,
  type PMDoc,
  type PMNode,
} from '../components/prosemirror-markdown';
import { api } from '../lib/api';
import { useResolvedProject } from '../lib/project-route';
import { queryKeys } from '../lib/query-keys';

// =============================================================================
// /projects/:projectId/docs[/:docId] — per-project markdown wiki.
// Tree nav on the left, editor on the right. Revisions and restore included.
// =============================================================================

interface DocSummary {
  id: string;
  projectId: string;
  title: string;
  parentDocId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  author?: { id: string; name: string; avatarUrl?: string | null } | null;
}

interface DocDetail extends DocSummary {
  body: string;
  contentJson: PMDoc | null;
  project: { id: string; key: string; name: string };
}

interface DocRevision {
  id: string;
  docId: string;
  title: string;
  body: string;
  contentJson: PMDoc | null;
  createdAt: string;
  author?: { id: string; name: string; avatarUrl?: string | null } | null;
}

export function ProjectDocsPage(): JSX.Element {
  // Doc id keeps using useParams (it's still a UUID). Project id (UUID, for
  // API calls) and project key (slug, for URLs) both come from the resolver.
  const { docId } = useParams<{ docId?: string }>();
  const { projectId, projectKey } = useResolvedProject();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<{ id: string; key: string; name: string }>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const docsQuery = useQuery({
    queryKey: ['docs', projectId],
    queryFn: () => api.get<DocSummary[]>(`/projects/${projectId}/docs`),
    enabled: Boolean(projectId),
  });

  const create = useMutation({
    mutationFn: (input: { title: string; body?: string; parentDocId?: string }) =>
      api.post<DocSummary>(`/projects/${projectId}/docs`, input),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ['docs', projectId] });
      // Use the slug for the URL bar even though `projectId` (UUID) is what
      // the API consumed above. Falls back to the raw param if the resolver
      // hasn't yet produced a key.
      navigate(`/projects/${projectKey || projectId}/docs/${doc.id}`);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create doc')),
  });

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 sm:px-6 md:px-8 py-3 sm:py-4 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          {projectQuery.data?.key && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground bg-secondary/60 px-1.5 py-0.5 rounded">
              {projectQuery.data.key}
            </span>
          )}
          <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">
            {projectQuery.data?.name ?? 'Docs'}
          </h1>
          <span className="text-muted-foreground/60 hidden sm:inline">·</span>
          <span className="text-sm text-muted-foreground hidden sm:inline">Docs</span>
        </div>
      </header>

      <ProjectTabs projectId={projectId} />

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar: doc tree. Hidden on small screens — on mobile the user
            navigates from the doc-picker dropdown in the body's header. */}
        <aside className="hidden md:flex w-64 border-r border-border bg-card/30 flex-col">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="nockta-eyebrow text-muted-foreground">In this project</span>
            <button
              type="button"
              onClick={() => create.mutate({ title: 'Untitled', body: '' })}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label="New doc"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {docsQuery.isLoading ? (
              <SkeletonList rows={4} rowClassName="h-6" />
            ) : (docsQuery.data ?? []).length === 0 ? (
              <button
                type="button"
                onClick={() => create.mutate({ title: 'Untitled', body: '' })}
                className="w-full rounded-md border border-dashed border-border bg-background/30 p-4 text-center text-xs text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
              >
                No docs yet. Click to create the first.
              </button>
            ) : (
              (docsQuery.data ?? []).map((d) => (
                <Link
                  key={d.id}
                  to={`/projects/${projectKey || projectId}/docs/${d.id}`}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors truncate',
                    d.id === docId
                      ? 'bg-accent text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  <span className="truncate">{d.title}</span>
                </Link>
              ))
            )}
          </div>
        </aside>

        {/* Editor pane */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-auto">
            {docId ? (
              <DocEditorPane docId={docId} projectId={projectId} />
            ) : (
              <EmptyEditor onCreate={() => create.mutate({ title: 'Untitled', body: '' })} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyEditor({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center p-6 sm:p-12">
      <div className="text-center max-w-md">
        <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
        <h2 className="text-lg font-semibold">Project knowledge base</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Architecture notes, decision records, runbooks. Markdown-only, versioned on every save.
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
        >
          Create your first doc
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Editor with autosave-on-blur and live preview
// =============================================================================

function DocEditorPane({ docId, projectId }: { docId: string; projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const docQuery = useQuery({
    queryKey: ['doc', docId],
    queryFn: () => api.get<DocDetail>(`/docs/${docId}`),
  });

  const [title, setTitle] = useState('');
  // Editor state lives here as the source of truth between renders. We hold
  // both representations (JSON + markdown) because the API accepts both and
  // older clients still read `body`. Initial values are filled once per
  // loaded doc id (see effect below).
  const [contentJson, setContentJson] = useState<PMDoc | null>(null);
  const [body, setBody] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState<DocRevision | null>(null);

  useEffect(() => {
    if (docQuery.data) {
      setTitle(docQuery.data.title);
      setBody(docQuery.data.body);
      setContentJson(docQuery.data.contentJson ?? null);
    }
    // Reset only when the loaded doc id changes — otherwise we'd clobber
    // unsaved edits every time the parent invalidated the cache.
  }, [docQuery.data?.id]);

  const update = useMutation({
    mutationFn: (
      patch: Partial<{ title: string; body: string; contentJson: PMDoc }>,
    ) => api.patch<DocDetail>(`/docs/${docId}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['doc', docId] });
      queryClient.invalidateQueries({ queryKey: ['docs', projectId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Save failed')),
  });
  const archive = useMutation({
    mutationFn: () => api.delete(`/docs/${docId}`),
    onSuccess: () => {
      toast.success('Doc archived');
      queryClient.invalidateQueries({ queryKey: ['docs', projectId] });
      navigate(`/projects/${projectId}/docs`);
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not archive')),
  });

  function commitTitle(): void {
    if (!docQuery.data) return;
    const t = title.trim();
    if (t && t !== docQuery.data.title) update.mutate({ title: t });
  }

  // Debounced body save: when Tiptap fires onChange we stash the new state
  // here, then commit 800ms after the user stops typing. The previous
  // implementation saved on blur — Tiptap doesn't have a single textarea
  // blur to hook into, so we switch to a timer. This also gives the FTS
  // pipeline a calmer write cadence.
  useEffect(() => {
    if (!docQuery.data) return;
    if (contentJson === null) return;
    const baselineBody = docQuery.data.body;
    const baselineJson = JSON.stringify(docQuery.data.contentJson ?? null);
    const currentJson = JSON.stringify(contentJson);
    if (body === baselineBody && currentJson === baselineJson) return;
    const id = window.setTimeout(() => {
      update.mutate({ body, contentJson });
    }, 800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, contentJson, docQuery.data?.id]);

  if (docQuery.isError) {
    return (
      <QueryErrorState
        title="Couldn't load this doc"
        error={docQuery.error}
        onRetry={() => void docQuery.refetch()}
        className="py-16"
      />
    );
  }
  if (docQuery.isLoading || !docQuery.data) {
    return (
      <div className="p-8 text-sm text-muted-foreground flex items-center gap-2">
        <Spinner /> Loading doc…
      </div>
    );
  }

  const doc = docQuery.data;
  const lastSaved = new Date(doc.updatedAt);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-3 border-b border-border flex items-center justify-between gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          maxLength={200}
          placeholder="Untitled"
          className="flex-1 bg-transparent text-xl font-bold tracking-tight focus:outline-none"
        />
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="History"
            title="Revision history"
          >
            <History className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Archive "${doc.title}"?`)) archive.mutate();
            }}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
            aria-label="Archive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <TiptapDocEditor
          contentJson={contentJson ?? (doc.contentJson ?? null)}
          markdown={body}
          docId={docId}
          onChange={(json, md) => {
            setContentJson(json);
            setBody(md);
          }}
        />
      </div>

      <footer className="px-4 sm:px-6 py-2 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <AvatarCircle user={doc.author ?? null} size={16} />
          {doc.author?.name ?? '—'}
        </span>
        <span>
          {update.isPending ? 'Saving…' : `Last saved ${lastSaved.toLocaleString()}`}
        </span>
      </footer>

      {historyOpen && (
        <RevisionHistory
          docId={docId}
          currentDoc={doc}
          onClose={() => setHistoryOpen(false)}
          onOpenDiff={(rev) => setDiffOpen(rev)}
          onRestore={(rev) => {
            setTitle(rev.title);
            setBody(rev.body);
            setContentJson(rev.contentJson);
            update.mutate({
              title: rev.title,
              body: rev.body,
              ...(rev.contentJson ? { contentJson: rev.contentJson } : {}),
            });
            setHistoryOpen(false);
          }}
        />
      )}
      {diffOpen && (
        <RevisionDiffModal
          oldRevision={diffOpen}
          currentDoc={doc}
          onClose={() => setDiffOpen(null)}
        />
      )}
    </div>
  );
}

// =============================================================================
// Revision history sidebar
// =============================================================================

function RevisionHistory({
  docId,
  currentDoc: _currentDoc,
  onClose,
  onRestore,
  onOpenDiff,
}: {
  docId: string;
  currentDoc: DocDetail;
  onClose: () => void;
  onRestore: (rev: DocRevision) => void;
  onOpenDiff: (rev: DocRevision) => void;
}): JSX.Element {
  const revsQuery = useQuery({
    queryKey: ['doc-revisions', docId],
    queryFn: () => api.get<DocRevision[]>(`/docs/${docId}/revisions`),
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex justify-end"
      onClick={onClose}
    >
      <aside
        className="w-full max-w-md bg-card border-l border-border h-full overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-border flex items-center justify-between sticky top-0 bg-card">
          <h2 className="text-sm font-semibold tracking-tight">Revision history</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md w-7 h-7 flex items-center justify-center text-muted-foreground hover:bg-accent transition-colors"
          >
            ✕
          </button>
        </header>
        <div className="p-4 space-y-2">
          {revsQuery.isLoading ? (
            <SkeletonList rows={5} rowClassName="h-8" />
          ) : (revsQuery.data ?? []).length === 0 ? (
            <div className="text-xs text-muted-foreground">No revisions yet.</div>
          ) : (
            (revsQuery.data ?? []).map((rev, i) => (
              <div
                key={rev.id}
                className="rounded-md border border-border bg-background/40 p-3 text-xs"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium">{rev.title}</span>
                  <span className="text-muted-foreground">
                    {new Date(rev.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <AvatarCircle user={rev.author ?? null} size={16} />
                  {rev.author?.name ?? '—'}
                </div>
                <p className="text-muted-foreground mt-2 line-clamp-3">{rev.body.slice(0, 200)}</p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenDiff(rev)}
                    className="rounded border border-border px-2 py-1 hover:bg-accent transition-colors"
                  >
                    View diff
                  </button>
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() => onRestore(rev)}
                      className="rounded border border-border px-2 py-1 hover:bg-accent transition-colors"
                    >
                      Restore this version
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

// =============================================================================
// Revision diff modal — side-by-side read-only Tiptap viewers. We render the
// old revision on the left and the current doc on the right, with a coarse
// "what changed" indicator (added/removed top-level paragraph counts) above.
// Paragraph-level diff highlighting is deferred to a future story; today the
// reader compares visually side-by-side.
// =============================================================================

function RevisionDiffModal({
  oldRevision,
  currentDoc,
  onClose,
}: {
  oldRevision: DocRevision;
  currentDoc: DocDetail;
  onClose: () => void;
}): JSX.Element {
  const diff = useMemo(
    () => coarseBlockDiff(oldRevision.contentJson, currentDoc.contentJson),
    [oldRevision.contentJson, currentDoc.contentJson],
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-6xl h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Revision diff</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {oldRevision.title} ·{' '}
              {new Date(oldRevision.createdAt).toLocaleString()} → current
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md w-7 h-7 flex items-center justify-center text-muted-foreground hover:bg-accent transition-colors"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-2 border-b border-border text-xs text-muted-foreground flex items-center gap-4 flex-wrap">
          <span>
            <span className="text-emerald-500 font-medium">+{diff.addedBlocks}</span> added,{' '}
            <span className="text-red-500 font-medium">−{diff.removedBlocks}</span> removed
          </span>
          <span className="text-muted-foreground/70">
            {diff.oldBlockCount} → {diff.newBlockCount} blocks
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 flex-1 overflow-hidden">
          <div className="border-r border-border overflow-auto">
            <div className="px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              Old
            </div>
            <TiptapDocEditor
              contentJson={oldRevision.contentJson as PMNode | null}
              markdown={oldRevision.body}
              onChange={() => {
                // Read-only — onChange is required by the prop type but never
                // fires because we pass `readOnly`.
              }}
              readOnly
            />
          </div>
          <div className="overflow-auto">
            <div className="px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              Current
            </div>
            <TiptapDocEditor
              contentJson={currentDoc.contentJson as PMNode | null}
              markdown={currentDoc.body}
              onChange={() => undefined}
              readOnly
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.problem.title || err.problem.detail || err.message || fallback;
  return fallback;
}
