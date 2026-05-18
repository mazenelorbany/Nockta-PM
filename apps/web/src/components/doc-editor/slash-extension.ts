import { ReactRenderer, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';

import { SuggestionList, mountPopup, positionPopup } from './SuggestionList';
import type {
  SlashItem,
  SuggestionItemBase,
  SuggestionListHandle,
  SuggestionListProps,
} from './types';
import { uploadAndInsertImage } from './image-upload';

export const slashItems: SlashItem[] = [
  {
    id: 'heading',
    label: 'Heading',
    hint: 'Section title',
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'list',
    label: 'Bullet list',
    hint: 'Unordered list',
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'task',
    label: 'Task list',
    hint: '[ ] Checkable item',
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'image',
    label: 'Image',
    hint: 'Upload from your computer',
    run: (e) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) void uploadAndInsertImage(e, file);
      });
      input.click();
    },
  },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Monospaced block',
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Horizontal rule',
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'mention',
    label: 'Mention',
    hint: 'Insert @user or #task',
    run: (e) => e.chain().focus().insertContent('@').run(),
  },
];

// =============================================================================
// Slash-command extension. Uses the Tiptap suggestion plugin, restricted to
// the start of a line so a literal `/` mid-sentence (e.g. in a URL) doesn't
// fire the menu.
// =============================================================================

export function makeSlashExtension(): Extension {
  return Extension.create({
    name: 'slashCommand',
    addOptions() {
      return {
        suggestion: {
          char: '/',
          startOfLine: true,
          command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: SlashItem }) => {
            editor.chain().focus().deleteRange(range).run();
            props.run(editor);
          },
        } satisfies Partial<SuggestionOptions<SlashItem>>,
      };
    },
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          ...this.options.suggestion,
          items: ({ query }: { query: string }): SlashItem[] => {
            const q = query.toLowerCase();
            return slashItems.filter(
              (it) => it.id.includes(q) || it.label.toLowerCase().includes(q),
            );
          },
          render: () => {
            let component: ReactRenderer<
              SuggestionListHandle,
              SuggestionListProps<SuggestionItemBase>
            > | null = null;
            let popup: HTMLDivElement | null = null;
            const toBaseProps = (
              p: SuggestionProps<SlashItem>,
            ): SuggestionListProps<SuggestionItemBase> => ({
              items: p.items as unknown as SuggestionItemBase[],
              command: (it) => p.command(it as unknown as SlashItem),
              renderItem: (it) => {
                const s = it as unknown as SlashItem;
                return { primary: s.label, secondary: s.hint };
              },
            });
            return {
              onStart: (props: SuggestionProps<SlashItem>) => {
                component = new ReactRenderer(SuggestionList, {
                  props: toBaseProps(props),
                  editor: props.editor,
                });
                popup = mountPopup(component.element, props.clientRect);
              },
              onUpdate: (props: SuggestionProps<SlashItem>) => {
                component?.updateProps(toBaseProps(props));
                positionPopup(popup, props.clientRect);
              },
              onKeyDown: (props: { event: KeyboardEvent }): boolean => {
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
        }),
      ];
    },
  });
}
