import type { Editor } from '@tiptap/react';

// ---------- mention suggestion config ---------------------------------------

export interface UserHit {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
}
export interface TaskHit {
  id: string;
  keyNumber?: number;
  title: string;
  project?: { key: string };
}
export interface UserListResponse {
  items: UserHit[];
  nextCursor: string | null;
}
export interface TaskSearchResponse {
  items: TaskHit[];
  nextCursor: string | null;
}

export interface MentionItem {
  id: string;
  label: string;
  kind: 'user' | 'task';
  hint?: string;
}

// ---------- slash command items ---------------------------------------------

export interface SlashItem {
  id: string;
  label: string;
  hint: string;
  run: (editor: Editor) => void;
}

export interface MentionAttrs extends Record<string, unknown> {
  id: string;
  label: string;
  kind: 'user' | 'task';
}

// =============================================================================
// Floating suggestion list — used by both slash commands and mentions.
// =============================================================================

export interface SuggestionListProps<T> {
  items: T[];
  command: (item: T) => void;
  renderItem: (item: T) => { primary: string; secondary: string };
}

export interface SuggestionListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

// The component is forwardRef'd so the Tiptap suggestion plugin can read
// `component.ref` and call `onKeyDown` on it. We type the generic narrowly
// (SuggestionItemBase = the row payload) and rely on a single concrete
// signature — TypeScript's generic-in-forwardRef ergonomics are awkward,
// so we accept `unknown` items and the caller renders them.
export interface SuggestionItemBase {
  // No required fields — renderItem turns each into display strings.
  [key: string]: unknown;
}
