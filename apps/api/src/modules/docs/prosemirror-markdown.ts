// =============================================================================
// Minimal ProseMirror JSON -> Markdown serializer.
//
// Purpose: keep the existing `Doc.body` markdown column populated when the
// client (Tiptap) sends only the JSON tree. The FTS `search_vector` pipeline
// indexes `body`, so a missing/empty body breaks doc search. We don't need a
// perfectly faithful markdown — only enough that the index has the words and
// that older clients can still read the doc as plain text.
//
// Supported node types (anything else falls back to extracting its children's
// text):
//   - doc, paragraph, hardBreak
//   - heading (levels 1..6)
//   - bulletList, orderedList, listItem
//   - taskList, taskItem (rendered as `- [ ]` / `- [x]`)
//   - blockquote
//   - codeBlock (fenced ```lang)
//   - horizontalRule (---)
//   - text (with optional `bold`, `italic`, `code`, `link`, `strike` marks)
//   - mention (rendered as `@name` / `#key`)
//   - image (rendered as ![alt](src))
//
// This serializer is deliberately permissive: missing fields default to empty,
// unknown node types become a paragraph of their text content. The output is
// stable enough for round-trip tests on the frontend (which shares a parallel
// implementation in apps/web/src/components/DocEditor.tsx).
// =============================================================================

export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  marks?: ProseMirrorMark[];
  text?: string;
}

export interface ProseMirrorDoc extends ProseMirrorNode {
  type: 'doc';
}

export function proseMirrorJsonToMarkdown(doc: ProseMirrorNode | null | undefined): string {
  if (!doc || typeof doc !== 'object') return '';
  const blocks: string[] = [];
  for (const child of doc.content ?? []) {
    const md = renderBlock(child, 0);
    if (md.length > 0) blocks.push(md);
  }
  return blocks.join('\n\n').trim();
}

function renderBlock(node: ProseMirrorNode, listDepth: number): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content ?? []);
    case 'heading': {
      const level = clampLevel(node.attrs?.['level']);
      return `${'#'.repeat(level)} ${renderInline(node.content ?? [])}`;
    }
    case 'bulletList':
      return (node.content ?? [])
        .map((li) => renderListItem(li, listDepth, '-'))
        .join('\n');
    case 'orderedList':
      return (node.content ?? [])
        .map((li, i) => renderListItem(li, listDepth, `${i + 1}.`))
        .join('\n');
    case 'taskList':
      return (node.content ?? [])
        .map((ti) => renderTaskItem(ti, listDepth))
        .join('\n');
    case 'blockquote':
      return (node.content ?? [])
        .map((b) => renderBlock(b, listDepth))
        .join('\n\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'codeBlock': {
      const lang = typeof node.attrs?.['language'] === 'string' ? (node.attrs['language'] as string) : '';
      const body = (node.content ?? []).map((c) => c.text ?? '').join('');
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    default:
      // Unknown block — render its inline content so words still land in FTS.
      return renderInline(node.content ?? []);
  }
}

function renderListItem(node: ProseMirrorNode, depth: number, marker: string): string {
  const indent = '  '.repeat(depth);
  // A listItem's children are typically [paragraph, (nested list)?]. We
  // render the first paragraph inline on the same line as the marker; any
  // nested list goes on subsequent lines indented one level deeper.
  const inner = (node.content ?? [])
    .map((child, idx) => {
      if (child.type === 'paragraph') return renderInline(child.content ?? []);
      if (
        child.type === 'bulletList' ||
        child.type === 'orderedList' ||
        child.type === 'taskList'
      ) {
        return (idx === 0 ? '' : '\n') + renderBlock(child, depth + 1);
      }
      return renderBlock(child, depth + 1);
    })
    .join('\n');
  return `${indent}${marker} ${inner}`;
}

function renderTaskItem(node: ProseMirrorNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const checked = node.attrs?.['checked'] === true;
  const inner = (node.content ?? [])
    .map((child) =>
      child.type === 'paragraph' ? renderInline(child.content ?? []) : renderBlock(child, depth + 1),
    )
    .join('\n');
  return `${indent}- [${checked ? 'x' : ' '}] ${inner}`;
}

function renderInline(nodes: ProseMirrorNode[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: ProseMirrorNode): string {
  switch (node.type) {
    case 'text': {
      let text = node.text ?? '';
      // Apply marks in a deterministic order: code wraps innermost, then
      // emphasis, then strong, then link. That mirrors how the Tiptap markdown
      // export reads marks back, so round-trips stay stable.
      const marks = node.marks ?? [];
      const has = (t: string): ProseMirrorMark | undefined => marks.find((m) => m.type === t);
      if (has('code')) text = `\`${text}\``;
      if (has('italic')) text = `*${text}*`;
      if (has('bold')) text = `**${text}**`;
      const strike = has('strike');
      if (strike) text = `~~${text}~~`;
      const link = has('link');
      if (link) {
        const href = typeof link.attrs?.['href'] === 'string' ? (link.attrs['href'] as string) : '';
        text = `[${text}](${href})`;
      }
      return text;
    }
    case 'hardBreak':
      return '  \n';
    case 'mention': {
      const label = typeof node.attrs?.['label'] === 'string' ? (node.attrs['label'] as string) : '';
      const id = typeof node.attrs?.['id'] === 'string' ? (node.attrs['id'] as string) : '';
      const kind = typeof node.attrs?.['kind'] === 'string' ? (node.attrs['kind'] as string) : 'user';
      const prefix = kind === 'task' ? '#' : '@';
      return `${prefix}${label || id}`;
    }
    case 'image': {
      const src = typeof node.attrs?.['src'] === 'string' ? (node.attrs['src'] as string) : '';
      const alt = typeof node.attrs?.['alt'] === 'string' ? (node.attrs['alt'] as string) : '';
      return `![${alt}](${src})`;
    }
    default:
      // Unknown inline — extract whatever text we can find recursively.
      if (node.content) return renderInline(node.content);
      return node.text ?? '';
  }
}

function clampLevel(level: unknown): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 1;
  if (level < 1) return 1;
  if (level > 6) return 6;
  return Math.floor(level);
}
