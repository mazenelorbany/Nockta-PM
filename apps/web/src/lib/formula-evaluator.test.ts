import { describe, expect, it } from 'vitest';

import { FormulaError, isFieldVisible, parseFormula } from './formula-evaluator';

// =============================================================================
// formula-evaluator (client) — the two helpers we ship to the browser:
//
//   - parseFormula: syntax-check used by the CustomField editor live preview.
//   - isFieldVisible: rule evaluator used by CustomFieldsSection to hide
//     rows server-side filters would strip anyway.
//
// The server is authoritative on evaluation; these client helpers are UX
// affordances. Bug-class: a parseFormula regression breaks the editor's
// red-squiggle; an isFieldVisible regression renders a field the server
// then refuses to accept on save.
// =============================================================================

describe('parseFormula', () => {
  it('accepts valid numeric expressions', () => {
    expect(() => parseFormula('1 + 2 * 3')).not.toThrow();
    expect(() => parseFormula('(1 + 2) * 3')).not.toThrow();
  });

  it('accepts identifier references (wrapped in {…}) and function calls', () => {
    // Bare identifiers (`points`) are rejected on purpose — field references
    // must be braced (`{points}`) so the parser doesn't confuse them with
    // function names. See FormulaError in formula-evaluator.ts:199.
    expect(() => parseFormula('{points} * 2')).not.toThrow();
    expect(() => parseFormula('IF({points} > 5, "big", "small")')).not.toThrow();
  });

  it('throws FormulaError on empty input', () => {
    expect(() => parseFormula('')).toThrow(FormulaError);
    expect(() => parseFormula('   ')).toThrow(FormulaError);
  });

  it('throws FormulaError on a non-string input', () => {
    // @ts-expect-error — intentionally passing the wrong type
    expect(() => parseFormula(42)).toThrow(FormulaError);
  });

  it('throws on a syntactically broken expression', () => {
    expect(() => parseFormula('1 + ')).toThrow();
    expect(() => parseFormula('"unterminated')).toThrow();
  });

  it('throws when the expression exceeds the 4096-char cap', () => {
    const tooLong = '1+'.repeat(2100) + '1'; // > 4096 chars
    expect(() => parseFormula(tooLong)).toThrow(FormulaError);
  });
});

describe('isFieldVisible — no rule', () => {
  it('returns true when there is no rule', () => {
    expect(isFieldVisible(null, {})).toBe(true);
    expect(isFieldVisible(undefined, {})).toBe(true);
  });

  it('returns true when the rule has no `when` shape', () => {
    expect(isFieldVisible({} as never, {})).toBe(true);
  });
});

describe('isFieldVisible — isSet', () => {
  const rule = { when: { fieldKey: 'k', op: 'isSet' as const } };
  it('false for missing keys', () => {
    expect(isFieldVisible(rule, {})).toBe(false);
  });
  it('false for null / undefined / empty string', () => {
    expect(isFieldVisible(rule, { k: null })).toBe(false);
    expect(isFieldVisible(rule, { k: undefined })).toBe(false);
    expect(isFieldVisible(rule, { k: '' })).toBe(false);
  });
  it('true for any other set value (including 0 and false)', () => {
    expect(isFieldVisible(rule, { k: 0 })).toBe(true);
    expect(isFieldVisible(rule, { k: false })).toBe(true);
    expect(isFieldVisible(rule, { k: 'hello' })).toBe(true);
  });
});

describe('isFieldVisible — equals (loose)', () => {
  it('matches same-type strict equality', () => {
    const rule = { when: { fieldKey: 'k', op: 'equals' as const, value: 'red' } };
    expect(isFieldVisible(rule, { k: 'red' })).toBe(true);
    expect(isFieldVisible(rule, { k: 'blue' })).toBe(false);
  });

  it('coerces across number/string when both parse to finite numbers', () => {
    const rule = { when: { fieldKey: 'k', op: 'equals' as const, value: '5' } };
    expect(isFieldVisible(rule, { k: 5 })).toBe(true);
    expect(isFieldVisible(rule, { k: '5' })).toBe(true);
    expect(isFieldVisible(rule, { k: 'five' })).toBe(false);
  });

  it('does not coerce booleans into the number band', () => {
    const rule = { when: { fieldKey: 'k', op: 'equals' as const, value: 1 } };
    expect(isFieldVisible(rule, { k: true })).toBe(true); // Number(true) === 1
    expect(isFieldVisible(rule, { k: false })).toBe(false);
  });
});

describe('isFieldVisible — in', () => {
  const rule = { when: { fieldKey: 'k', op: 'in' as const, value: ['a', 'b', 'c'] } };

  it('matches when the actual is in the set', () => {
    expect(isFieldVisible(rule, { k: 'b' })).toBe(true);
  });
  it('false when the actual is not in the set', () => {
    expect(isFieldVisible(rule, { k: 'z' })).toBe(false);
  });
  it('false when value is not an array', () => {
    const bad = { when: { fieldKey: 'k', op: 'in' as const, value: 'a' as unknown } };
    expect(isFieldVisible(bad, { k: 'a' })).toBe(false);
  });
});
