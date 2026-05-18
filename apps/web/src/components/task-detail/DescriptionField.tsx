import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import MarkdownIt from 'markdown-it';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import { Section } from './Section';
import { apiErrorMessage } from './utils';

// =============================================================================
// DescriptionField — click-to-edit markdown.
//
// Display mode: rendered HTML via markdown-it (headings, bold, lists, code,
//   links, blockquotes). Click anywhere on the rendered content to switch
//   into edit mode.
// Edit mode: a focused <textarea> that grows with the content. Save on blur
//   or Cmd/Ctrl+Enter; cancel on Esc (restores last-saved value).
//
// HTML injection: markdown-it is configured with `html: false` so raw HTML
// in user input is rendered as literal text, not active HTML. Sufficient for
// an internal-only tool — no XSS surface.
// =============================================================================

// Single shared parser instance — keeps each render cheap.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
});

function renderMd(source: string): string {
  return md.render(source ?? '');
}

export function DescriptionField({
  value,
  onSave,
  taskId,
}: {
  value: string;
  onSave: (next: string) => void;
  taskId?: string;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const dirty = draft !== value;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync external updates (e.g. server pushed a new revision) into the
  // local draft as long as the user isn't actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // Auto-grow the textarea to fit its content while editing — caps at the
  // viewport-relative max so long descriptions don't push the drawer body
  // off-screen.
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 600)}px`;
  }, [editing, draft]);

  // Focus + select-all on entering edit mode so a quick double-click into
  // a short description can be retyped without a manual select-all.
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      // Place the cursor at the end rather than selecting everything — most
      // edits are appends or tweaks, not full rewrites.
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  const html = useMemo(() => renderMd(value), [value]);

  const expand = useMutation({
    mutationFn: () => api.post<{ description: string }>(`/ai/tasks/${taskId}/expand-description`),
    onSuccess: (data) => {
      setDraft(data.description);
      setEditing(true);
      toast.success('Description drafted — review and save');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'AI is unavailable')),
  });

  function commit(): void {
    setEditing(false);
    if (dirty) onSave(draft);
  }

  function cancel(): void {
    setDraft(value);
    setEditing(false);
  }

  // ---- Display mode --------------------------------------------------------
  if (!editing) {
    return (
      <Section title="Description">
        {value.trim() ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setEditing(true);
              }
            }}
            className="prose-task rounded-md border border-transparent hover:border-input hover:bg-accent/30 transition-colors px-3 py-2 cursor-text"
            // markdown-it output is escaped (html: false) — safe to inject.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-full text-left rounded-md border border-dashed border-input px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-ring transition-colors"
          >
            Add a description…
          </button>
        )}
        {taskId && (
          <div className="mt-1 flex items-center justify-end text-xs">
            <button
              type="button"
              onClick={() => expand.mutate()}
              disabled={expand.isPending}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary disabled:opacity-50"
              title="Generate a description draft with AI"
            >
              <span className="text-primary">✨</span>
              {expand.isPending ? 'Drafting…' : 'AI draft'}
            </button>
          </div>
        )}
      </Section>
    );
  }

  // ---- Edit mode -----------------------------------------------------------
  return (
    <Section title="Description">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        rows={6}
        maxLength={20_000}
        placeholder="Add a description… Markdown supported (## heading, **bold**, - list, `code`, [link](url))"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none font-mono leading-relaxed"
      />
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {dirty
            ? 'Cmd/Ctrl+Enter to save · Esc to cancel'
            : 'Click outside to close · Esc to cancel'}
        </span>
        {taskId && (
          <button
            type="button"
            onClick={() => expand.mutate()}
            disabled={expand.isPending}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary disabled:opacity-50"
            title="Generate a description draft with AI"
          >
            <span className="text-primary">✨</span>
            {expand.isPending ? 'Drafting…' : 'AI draft'}
          </button>
        )}
      </div>
    </Section>
  );
}
