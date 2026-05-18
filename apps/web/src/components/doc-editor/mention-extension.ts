import { ReactRenderer } from '@tiptap/react';
import Mention from '@tiptap/extension-mention';
import type { SuggestionProps } from '@tiptap/suggestion';

import { api } from '../../lib/api';

import { SuggestionList, mountPopup, positionPopup } from './SuggestionList';
import type {
  MentionAttrs,
  MentionItem,
  SuggestionItemBase,
  SuggestionListHandle,
  SuggestionListProps,
  TaskSearchResponse,
  UserListResponse,
} from './types';

// =============================================================================
// Mention suggestion factory. We register the Tiptap Mention extension twice
// (once per trigger char) by configuring it with a custom suggestion so the
// `@` and `#` paths both end up as `mention` nodes — distinguished by the
// `kind` attribute we add ourselves.
// =============================================================================

async function fetchUsers(q: string): Promise<MentionItem[]> {
  const res = await api.get<UserListResponse>(
    `/users?limit=8${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  );
  return res.items.slice(0, 8).map<MentionItem>((u) => ({
    id: u.id,
    label: u.name ?? u.email ?? u.id,
    kind: 'user',
    hint: u.email,
  }));
}

async function fetchTasks(q: string): Promise<MentionItem[]> {
  if (!q) return [];
  const res = await api.get<TaskSearchResponse>(
    `/search/tasks?q=${encodeURIComponent(q)}&limit=8`,
  );
  return res.items.slice(0, 8).map<MentionItem>((t) => ({
    id: t.id,
    label: t.project?.key && t.keyNumber !== undefined
      ? `${t.project.key}-${t.keyNumber}`
      : t.title,
    kind: 'task',
    hint: t.title,
  }));
}

export function makeMentionExtension(trigger: '@' | '#'): ReturnType<typeof Mention.configure> {
  const kind: 'user' | 'task' = trigger === '@' ? 'user' : 'task';
  return Mention.extend({
    // Each invocation needs its own node name otherwise the second .configure()
    // call would clobber the first registration in the editor schema.
    name: trigger === '@' ? 'mention' : 'mentionTask',
    addAttributes() {
      return {
        id: { default: '' },
        label: { default: '' },
        kind: { default: kind },
      };
    },
  }).configure({
    HTMLAttributes: {
      class:
        trigger === '@'
          ? 'inline-flex items-center rounded bg-brand/15 text-brand px-1 text-[0.85em]'
          : 'inline-flex items-center rounded bg-accent text-foreground px-1 text-[0.85em]',
    },
    renderHTML: ({ node }) => {
      const attrs = node.attrs as Partial<MentionAttrs>;
      const href =
        kind === 'user' ? `/users/${attrs.id ?? ''}` : `/tasks/${attrs.id ?? ''}`;
      const prefix = trigger;
      const label = typeof attrs.label === 'string' && attrs.label.length > 0 ? attrs.label : (attrs.id ?? '');
      return [
        'a',
        { href, class: 'mention-chip', 'data-kind': kind, 'data-id': attrs.id ?? '' },
        `${prefix}${label}`,
      ];
    },
    suggestion: {
      char: trigger,
      allowSpaces: false,
      items: async ({ query }: { query: string }): Promise<MentionItem[]> => {
        try {
          return trigger === '@' ? await fetchUsers(query) : await fetchTasks(query);
        } catch {
          return [];
        }
      },
      command: ({ editor, range, props }) => {
        // Tiptap's MentionNodeAttrs only declares `id` + `label`; our items
        // also carry `kind`. The runtime payload is what we put in `items`
        // above, so the cast is safe.
        const item = props as unknown as MentionItem;
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: trigger === '@' ? 'mention' : 'mentionTask',
            attrs: { id: item.id, label: item.label, kind: item.kind },
          })
          .insertContent(' ')
          .run();
      },
      render: () => {
        let component: ReactRenderer<
          SuggestionListHandle,
          SuggestionListProps<SuggestionItemBase>
        > | null = null;
        let popup: HTMLDivElement | null = null;
        const toBaseProps = (
          p: SuggestionProps<MentionItem>,
        ): SuggestionListProps<SuggestionItemBase> => ({
          items: p.items as unknown as SuggestionItemBase[],
          command: (it) => p.command(it as unknown as MentionItem),
          renderItem: (it) => {
            const m = it as unknown as MentionItem;
            return { primary: `${trigger}${m.label}`, secondary: m.hint ?? '' };
          },
        });
        return {
          onStart: (props: SuggestionProps<MentionItem>) => {
            component = new ReactRenderer(SuggestionList, {
              props: toBaseProps(props),
              editor: props.editor,
            });
            popup = mountPopup(component.element, props.clientRect);
          },
          onUpdate: (props: SuggestionProps<MentionItem>) => {
            component?.updateProps(toBaseProps(props));
            positionPopup(popup, props.clientRect);
          },
          onKeyDown: (props: { event: KeyboardEvent }) => {
            if (props.event.key === 'Escape') {
              popup?.remove();
              return true;
            }
            return component?.ref?.onKeyDown(props.event) ?? false;
          },
          onExit: () => {
            popup?.remove();
            popup = null;
            component?.destroy();
            component = null;
          },
        };
      },
    },
  });
}
