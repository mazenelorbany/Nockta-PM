import { useRef } from 'react';
import type { Editor } from '@tiptap/react';
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

import { uploadAndInsertImageWithDocId } from './image-upload';

// =============================================================================
// Toolbar
// =============================================================================

interface ToolbarProps {
  editor: Editor;
  docId?: string;
}

export function Toolbar({ editor, docId }: ToolbarProps): JSX.Element {
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
