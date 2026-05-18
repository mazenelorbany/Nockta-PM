import { useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';

import {
  markdownToProseMirrorJson,
  proseMirrorJsonToMarkdown,
  type PMDoc,
  type PMNode,
} from './prosemirror-markdown';
import { Toolbar } from './doc-editor/Toolbar';
import { makeSlashExtension } from './doc-editor/slash-extension';
import { makeMentionExtension } from './doc-editor/mention-extension';
import { useDocPresence } from './doc-editor/use-doc-presence';

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
