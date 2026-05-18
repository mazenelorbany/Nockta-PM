import { describe, expect, it } from 'vitest';

import {
  FormulaError,
  evaluateFormula,
  isFieldVisible,
  parseFormula,
} from './formula-evaluator';

// =============================================================================
// formula-evaluator — the security-critical surface. We test three things:
//   1. Arithmetic / references / built-ins compute the right value.
//   2. The visibility rule helper honors equals / in / isSet semantics.
//   3. Hostile inputs (prototype pollution, eval-shaped identifiers, dangling
//      tokens, runaway nesting) throw a FormulaError rather than reaching
//      JavaScript's eval surface.
// =============================================================================

function evalExpr(
  expr: string,
  vars: Record<string, unknown> = {},
): unknown {
  const ast = parseFormula(expr);
  return evaluateFormula(ast, { vars: vars as Record<string, never> });
}

describe('formula-evaluator — happy path', () => {
  it('adds two numbers', () => {
    expect(evalExpr('1 + 2')).toBe(3);
  });

  it('honors operator precedence', () => {
    expect(evalExpr('2 + 3 * 4')).toBe(14);
    expect(evalExpr('(2 + 3) * 4')).toBe(20);
  });

  it('looks up custom-field references by name', () => {
    expect(evalExpr('{estimate} * 2', { estimate: 8 })).toBe(16);
  });

  it('returns null for missing references rather than throwing', () => {
    // Round 5 audit: "missing dependency field treated as null".
    expect(evalExpr('{ghost} + 1', {})).toBeNull();
  });

  it('supports daysBetween()', () => {
    const a = '2026-01-01T00:00:00Z';
    const b = '2026-01-08T00:00:00Z';
    expect(evalExpr(`daysBetween("${a}", "${b}")`)).toBe(7);
  });

  it('now() returns an ISO string', () => {
    const ast = parseFormula('now()');
    const fixed = new Date('2026-05-16T12:00:00Z');
    const got = evaluateFormula(ast, { vars: {}, now: () => fixed });
    expect(got).toBe('2026-05-16T12:00:00.000Z');
  });

  it('if() picks the correct branch', () => {
    expect(evalExpr('if(true, 1, 2)')).toBe(1);
    expect(evalExpr('if(false, 1, 2)')).toBe(2);
    expect(evalExpr('if({estimate} > 5, "big", "small")', { estimate: 8 })).toBe(
      'big',
    );
  });

  it('sum / min / max / avg over array literals', () => {
    expect(evalExpr('sum([1, 2, 3, 4])')).toBe(10);
    expect(evalExpr('min([3, 1, 2])')).toBe(1);
    expect(evalExpr('max([3, 1, 2])')).toBe(3);
    expect(evalExpr('avg([2, 4, 6])')).toBe(4);
  });

  it('sum nests through a reference that holds an array', () => {
    expect(evalExpr('sum({xs})', { xs: [1, 2, 3] })).toBe(6);
  });

  it('treats null entries as missing in aggregates', () => {
    expect(evalExpr('sum([1, null, 2])')).toBe(3);
    expect(evalExpr('count([1, null, 2, null])')).toBe(2);
  });

  it('string concat via + when either side is a string', () => {
    expect(evalExpr('"hello, " + {name}', { name: 'world' })).toBe(
      'hello, world',
    );
  });

  it('handles boolean operators with short-circuit', () => {
    expect(evalExpr('{a} && {b}', { a: true, b: false })).toBe(false);
    expect(evalExpr('{a} || {b}', { a: false, b: 'fallback' })).toBe('fallback');
  });

  it('divides safely — divide-by-zero returns null, not Infinity', () => {
    expect(evalExpr('1 / 0')).toBeNull();
  });
});

describe('formula-evaluator — security boundary', () => {
  it('rejects __proto__ as a function call', () => {
    expect(() => evalExpr('__proto__()')).toThrow(FormulaError);
  });

  it('rejects constructor as a function call', () => {
    expect(() => evalExpr('constructor()')).toThrow(FormulaError);
  });

  it('rejects Function as a function call', () => {
    expect(() => evalExpr('Function("return 1")()')).toThrow(FormulaError);
  });

  it('rejects eval()', () => {
    expect(() => evalExpr('eval("1")')).toThrow(FormulaError);
  });

  it('rejects __proto__ as a field reference', () => {
    expect(() => evalExpr('{__proto__}')).toThrow(/Forbidden identifier/);
  });

  it('rejects globalThis as a function call', () => {
    expect(() => evalExpr('globalThis()')).toThrow(FormulaError);
  });

  it('rejects a bare identifier without parentheses', () => {
    // `now` without `()` is suspicious — could be a leak attempt. Force ().
    expect(() => evalExpr('now + 1')).toThrow(/Bare identifier/);
  });

  it('rejects trailing tokens', () => {
    expect(() => evalExpr('1 + 2 garbage')).toThrow(FormulaError);
  });

  it('rejects unterminated strings', () => {
    expect(() => evalExpr('"oops')).toThrow(/Unterminated string/);
  });

  it('rejects invalid escapes', () => {
    expect(() => evalExpr('"\\x"')).toThrow(/Invalid escape/);
  });

  it('rejects unknown function names', () => {
    expect(() => evalExpr('require("fs")')).toThrow(/Unknown function/);
  });

  it('rejects pathologically long input', () => {
    const huge = `1${' + 1'.repeat(2000)}`;
    expect(() => evalExpr(huge)).toThrow(/too long|too complex/);
  });

  it('rejects empty input', () => {
    expect(() => parseFormula('')).toThrow(/empty/);
    expect(() => parseFormula('   ')).toThrow(/empty/);
  });

  it('does NOT walk the prototype chain when reading a missing var', () => {
    // Object.prototype.toString exists on every plain object — a sloppy
    // lookup with `vars[name]` would happily return [Function: toString].
    // We expect null instead.
    expect(evalExpr('{toString}', {})).toBeNull();
    expect(evalExpr('{hasOwnProperty}', {})).toBeNull();
  });
});

describe('formula-evaluator — built-ins edge cases', () => {
  it('round / floor / ceil / abs', () => {
    expect(evalExpr('round(1.5)')).toBe(2);
    expect(evalExpr('floor(1.9)')).toBe(1);
    expect(evalExpr('ceil(1.1)')).toBe(2);
    expect(evalExpr('abs(-7)')).toBe(7);
  });

  it('len() of string and array', () => {
    expect(evalExpr('len("hello")')).toBe(5);
    expect(evalExpr('len({xs})', { xs: [1, 2, 3] })).toBe(3);
  });

  it('concat() joins strings, treating null as empty', () => {
    expect(evalExpr('concat("a", "b", "c")')).toBe('abc');
    expect(evalExpr('concat({n})', { n: null })).toBe('');
  });

  it('avg of an empty array is null', () => {
    expect(evalExpr('avg([])')).toBeNull();
  });

  it('sum of empty is 0 (Excel-style)', () => {
    expect(evalExpr('sum([])')).toBe(0);
  });
});

describe('isFieldVisible', () => {
  it('null rule means always visible', () => {
    expect(isFieldVisible(null, {})).toBe(true);
    expect(isFieldVisible(undefined, {})).toBe(true);
  });

  it('equals op', () => {
    const rule = { when: { fieldKey: 'status', op: 'equals' as const, value: 'open' } };
    expect(isFieldVisible(rule, { status: 'open' })).toBe(true);
    expect(isFieldVisible(rule, { status: 'closed' })).toBe(false);
  });

  it('in op', () => {
    const rule = { when: { fieldKey: 'tier', op: 'in' as const, value: ['gold', 'platinum'] } };
    expect(isFieldVisible(rule, { tier: 'gold' })).toBe(true);
    expect(isFieldVisible(rule, { tier: 'silver' })).toBe(false);
  });

  it('isSet op', () => {
    const rule = { when: { fieldKey: 'note', op: 'isSet' as const } };
    expect(isFieldVisible(rule, { note: 'hi' })).toBe(true);
    expect(isFieldVisible(rule, { note: null })).toBe(false);
    expect(isFieldVisible(rule, { note: '' })).toBe(false);
    expect(isFieldVisible(rule, {})).toBe(false);
  });

  it('missing dependency reads as null', () => {
    const rule = { when: { fieldKey: 'absent', op: 'equals' as const, value: null } };
    expect(isFieldVisible(rule, {})).toBe(true); // null equals null
  });
});
