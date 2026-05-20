import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { api } from '../../../lib/api';
import type { CommentRevisionRow } from '../types';
import { formatRelative } from '../utils';

/**
 * Modal that walks the user through each revision of a comment side-by-side
 * with the NEXT version. The current bodyMd lives on the comment row itself
 * (not in revisions); we tack it on as the "after" of the last revision.
 */
export function RevisionHistoryModal({
  commentId,
  onClose,
}: {
  commentId: string;
  onClose: () => void;
}): JSX.Element {
  const revisionsQuery = useQuery({
    queryKey: ['comment-revisions', commentId],
    queryFn: () => api.get<CommentRevisionRow[]>(`/comments/${commentId}/revisions`),
  });
  const revs = revisionsQuery.data ?? [];

  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-background/90 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-card border border-border rounded-lg max-w-3xl w-full max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Comment revision history"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Revision history</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
          {revisionsQuery.isLoading ? (
            <div className="text-muted-foreground">Loading…</div>
          ) : revs.length === 0 ? (
            <div className="text-muted-foreground">No revisions recorded.</div>
          ) : (
            revs.map((rev, i) => {
              const next = revs[i + 1];
              return (
                <div key={rev.id} className="rounded-md border border-border p-3">
                  <div className="text-xs text-muted-foreground mb-2">
                    <span className="font-medium text-foreground/80">
                      {rev.editedBy?.name ?? 'Unknown'}
                    </span>{' '}
                    edited {formatRelative(rev.editedAt)}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground mb-1 nockta-eyebrow">Before</div>
                      <pre className="whitespace-pre-wrap break-words font-sans bg-muted/30 rounded p-2">
                        {rev.bodyMd}
                      </pre>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-1 nockta-eyebrow">After</div>
                      <pre className="whitespace-pre-wrap break-words font-sans bg-muted/30 rounded p-2">
                        {next ? next.bodyMd : '(current version)'}
                      </pre>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
