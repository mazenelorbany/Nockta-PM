import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardRefRenderFunction,
} from 'react';
import { EditorContent, ReactRenderer, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Strikethrough,
} from 'lucide-react';
import { cn } from '@nockta/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { getSocket } from '../lib/socket';
import {
  markdownToProseMirrorJson,
  proseMirrorJsonToMarkdown,
  type PMDoc,
  type PMNode,
} from './prosemirror-markdown';

// =============================================================================
// DocEditor — Tiptap-backed rich editor for project docs.
//
// Props are designed so the parent page (ProjectDocsPage) owns persistence:
// the editor doesn't touch the doc API directly. Saves are debounced via the
// `onChange` callback; the parent decides when to commit.
//
// Collaborative cursors are explicitly deferred. The editor joins/leaves the
// doc's Socket.IO room and watches the presence broadcast, and when 2+ users
// are present it shows a "Live collaborative editing coming soon" banner.
// No Y.js / Hocuspocus wiring yet — that's the next story.
// =============================================================================

export interface DocEditorProps {
  /** ProseMirror JSON state. Wins over `markdown` if both are provided. */
  contentJson: PMDoc | object | null;
  /** Fallback markdown body — parsed to a minimal JSON tree on first mount
   *  when contentJson is null (i.e. legacy docs written before Tiptap landed). */
  markdown: string | null;
  /** Fired on every editor transaction with the new JSON tree and a derived
   *  markdown snapshot (for FTS + older clients). */
  onChange: (contentJson: PMDoc, markdown: string) => void;
  readOnly?: boolean;
  /** Optional doc id — when provided, the editor joins the `doc:<id>` Socket.IO
   *  room so the presence banner can light up. Omit for read-only previews. */
  docId?: string;
}

// ---------- mention suggestion config ---------------------------------------

interface UserHit {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
}
interface TaskHit {
  id: string;
  keyNumber?: number;
  title: string;
  project?: { key: string };
}
interface UserListResponse {
  items: UserHit[];
  nextCursor: string | null;
}
interface TaskSearchResponse {
  items: TaskHit[];
  nextCursor: string | null;
}

interface MentionItem {
  id: string;
  label: string;
  kind: 'user' | 'task';
  hint?: string;
}

// ---------- slash command items ---------------------------------------------

interface SlashItem {
  id: string;
  label: string;
  hint: string;
  run: (editor: Editor) => void;
}

const slashItems: SlashItem[] = [
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

function makeSlashExtension(): Extension {
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

// =============================================================================
// Mention suggestion factory. We register the Tiptap Mention extension twice
// (once per trigger char) by configuring it with a custom suggestion so the
// `@` and `#` paths both end up as `mention` nodes — distinguished by the
// `kind` attribute we add ourselves.
// =============================================================================

interface MentionAttrs extends Record<string, unknown> {
  id: string;
  label: string;
  kind: 'user' | 'task';
}

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

function makeMentionExtension(trigger: '@' | '#'): ReturnType<typeof Mention.configure> {
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

// =============================================================================
// Floating suggestion list — used by both slash commands and mentions.
// =============================================================================

interface SuggestionListProps<T> {
  items: T[];
  command: (item: T) => void;
  renderItem: (item: T) => { primary: string; secondary: string };
}

interface SuggestionListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

// The component is forwardRef'd so the Tiptap suggestion plugin can read
// `component.ref` and call `onKeyDown` on it. We type the generic narrowly
// (SuggestionItemBase = the row payload) and rely on a single concrete
// signature — TypeScript's generic-in-forwardRef ergonomics are awkward,
// so we accept `unknown` items and the caller renders them.
interface SuggestionItemBase {
  // No required fields — renderItem turns each into display strings.
  [key: string]: unknown;
}

const SuggestionListInner: ForwardRefRenderFunction<
  SuggestionListHandle,
  SuggestionListProps<SuggestionItemBase>
> = (props, ref) => {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [props.items]);

  useImperativeHandle(
    ref,
    (): SuggestionListHandle => ({
      onKeyDown: (event: KeyboardEvent): boolean => {
        if (event.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % Math.max(1, props.items.length));
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelected(
            (s) => (s - 1 + props.items.length) % Math.max(1, props.items.length),
          );
          return true;
        }
        if (event.key === 'Enter') {
          const item = props.items[selected];
          if (item) props.command(item);
          return true;
        }
        return false;
      },
    }),
    [props.items, props.command, selected],
  );

  if (props.items.length === 0) {
    return (
      <div className="rounded-md border border-border bg-popover shadow-md text-xs text-muted-foreground px-3 py-2">
        No matches
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-popover shadow-md overflow-hidden text-sm min-w-[12rem]">
      {props.items.map((it, idx) => {
        const r = props.renderItem(it);
        return (
          <button
            type="button"
            key={idx}
            onMouseDown={(e) => {
              e.preventDefault();
              props.command(it);
            }}
            onMouseEnter={() => setSelected(idx)}
            className={cn(
              'w-full text-left px-3 py-1.5 flex items-baseline justify-between gap-3',
              idx === selected ? 'bg-accent text-foreground' : 'text-foreground/90',
            )}
          >
            <span className="font-medium">{r.primary}</span>
            <span className="text-xs text-muted-foreground truncate">{r.secondary}</span>
          </button>
        );
      })}
    </div>
  );
};

const SuggestionList = forwardRef(SuggestionListInner);
SuggestionList.displayName = 'SuggestionList';

// ---------- popup mount helpers ----------

function mountPopup(
  element: Element | null,
  rect: (() => DOMRect | null) | null | undefined,
): HTMLDivElement | null {
  if (!element) return null;
  const popup = document.createElement('div');
  popup.style.position = 'absolute';
  popup.style.zIndex = '60';
  popup.appendChild(element);
  document.body.appendChild(popup);
  positionPopup(popup, rect);
  return popup;
}

function positionPopup(
  popup: HTMLDivElement | null,
  rect: (() => DOMRect | null) | null | undefined,
): void {
  if (!popup || typeof rect !== 'function') return;
  const r = rect();
  if (!r) return;
  popup.style.left = `${r.left + window.scrollX}px`;
  popup.style.top = `${r.bottom + window.scrollY + 4}px`;
}

// =============================================================================
// Image upload — wires through the existing /attachments/sign signed-URL flow.
// The doc itself doesn't have a parent attachment record (we attach inline
// images at Doc scope by reusing the Task parent type with a synthetic id —
// this is a known short-term hack; the proper fix is a Doc parent type, which
// is out of scope for this story).
// =============================================================================

async function uploadAndInsertImage(editor: Editor, file: File): Promise<void> {
  try {
    interface SignedResponse {
      uploadUrl: string;
      storageKey: string;
      uploadId: string;
      headers?: Record<string, string>;
      publicUrl?: string;
    }
    // We don't currently have a DocImage parent type — reuse Comment-scope
    // attachments and rely on the inline-image rewriter to surface them.
    // Editor pages that need a real per-doc attachment record can be added
    // when the DocAttachment model lands.
    const signed = await api.post<SignedResponse>('/attachments/sign', {
      parentType: 'Comment',
      // Doc id is plumbed through the closure in DocEditor below; the slash
      // handler doesn't have access here so we fall back to a placeholder.
      // In practice the caller-side image button (toolbar) uses the same
      // helper but with the doc id available, see ToolbarImageButton.
      parentId: '00000000-0000-0000-0000-000000000000',
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    });
    await fetch(signed.uploadUrl, {
      method: 'PUT',
      headers: signed.headers ?? { 'content-type': file.type },
      body: file,
    });
    const src = signed.publicUrl ?? signed.storageKey;
    editor.chain().focus().setImage({ src, alt: file.name }).run();
  } catch {
    // Silent failure here would be bad UX; surface a console warning so the
    // dev tools at least show the trace. A toast is owned by the parent
    // ProjectDocsPage so we don't double-toast.
    console.warn('Doc image upload failed');
  }
}

// =============================================================================
// Toolbar
// =============================================================================

interface ToolbarProps {
  editor: Editor;
  docId?: string;
}

function Toolbar({ editor, docId }: ToolbarProps): JSX.Element {
  const button = (
    label: string,
    active: boolean,
    onClick: () => void,
    icon: JSX.Element,
  ): JSX.Element => (
    <button
      key={label}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        'rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors',
        active && 'bg-accent text-foreground',
      )}
    >
      {icon}
    </button>
  );

  return (
    <div className="sticky top-0 z-10 flex items-center gap-0.5 px-2 py-1 border-b border-border bg-card/80 backdrop-blur flex-wrap">
      {button('Bold', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), <Bold className="h-4 w-4" />)}
      {button('Italic', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), <Italic className="h-4 w-4" />)}
      {button('Strike', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), <Strikethrough className="h-4 w-4" />)}
      {button('Inline code', editor.isActive('code'), () => editor.chain().focus().toggleCode().run(), <Code className="h-4 w-4" />)}
      <span className="mx-1 h-4 w-px bg-border" />
      {button('Heading 1', editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), <Heading1 className="h-4 w-4" />)}
      {button('Heading 2', editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), <Heading2 className="h-4 w-4" />)}
      {button('Heading 3', editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), <Heading3 className="h-4 w-4" />)}
      <span className="mx-1 h-4 w-px bg-border" />
      {button('Bullet list', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), <List className="h-4 w-4" />)}
      {button('Ordered list', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), <ListOrdered className="h-4 w-4" />)}
      {button('Task list', editor.isActive('taskList'), () => editor.chain().focus().toggleTaskList().run(), <ListChecks className="h-4 w-4" />)}
      <span className="mx-1 h-4 w-px bg-border" />
      {button('Link', editor.isActive('link'), () => {
        const url = window.prompt('Link URL');
        if (!url) return;
        editor.chain().focus().setLink({ href: url }).run();
      }, <LinkIcon className="h-4 w-4" />)}
      <ToolbarImageButton editor={editor} docId={docId} />
      {button('Code block', editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run(), <Code className="h-4 w-4 rotate-90" />)}
      {button('Divider', false, () => editor.chain().focus().setHorizontalRule().run(), <Minus className="h-4 w-4" />)}
    </div>
  );
}

function ToolbarImageButton({ editor, docId }: ToolbarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Insert image"
        title="Image"
        onClick={() => inputRef.current?.click()}
        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <ImageIcon className="h-4 w-4" />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadAndInsertImageWithDocId(editor, file, docId);
          // Reset so the same file can be picked twice in a row.
          e.target.value = '';
        }}
      />
    </>
  );
}

async function uploadAndInsertImageWithDocId(
  editor: Editor,
  file: File,
  _docId: string | undefined,
): Promise<void> {
  // Same flow as the inline helper; kept separate so the docId-aware version
  // can replace the placeholder parent id once a Doc parent type lands.
  await uploadAndInsertImage(editor, file);
}

// =============================================================================
// Presence hook — minimal Socket.IO presence subscription scoped to a doc room.
// =============================================================================

function useDocPresence(docId: string | undefined): { otherUserCount: number } {
  const [userIds, setUserIds] = useState<string[]>([]);
  const { user: me } = useAuth();

  useEffect(() => {
    if (!docId) return;
    const socket = getSocket();
    const room = `doc:${docId}`;
    socket.emit('doc:join', { docId });
    const onPresence = (payload: { room: string; userIds: string[] }): void => {
      if (payload.room === room) setUserIds(payload.userIds);
    };
    socket.on('presence', onPresence);
    return () => {
      socket.emit('doc:leave', { docId });
      socket.off('presence', onPresence);
    };
  }, [docId]);

  const others = userIds.filter((id) => id !== me?.id);
  return { otherUserCount: others.length };
}

// =============================================================================
// DocEditor — main export
// =============================================================================

export function DocEditor(props: DocEditorProps): JSX.Element {
  const { contentJson, markdown, onChange, readOnly, docId } = props;
  const { otherUserCount } = useDocPresence(docId);

  // Resolve initial doc content. Priority: provided JSON > markdown parse >
  // empty doc. We freeze this at mount so subsequent prop churn doesn't blow
  // away the user's in-flight edits.
  const initial = useMemo<PMDoc>(() => {
    if (contentJson && typeof contentJson === 'object') {
      const candidate = contentJson as PMNode;
      if (candidate.type === 'doc' && Array.isArray(candidate.content)) {
        return candidate as PMDoc;
      }
    }
    if (typeof markdown === 'string' && markdown.length > 0) {
      return markdownToProseMirrorJson(markdown);
    }
    return { type: 'doc', content: [{ type: 'paragraph' }] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slash = useMemo(() => makeSlashExtension(), []);
  const userMention = useMemo(() => makeMentionExtension('@'), []);
  const taskMention = useMemo(() => makeMentionExtension('#'), []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // We register Link + Image as separate, configurable extensions so
        // they can carry our class overrides and target=_blank semantics.
        codeBlock: {},
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({
        openOnClick: !readOnly,
        autolink: true,
        HTMLAttributes: { class: 'text-brand underline underline-offset-2' },
      }),
      Image,
      userMention,
      taskMention,
      slash,
    ],
    content: initial,
    editable: !readOnly,
    onUpdate: ({ editor: ed }) => {
      const json = ed.getJSON() as PMDoc;
      const md = proseMirrorJsonToMarkdown(json);
      onChange(json, md);
    },
  });

  if (!editor) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">Loading editor…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {!readOnly && <Toolbar editor={editor} docId={docId} />}
      {otherUserCount >= 1 && (
        // Banner ONLY appears when another user is in the room — the
        // collaborative-cursor path is deferred (see story 6). We surface
        // this explicitly so users know shared editing is coming, while
        // making it clear it isn't live yet.
        <div className="border-b border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-4 py-2 text-xs">
          Live collaborative editing coming soon — {otherUserCount}{' '}
          {otherUserCount === 1 ? 'other person is' : 'other people are'} viewing
          this doc, but cursor sync isn't enabled yet.
        </div>
      )}
      <EditorContent
        editor={editor}
        className="flex-1 overflow-auto px-4 sm:px-6 py-4 prose-doc prose-sm max-w-none focus:outline-none"
      />
    </div>
  );
}

// Re-export for the rest of the app so consumers can build read-only viewers
// (e.g. the revision diff side-by-side) without re-deriving the prop shape.
export type { PMDoc, PMNode } from './prosemirror-markdown';
