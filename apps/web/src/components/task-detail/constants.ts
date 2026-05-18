import { cn } from '@nockta/ui';

import type { Priority } from '../task-bits';

import type { Preset, ReactionEmoji } from './types';

export const PRESET_STATUSES: Record<Preset, string[]> = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
  design:      ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
  generic:     ['Todo', 'In Progress', 'Done'],
};

/**
 * The fixed six emojis the reaction picker shows. Kept in display order; the
 * order is canonical so the row layout doesn't shift when an emoji crosses
 * zero count.
 */
export const REACTION_EMOJIS = ['thumbsup', 'thumbsdown', 'heart', 'laugh', 'celebrate', 'eyes'] as const;
export const REACTION_GLYPH: Record<ReactionEmoji, string> = {
  thumbsup: '👍',
  thumbsdown: '👎',
  heart: '❤️',
  laugh: '😂',
  celebrate: '🎉',
  eyes: '👀',
};

export const PRIORITY_OPTIONS: Priority[] = ['Critical', 'High', 'Medium', 'Low'];

export const PILL_CLASS = cn(
  'tap inline-flex items-center gap-1.5 max-w-full rounded-md px-2 py-1 text-xs',
  'text-foreground/90 hover:bg-accent/50 hover:text-foreground',
  'data-[open=true]:bg-accent data-[open=true]:text-foreground',
  'transition-colors duration-150',
);

export const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
