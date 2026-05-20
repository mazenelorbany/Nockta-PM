import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@nockta/ui';

import { api } from '../../../lib/api';
import { useCommentTyping } from '../../../hooks/usePresence';
import { AvatarCircle } from '../../task-bits';
import { Section } from '../Section';
import type { Comment, ReactionEmoji } from '../types';
import { apiErrorMessage, formatRelative } from '../utils';
import { queryKeys } from '../../../lib/query-keys';

import { CommentReactionsRow } from './CommentReactionsRow';
import { RevisionHistoryModal } from './RevisionHistoryModal';
import { TemplatePickerPanel } from './TemplatePickerPanel';
import { MentionPickerPanel } from './MentionPickerPanel';
import type { CommentTemplate, UserListItem } from './types';

// =============================================================================
// Comments
// =============================================================================

export function CommentsThread({
  taskId,
  projectId,
  comments,
  loading,
}: {
  taskId: string;
  /** Required for the templates dropdown — workspace + project-scoped fetch. */
  projectId?: string | null;
  comments: Comment[];
  loading: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [quotingFrom, setQuotingFrom] = useState<{
    commentId: string;
    rangeStart: number;
    rangeEnd: number;
    excerpt: string;
    author: string;
  } | null>(null);
  const [historyForComment, setHistoryForComment] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [mentionPickerOpen, setMentionPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Pass I (Comments 8→9). Templates dropdown — fetches workspace + project
  // templates and renders them as a single sorted list in the picker.
  const templatesQuery = useQuery({
    queryKey: ['comment-templates', projectId ?? null],
    queryFn: () => api.get<CommentTemplate[]>(
      `/comment-templates${projectId ? `?projectId=${projectId}` : ''}`,
    ),
    enabled: templatePickerOpen,
  });

  // User list for the @mention typeahead. We rely on the same cached users
  // endpoint the rest of the drawer already uses, so this is usually a hit.
  const usersQuery = useQuery({
    queryKey: queryKeys.usersList(),
    queryFn: () => api.get<{ items: UserListItem[]; nextCursor: string | null }>(
      '/users?limit=100',
    ),
    enabled: mentionPickerOpen,
  });

  // Pass I (Realtime 8→9). Typing indicator under the composer.
  const { typingUserIds, notifyTyping } = useCommentTyping(taskId);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onComposerKeyup(): void {
    notifyTyping('start');
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = setTimeout(() => notifyTyping('stop'), 1_500);
  }

  useEffect(() => () => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
  }, []);

  function insertTemplate(tpl: CommentTemplate): void {
    const ta = textareaRef.current;
    if (!ta) {
      setBody((b) => `${b}${b ? '\n' : ''}${tpl.body}`);
      setTemplatePickerOpen(false);
      return;
    }
    const start = ta.selectionStart ?? body.length;
    const end = ta.selectionEnd ?? start;
    const next = `${body.slice(0, start)}${tpl.body}${body.slice(end)}`;
    setBody(next);
    setTemplatePickerOpen(false);
    // After react re-renders the textarea, restore the caret to the end of
    // the inserted template.
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      const caret = start + tpl.body.length;
      t.focus();
      t.setSelectionRange(caret, caret);
    });
  }

  function insertMention(item: { kind: 'here' } | { kind: 'user'; user: UserListItem }): void {
    const ta = textareaRef.current;
    const snippet =
      item.kind === 'here' ? '@here ' : `@[${item.user.id}](user) `;
    if (!ta) {
      setBody((b) => `${b}${snippet}`);
    } else {
      const start = ta.selectionStart ?? body.length;
      const end = ta.selectionEnd ?? start;
      const next = `${body.slice(0, start)}${snippet}${body.slice(end)}`;
      setBody(next);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        const caret = start + snippet.length;
        t.focus();
        t.setSelectionRange(caret, caret);
      });
    }
    setMentionPickerOpen(false);
  }

  // Per-comment refs so we can compute char offsets against the rendered
  // text when the user selects something and clicks Reply.
  const bodyRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const createMutation = useMutation({
    mutationFn: (input: {
      body: string;
      quotedCommentId?: string;
      quotedRangeStart?: number;
      quotedRangeEnd?: number;
    }) => api.post<Comment>(`/tasks/${taskId}/comments`, input),
    onSuccess: () => {
      setBody('');
      setQuotingFrom(null);
      void queryClient.invalidateQueries({ queryKey: ['comments', taskId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Comment failed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/comments/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['comments', taskId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete comment')),
  });

  const addReactionMutation = useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: string; emoji: ReactionEmoji }) =>
      api.post<unknown>(`/comments/${commentId}/reactions`, { emoji }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['comments', taskId] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Reaction failed')),
  });
  const removeReactionMutation = useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: string; emoji: ReactionEmoji }) =>
      api.delete<unknown>(`/comments/${commentId}/reactions/${emoji}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['comments', taskId] }),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not remove reaction')),
  });

  function toggleReaction(commentId: string, emoji: ReactionEmoji, youReacted: boolean): void {
    if (youReacted) removeReactionMutation.mutate({ commentId, emoji });
    else addReactionMutation.mutate({ commentId, emoji });
  }

  /**
   * Capture the current text selection against the rendered comment body.
   * Returns the (start, end) char offsets and the excerpt — null if the
   * selection is empty or lives entirely outside the target comment.
   *
   * We walk the DOM range against the comment's body container so the offset
   * is computed against the SAME text the server will slice (the persisted
   * bodyMd). Newlines preserved by `whitespace-pre-wrap` count as one
   * character in textContent, which matches the source string.
   */
  function captureSelection(commentId: string): { start: number; end: number; excerpt: string } | null {
    const container = bodyRefs.current.get(commentId);
    if (!container) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    // Build a "pre-range" from the start of the container to the start of
    // the selection — its toString().length is the char offset.
    const pre = range.cloneRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const excerpt = range.toString();
    const end = start + excerpt.length;
    if (excerpt.trim().length === 0) return null;
    return { start, end, excerpt };
  }

  function beginReply(comment: Comment): void {
    const captured = captureSelection(comment.id);
    if (captured) {
      setQuotingFrom({
        commentId: comment.id,
        rangeStart: captured.start,
        rangeEnd: captured.end,
        excerpt: captured.excerpt,
        author: comment.author?.name ?? 'Unknown',
      });
    } else {
      // No selection — quote the FULL body as the fallback. This is what
      // most chat apps do when a user clicks reply without highlighting.
      setQuotingFrom({
        commentId: comment.id,
        rangeStart: 0,
        rangeEnd: comment.bodyMd.length,
        excerpt: comment.bodyMd,
        author: comment.author?.name ?? 'Unknown',
      });
    }
    textareaRef.current?.focus();
  }

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    const input: {
      body: string;
      quotedCommentId?: string;
      quotedRangeStart?: number;
      quotedRangeEnd?: number;
    } = { body: trimmed };
    if (quotingFrom) {
      input.quotedCommentId = quotingFrom.commentId;
      input.quotedRangeStart = quotingFrom.rangeStart;
      input.quotedRangeEnd = quotingFrom.rangeEnd;
    }
    createMutation.mutate(input);
  }

  return (
    <Section title={`Comments${comments.length > 0 ? ` (${comments.length})` : ''}`}>
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <ul className="space-y-3 mb-4">
          {comments.length === 0 && (
            <li className="text-sm text-muted-foreground">No comments yet.</li>
          )}
          {comments.map((c) => (
            <li
              key={c.id}
              className="cv-comment group rounded-md border border-border bg-background/50 p-3 text-sm"
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <div className="flex items-center gap-2">
                  <AvatarCircle user={c.author ?? null} size={20} />
                  <span className="font-medium">{c.author?.name ?? 'Unknown'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(c.createdAt)}
                  </span>
                  {(c.editedCount ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => setHistoryForComment(c.id)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
                      title="View revision history"
                    >
                      (edited {c.editedCount}x)
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => beginReply(c)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Reply
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('Delete comment?')) deleteMutation.mutate(c.id);
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {c.quotedSnippet && (
                <blockquote className="my-1.5 border-l-2 border-brand/40 pl-2 py-0.5 text-xs text-muted-foreground bg-muted/20">
                  <span className="font-medium text-foreground/80">
                    {c.quotedSnippet.author?.name ?? 'Unknown'}:
                  </span>{' '}
                  {c.quotedSnippet.deleted ? (
                    <em>[deleted comment]</em>
                  ) : (
                    <span className="italic">{c.quotedSnippet.excerpt}</span>
                  )}
                </blockquote>
              )}
              <div
                ref={(el) => {
                  if (el) bodyRefs.current.set(c.id, el);
                  else bodyRefs.current.delete(c.id);
                }}
                className="whitespace-pre-wrap break-words mt-1.5"
              >
                {c.bodyMd}
              </div>
              <CommentReactionsRow
                comment={c}
                onToggle={(emoji, youReacted) => toggleReaction(c.id, emoji, youReacted)}
              />
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="space-y-2">
        {quotingFrom && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
            <div className="flex-1 min-w-0">
              <div className="text-muted-foreground mb-0.5">
                Replying to <span className="font-medium text-foreground/80">{quotingFrom.author}</span>
              </div>
              <blockquote className="border-l-2 border-brand/40 pl-2 italic text-muted-foreground line-clamp-2">
                {quotingFrom.excerpt}
              </blockquote>
            </div>
            <button
              type="button"
              onClick={() => setQuotingFrom(null)}
              className="text-muted-foreground hover:text-foreground p-0.5"
              aria-label="Cancel reply"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyUp={onComposerKeyup}
          onBlur={() => notifyTyping('stop')}
          rows={3}
          maxLength={10_000}
          placeholder={quotingFrom ? `Reply to ${quotingFrom.author}…` : 'Add a comment…'}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
        />
        {/* Pass I (Realtime 8→9). Typing indicator chip under the composer.
            Shows up only when at least one OTHER viewer is mid-keystroke. */}
        {typingUserIds.length > 0 && (
          <div className="text-[11px] text-muted-foreground italic px-1">
            {typingUserIds.length === 1
              ? 'Someone is typing…'
              : `${typingUserIds.length} people are typing…`}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            {/* Pass I (Comments 8→9). Templates dropdown. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setTemplatePickerOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
              >
                Templates <ChevronDown className="h-3 w-3" />
              </button>
              {templatePickerOpen && (
                <TemplatePickerPanel
                  templates={templatesQuery.data ?? []}
                  loading={templatesQuery.isLoading}
                  onPick={insertTemplate}
                  onClose={() => setTemplatePickerOpen(false)}
                />
              )}
            </div>
            {/* Pass I (Comments 8→9). @mention typeahead — minimal version
                offering "here" + the cached user list. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMentionPickerOpen((o) => !o)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
              >
                @ Mention <ChevronDown className="h-3 w-3" />
              </button>
              {mentionPickerOpen && (
                <MentionPickerPanel
                  users={usersQuery.data?.items ?? []}
                  loading={usersQuery.isLoading}
                  onPick={insertMention}
                  onClose={() => setMentionPickerOpen(false)}
                />
              )}
            </div>
          </div>
          <button
            type="submit"
            disabled={!body.trim() || createMutation.isPending}
            className={cn(
              'rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
              'hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {createMutation.isPending ? 'Posting…' : quotingFrom ? 'Reply' : 'Comment'}
          </button>
        </div>
      </form>
      {historyForComment && (
        <RevisionHistoryModal
          commentId={historyForComment}
          onClose={() => setHistoryForComment(null)}
        />
      )}
    </Section>
  );
}
