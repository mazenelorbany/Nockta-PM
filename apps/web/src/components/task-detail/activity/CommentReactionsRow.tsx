import { cn } from '@nockta/ui';

import { REACTION_EMOJIS, REACTION_GLYPH } from '../constants';
import type { Comment, ReactionEmoji } from '../types';

/**
 * Reactions strip under a comment. Shows: (1) the existing reaction buckets
 * as toggleable chips (current user's own reaction is highlighted), and
 * (2) a hover-only picker with all 6 emojis so the user can add one that
 * isn't already on the comment. Picker reveals on the parent list item's
 * `:hover` — the `group/group-hover` Tailwind pattern is set up on the <li>.
 */
export function CommentReactionsRow({
  comment,
  onToggle,
}: {
  comment: Comment;
  onToggle: (emoji: ReactionEmoji, youReacted: boolean) => void;
}): JSX.Element {
  const reactions = comment.reactions ?? [];
  const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
  return (
    <div className="mt-2 flex items-center gap-1 flex-wrap">
      {reactions.map((r) => (
        <button
          type="button"
          key={r.emoji}
          onClick={() => onToggle(r.emoji as ReactionEmoji, r.youReacted)}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs border transition-colors',
            r.youReacted
              ? 'border-brand/40 bg-brand/10 text-foreground'
              : 'border-border bg-background hover:bg-accent/40 text-muted-foreground',
          )}
        >
          <span>{REACTION_GLYPH[r.emoji as ReactionEmoji] ?? r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
      {/* Hover picker — surfaces only for emojis the user hasn't reacted with. */}
      <div className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-0.5">
        {REACTION_EMOJIS.filter((e) => !byEmoji.has(e)).map((emoji) => (
          <button
            type="button"
            key={emoji}
            onClick={() => onToggle(emoji, false)}
            className="inline-flex items-center justify-center h-5 w-5 rounded-full hover:bg-accent/40 text-[12px]"
            title={`React with ${emoji}`}
          >
            {REACTION_GLYPH[emoji]}
          </button>
        ))}
      </div>
    </div>
  );
}
