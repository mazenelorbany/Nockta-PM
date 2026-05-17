// =============================================================================
// ProseMirror JSON <-> Markdown utilities (frontend twin of
// apps/api/src/modules/docs/prosemirror-markdown.ts).
//
// Two responsibilities:
//   1. Serialize a Tiptap doc's JSON tree to markdown — used by DocEditor
//      onChange to produce `markdown` for the older clients / FTS pipeline.
//   2. Parse a minimal markdown string back to a ProseMirror JSON tree —
//      used to bootstrap the editor when a doc only has `body` (the pre-Tiptap
//      world). This is intentionally a small subset: headings, paragraphs,
//      code blocks, bullets, ordered lists, task lists, horizontal rules.
//      Anything fancier falls back to a paragraph. The Tiptap editor takes
//      it from there.
//
// Mention extraction is also exposed here so tests can verify it against a
// fixture without touching React.
// =============================================================================

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

export interface PMDoc extends PMNode {
  type: 'doc';
}

// ---------- JSON -> markdown -------------------------------------------------

export function proseMirrorJsonToMarkdown(doc: PMNode | null | undefined): string {
  if (!doc || typeof doc !== 'object') return '';
  const blocks: string[] = [];
  for (const child of doc.content ?? []) {
    const md = renderBlock(child, 0);
    if (md.length > 0) blocks.push(md);
  }
  return blocks.join('\n\n').trim();
}

function renderBlock(node: PMNode, depth: number): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content ?? []);
    case 'heading': {
      const level = clampLevel(node.attrs?.['level']);
      return `${'#'.repeat(level)} ${renderInline(node.content ?? [])}`;
    }
    case 'bulletList':
      return (node.content ?? [])
        .map((li) => renderListItem(li, depth, '-'))
        .join('\n');
    case 'orderedList':
      return (node.content ?? [])
        .map((li, i) => renderListItem(li, depth, `${i + 1}.`))
        .join('\n');
    case 'taskList':
      return (node.content ?? [])
        .map((ti) => renderTaskItem(ti, depth))
        .join('\n');
    case 'blockquote':
      return (node.content ?? [])
        .map((b) => renderBlock(b, depth))
        .join('\n\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'codeBlock': {
      const lang =
        typeof node.attrs?.['language'] === 'string' ? (node.attrs['language'] as string) : '';
      const body = (node.content ?? []).map((c) => c.text ?? '').join('');
      return `\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    default:
      return renderInline(node.content ?? []);
  }
}

function renderListItem(node: PMNode, depth: number, marker: string): string {
  const indent = '  '.repeat(depth);
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

function renderTaskItem(node: PMNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const checked = node.attrs?.['checked'] === true;
  const inner = (node.content ?? [])
    .map((child) =>
      child.type === 'paragraph' ? renderInline(child.content ?? []) : renderBlock(child, depth + 1),
    )
    .join('\n');
  return `${indent}- [${checked ? 'x' : ' '}] ${inner}`;
}

function renderInline(nodes: PMNode[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: PMNode): string {
  switch (node.type) {
    case 'text': {
      let text = node.text ?? '';
      const marks = node.marks ?? [];
      const has = (t: string): PMMark | undefined => marks.find((m) => m.type === t);
      if (has('code')) text = `\`${text}\``;
      if (has('italic')) text = `*${text}*`;
      if (has('bold')) text = `**${text}**`;
      if (has('strike')) text = `~~${text}~~`;
      const link = has('link');
      if (link) {
        const href =
          typeof link.attrs?.['href'] === 'string' ? (link.attrs['href'] as string) : '';
        text = `[${text}](${href})`;
      }
      return text;
    }
    case 'hardBreak':
      return '  \n';
    case 'mention': {
      const label =
        typeof node.attrs?.['label'] === 'string' ? (node.attrs['label'] as string) : '';
      const id =
        typeof node.attrs?.['id'] === 'string' ? (node.attrs['id'] as string) : '';
      const kind =
        typeof node.attrs?.['kind'] === 'string' ? (node.attrs['kind'] as string) : 'user';
      const prefix = kind === 'task' ? '#' : '@';
      return `${prefix}${label || id}`;
    }
    case 'image': {
      const src =
        typeof node.attrs?.['src'] === 'string' ? (node.attrs['src'] as string) : '';
      const alt =
        typeof node.attrs?.['alt'] === 'string' ? (node.attrs['alt'] as string) : '';
      return `![${alt}](${src})`;
    }
    default:
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

// ---------- markdown -> JSON -------------------------------------------------

export function markdownToProseMirrorJson(markdown: string): PMDoc {
  const lines = markdown.split('\n');
  const blocks: PMNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    // Fenced code
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // skip closing fence
      const attrs: Record<string, unknown> = {};
      if (lang) attrs['language'] = lang;
      const codeBlock: PMNode = {
        type: 'codeBlock',
        attrs,
        content: body.length > 0 ? [{ type: 'text', text: body.join('\n') }] : [],
      };
      blocks.push(codeBlock);
      continue;
    }
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]?.length ?? 1;
      const text = (h[2] ?? '').trim();
      blocks.push({
        type: 'heading',
        attrs: { level },
        content: text ? [{ type: 'text', text }] : [],
      });
      i++;
      continue;
    }
    // HR
    if (/^-{3,}$|^\*{3,}$/.test(line.trim())) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    // Task list (`- [ ]` / `- [x]`)
    if (/^\s*-\s+\[[ xX]\]\s+/.test(line)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^\s*-\s+\[[ xX]\]\s+/.test(lines[i] ?? '')) {
        const m = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(lines[i] ?? '');
        if (!m) break;
        const checked = (m[1] ?? ' ').toLowerCase() === 'x';
        const text = m[2] ?? '';
        items.push({
          type: 'taskItem',
          attrs: { checked },
          content: [
            {
              type: 'paragraph',
              content: text ? [{ type: 'text', text }] : [],
            },
          ],
        });
        i++;
      }
      blocks.push({ type: 'taskList', content: items });
      continue;
    }
    // Bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
        const text = (lines[i] ?? '').replace(/^\s*[-*]\s+/, '');
        items.push({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: text ? [{ type: 'text', text }] : [],
            },
          ],
        });
        i++;
      }
      blocks.push({ type: 'bulletList', content: items });
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: PMNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        const text = (lines[i] ?? '').replace(/^\s*\d+\.\s+/, '');
        items.push({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: text ? [{ type: 'text', text }] : [],
            },
          ],
        });
        i++;
      }
      blocks.push({ type: 'orderedList', content: items });
      continue;
    }
    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Paragraph (consume contiguous non-empty plain lines).
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !(lines[i] ?? '').startsWith('#') &&
      !(lines[i] ?? '').startsWith('```') &&
      !/^\s*[-*]\s+/.test(lines[i] ?? '') &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? '')
    ) {
      para.push(lines[i] ?? '');
      i++;
    }
    const text = para.join(' ');
    blocks.push({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    });
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph' });
  }
  return { type: 'doc', content: blocks };
}

// ---------- mention extraction ----------------------------------------------

export interface ExtractedMention {
  kind: 'user' | 'task';
  id: string;
  label: string;
}

export function extractMentions(doc: PMNode | null | undefined): ExtractedMention[] {
  const out: ExtractedMention[] = [];
  walk(doc ?? null, (node) => {
    if (node.type !== 'mention') return;
    const id = typeof node.attrs?.['id'] === 'string' ? (node.attrs['id'] as string) : '';
    const label = typeof node.attrs?.['label'] === 'string' ? (node.attrs['label'] as string) : '';
    const kind =
      node.attrs?.['kind'] === 'task' ? 'task' : ('user' as const);
    if (id) out.push({ kind, id, label });
  });
  return out;
}

function walk(node: PMNode | null, visit: (n: PMNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

// ---------- diff helpers ----------------------------------------------------

export interface CoarseDocDiff {
  addedBlocks: number;
  removedBlocks: number;
  oldBlockCount: number;
  newBlockCount: number;
}

/** A coarse "what changed" indicator — just the delta in top-level block
 *  counts, plus a string-identity comparison block-by-block. Good enough for
 *  the revision-history banner; a true tree diff lives on a future story. */
export function coarseBlockDiff(oldDoc: PMNode | null, newDoc: PMNode | null): CoarseDocDiff {
  const oldBlocks = (oldDoc?.content ?? []).map((b) => JSON.stringify(b));
  const newBlocks = (newDoc?.content ?? []).map((b) => JSON.stringify(b));
  const oldSet = new Set(oldBlocks);
  const newSet = new Set(newBlocks);
  let added = 0;
  let removed = 0;
  for (const b of newBlocks) if (!oldSet.has(b)) added++;
  for (const b of oldBlocks) if (!newSet.has(b)) removed++;
  return {
    addedBlocks: added,
    removedBlocks: removed,
    oldBlockCount: oldBlocks.length,
    newBlockCount: newBlocks.length,
  };
}
