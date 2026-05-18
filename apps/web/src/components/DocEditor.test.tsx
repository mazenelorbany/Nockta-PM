import { describe, expect, it } from 'vitest';

import {
  extractMentions,
  markdownToProseMirrorJson,
  proseMirrorJsonToMarkdown,
  type PMDoc,
} from './prosemirror-markdown';

// =============================================================================
// DocEditor schema tests — these are pure serialization tests on the
// markdown <-> ProseMirror JSON helpers. We deliberately do NOT render the
// React component here: vitest.config.ts is Node-only (no jsdom) and adding
// a DOM environment just to assert that "bold survives" would push the test
// surface much wider than the bug class we care about (round-trip preserves
// the doc's meaning). When the component itself gains behavior worth
// asserting (e.g. mention picker logic), it'll get its own jsdom-flagged
// test file.
// =============================================================================

describe('proseMirror <-> markdown round-trip', () => {
  it('preserves headings, paragraphs, bullets, and code blocks', () => {
    const md = [
      '# Project goals',
      '',
      'We are building **Nockta** to ship faster.',
      '',
      '## Milestones',
      '',
      '- Ship the editor',
      '- Wire mentions',
      '- Ship to prod',
      '',
      '```ts',
      "console.log('hello');",
      '```',
    ].join('\n');

    const json = markdownToProseMirrorJson(md);
    const back = proseMirrorJsonToMarkdown(json);

    expect(back).toContain('# Project goals');
    expect(back).toContain('## Milestones');
    expect(back).toContain('- Ship the editor');
    expect(back).toContain('- Wire mentions');
    expect(back).toContain('```ts');
    expect(back).toContain("console.log('hello');");
    expect(back).toContain('**Nockta**');
  });

  it('round-trips ordered lists and task lists with their state', () => {
    const md = [
      '1. First',
      '2. Second',
      '',
      '- [ ] Open',
      '- [x] Closed',
    ].join('\n');

    const json = markdownToProseMirrorJson(md);
    const back = proseMirrorJsonToMarkdown(json);

    expect(back).toContain('1. First');
    expect(back).toContain('2. Second');
    expect(back).toContain('- [ ] Open');
    expect(back).toContain('- [x] Closed');
  });

  it('produces a single empty paragraph for an empty markdown input', () => {
    const json = markdownToProseMirrorJson('');
    expect(json.type).toBe('doc');
    expect(json.content?.length ?? 0).toBe(1);
    expect(json.content?.[0]?.type).toBe('paragraph');
  });

  it('serializes empty docs to empty markdown', () => {
    const empty: PMDoc = {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    };
    // An empty paragraph renders to '' (no marker, no text). Whitespace is
    // trimmed by the serializer's final .trim() so callers get a clean
    // empty string for storage / FTS.
    expect(proseMirrorJsonToMarkdown(empty)).toBe('');
  });
});

describe('extractMentions', () => {
  it('returns user and task mentions with their ids and kinds', () => {
    const doc: PMDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Assigning ' },
            {
              type: 'mention',
              attrs: { id: 'user-alice', label: 'Alice', kind: 'user' },
            },
            { type: 'text', text: ' to ' },
            {
              type: 'mention',
              attrs: { id: 'task-42', label: 'NOCK-42', kind: 'task' },
            },
            { type: 'text', text: ' for the spec.' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'cc ' },
            {
              type: 'mention',
              attrs: { id: 'user-bob', label: 'Bob', kind: 'user' },
            },
          ],
        },
      ],
    };

    const mentions = extractMentions(doc);
    expect(mentions).toEqual([
      { kind: 'user', id: 'user-alice', label: 'Alice' },
      { kind: 'task', id: 'task-42', label: 'NOCK-42' },
      { kind: 'user', id: 'user-bob', label: 'Bob' },
    ]);

    // Pull out the typed ids the way a consumer (e.g. the notification
    // dispatcher) would — confirms the helper is good enough for that path.
    const userIds = mentions.filter((m) => m.kind === 'user').map((m) => m.id);
    const taskIds = mentions.filter((m) => m.kind === 'task').map((m) => m.id);
    expect(userIds).toEqual(['user-alice', 'user-bob']);
    expect(taskIds).toEqual(['task-42']);
  });

  it('returns an empty array when there are no mentions', () => {
    const doc: PMDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Plain prose only.' }],
        },
      ],
    };
    expect(extractMentions(doc)).toEqual([]);
  });

  it('skips mention nodes that are missing an id (defensive)', () => {
    const doc: PMDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            // No `id` attr — corrupted state we shouldn't crash on.
            { type: 'mention', attrs: { label: 'Ghost', kind: 'user' } },
          ],
        },
      ],
    };
    expect(extractMentions(doc)).toEqual([]);
  });
});
