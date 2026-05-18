import { describe, expect, it } from 'vitest';

import { parseChips } from './parseChips';

// =============================================================================
// parseChips — pure parser that mirrors the server-side search grammar.
// Bug-class: a key:value token that the UI fails to parse → chip never
// renders → user thinks the filter is broken. Server is authoritative on
// the actual narrowing, but a missing chip is its own UX regression.
// =============================================================================

describe('parseChips — known filter keys', () => {
  it('extracts a single bare key:value', () => {
    const { chips, remainingText } = parseChips('status:open');
    expect(chips).toEqual([{ key: 'status', value: 'open', raw: 'status:open' }]);
    expect(remainingText).toBe('');
  });

  it('lower-cases the key but preserves the value casing', () => {
    const { chips } = parseChips('Status:InProgress');
    expect(chips).toEqual([{ key: 'status', value: 'InProgress', raw: 'Status:InProgress' }]);
  });

  it('parses all five supported keys', () => {
    const { chips } = parseChips('status:open assignee:alex label:bug priority:high created:2025-01-01');
    expect(chips.map((c) => c.key).sort()).toEqual([
      'assignee',
      'created',
      'label',
      'priority',
      'status',
    ]);
  });

  it('supports quoted values for tokens containing spaces', () => {
    const { chips, remainingText } = parseChips('label:"front end" hello');
    expect(chips).toEqual([{ key: 'label', value: 'front end', raw: 'label:"front end"' }]);
    expect(remainingText).toBe('hello');
  });
});

describe('parseChips — unknown keys / free text', () => {
  it('passes unknown keys through as free text (no chip)', () => {
    const { chips, remainingText } = parseChips('foo:bar baz');
    expect(chips).toEqual([]);
    // Note: the parser intentionally does NOT strip unknown-key tokens — the
    // server treats them as free text. We assert just that no chip was
    // emitted; remainingText still contains the literal "foo:bar baz".
    expect(remainingText).toContain('foo:bar');
    expect(remainingText).toContain('baz');
  });

  it('returns an empty result for an empty input', () => {
    expect(parseChips('')).toEqual({ chips: [], remainingText: '' });
  });

  it('handles a mix of chips and free text and strips only the chip tokens', () => {
    const { chips, remainingText } = parseChips('hello status:open world priority:high');
    expect(chips).toHaveLength(2);
    expect(chips.find((c) => c.key === 'status')?.value).toBe('open');
    expect(chips.find((c) => c.key === 'priority')?.value).toBe('high');
    // Both chip tokens stripped, surrounding free text preserved (collapsed).
    expect(remainingText).toBe('hello world');
  });

  it('preserves chip raw text so the input can be edited (token-strip on dismiss)', () => {
    const { chips } = parseChips('label:"front end"');
    expect(chips[0]?.raw).toBe('label:"front end"');
  });

  it('collapses runs of whitespace introduced when chips are stripped', () => {
    const { remainingText } = parseChips('a    status:open   b');
    expect(remainingText).toBe('a b');
  });
});
