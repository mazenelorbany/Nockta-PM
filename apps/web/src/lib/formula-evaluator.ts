// =============================================================================
// formula-evaluator (client-side mirror)
//
// KNOWN SMELL — DUPLICATED FROM apps/api/src/modules/custom-fields/
// formula-evaluator.ts. We did NOT extract a shared `packages/formulas/`
// package because the project does not yet have a monorepo `packages/`
// directory wired into the web build (`apps/web/vite.config.ts` doesn't
// resolve workspace packages outside @nockta/ui). Standing one up was
// judged out of scope for Round 6 / Pass C; the duplication is small
// (~250 lines), parser logic is mature, and the bigger risk is the
// extraction blocking shipping. Action item: shared package in Round 7.
//
// CLIENT USES ONLY THESE TWO HELPERS:
//   - parseFormula(expression) — used by the editor for "live syntax check"
//   - isFieldVisible(rule, vars) — used by CustomFieldsSection to honor
//     the visibility rule client-side without a round-trip
//
// Everything else (evaluateFormula + built-ins) is intentionally omitted —
// the server is still the source of truth for formula values; the client
// never independently computes them. Keeping the client surface minimal
// shrinks the bundle and the maintenance burden.
// =============================================================================

export type FormulaValue = number | string | boolean | null | FormulaValue[];

export interface VisibilityRule {
  when: {
    fieldKey: string;
    op: 'equals' | 'in' | 'isSet';
    value?: unknown;
  };
}

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

// ---------- Tokenizer ----------

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'punct'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  const isDigit = (c: string): boolean => c >= '0' && c <= '9';
  const isAlpha = (c: string): boolean =>
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isAlphaNum = (c: string): boolean => isAlpha(c) || isDigit(c);
  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(input[i + 1] ?? ''))) {
      let j = i;
      let sawDot = false;
      while (j < n && (isDigit(input[j]) || (!sawDot && input[j] === '.'))) {
        if (input[j] === '.') sawDot = true;
        j++;
      }
      tokens.push({ type: 'num', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && input[j] !== '"') {
        if (input[j] === '\\') {
          const next = input[j + 1];
          if (next === '\\') out += '\\';
          else if (next === '"') out += '"';
          else if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else throw new FormulaError(`Invalid escape \\${next ?? ''}`);
          j += 2;
        } else {
          out += input[j];
          j++;
        }
      }
      if (j >= n) throw new FormulaError('Unterminated string literal');
      tokens.push({ type: 'str', value: out });
      i = j + 1;
      continue;
    }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && isAlphaNum(input[j])) j++;
      tokens.push({ type: 'ident', value: input.slice(i, j) });
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||'
    ) {
      tokens.push({ type: 'punct', value: two });
      i += 2;
      continue;
    }
    if (
      '+-*/(){}[],<>!'.includes(c)
    ) {
      tokens.push({ type: 'punct', value: c });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character: ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ---------- Parser (recursive descent) ----------
// Light AST — we only need parsing for editor validation; the client never
// evaluates these. So we don't export the AST nodes, only a "did it parse"
// boolean via parseFormula throwing on error.

type Node = unknown;

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseOr();
    if (this.pos !== this.tokens.length) {
      const tok = this.tokens[this.pos];
      throw new FormulaError(
        `Unexpected trailing token: ${JSON.stringify(tok.value)}`,
      );
    }
    return node;
  }

  private parseOr(): Node {
    let l = this.parseAnd();
    while (this.peekPunct('||')) { this.pos++; l = { l, r: this.parseAnd() }; }
    return l;
  }
  private parseAnd(): Node {
    let l = this.parseEq();
    while (this.peekPunct('&&')) { this.pos++; l = { l, r: this.parseEq() }; }
    return l;
  }
  private parseEq(): Node {
    let l = this.parseCmp();
    while (this.peekPunct('==') || this.peekPunct('!=')) { this.pos++; l = { l, r: this.parseCmp() }; }
    return l;
  }
  private parseCmp(): Node {
    let l = this.parseAdd();
    while (
      this.peekPunct('<') || this.peekPunct('<=') ||
      this.peekPunct('>') || this.peekPunct('>=')
    ) { this.pos++; l = { l, r: this.parseAdd() }; }
    return l;
  }
  private parseAdd(): Node {
    let l = this.parseMul();
    while (this.peekPunct('+') || this.peekPunct('-')) { this.pos++; l = { l, r: this.parseMul() }; }
    return l;
  }
  private parseMul(): Node {
    let l = this.parseUnary();
    while (this.peekPunct('*') || this.peekPunct('/')) { this.pos++; l = { l, r: this.parseUnary() }; }
    return l;
  }
  private parseUnary(): Node {
    if (this.peekPunct('-') || this.peekPunct('!')) { this.pos++; return this.parseUnary(); }
    return this.parsePrimary();
  }
  private parsePrimary(): Node {
    const tok = this.tokens[this.pos];
    if (!tok) throw new FormulaError('Unexpected end of expression');
    if (tok.type === 'num' || tok.type === 'str') { this.pos++; return tok; }
    if (tok.type === 'ident') {
      if (tok.value === 'true' || tok.value === 'false' || tok.value === 'null') {
        this.pos++;
        return tok;
      }
      this.pos++;
      if (!this.peekPunct('(')) {
        throw new FormulaError(
          `Bare identifier ${JSON.stringify(tok.value)} — call as ${tok.value}() or wrap a field reference in {…}`,
        );
      }
      this.pos++;
      if (!this.peekPunct(')')) {
        this.parseOr();
        while (this.peekPunct(',')) { this.pos++; this.parseOr(); }
      }
      this.expectPunct(')');
      return tok;
    }
    if (tok.type === 'punct' && tok.value === '{') {
      this.pos++;
      const ident = this.tokens[this.pos];
      if (!ident || ident.type !== 'ident') {
        throw new FormulaError('Expected field name inside `{ }`');
      }
      this.pos++;
      this.expectPunct('}');
      return ident;
    }
    if (tok.type === 'punct' && tok.value === '[') {
      this.pos++;
      if (!this.peekPunct(']')) {
        this.parseOr();
        while (this.peekPunct(',')) { this.pos++; this.parseOr(); }
      }
      this.expectPunct(']');
      return tok;
    }
    if (tok.type === 'punct' && tok.value === '(') {
      this.pos++;
      const inner = this.parseOr();
      this.expectPunct(')');
      return inner;
    }
    throw new FormulaError(`Unexpected token: ${JSON.stringify(tok.value)}`);
  }

  private peekPunct(p: string): boolean {
    const t = this.tokens[this.pos];
    return !!t && t.type === 'punct' && t.value === p;
  }
  private expectPunct(p: string): void {
    if (!this.peekPunct(p)) {
      const t = this.tokens[this.pos];
      throw new FormulaError(
        `Expected ${JSON.stringify(p)}, got ${t ? JSON.stringify(t.value) : 'end of input'}`,
      );
    }
    this.pos++;
  }
}

/**
 * Throws FormulaError on syntax issues. Returns void on success — the
 * client doesn't keep the parsed AST around; we only use the parser for
 * the editor's "is this still valid?" indicator.
 */
export function parseFormula(expression: string): void {
  if (typeof expression !== 'string') throw new FormulaError('Formula must be a string');
  if (expression.trim() === '') throw new FormulaError('Formula is empty');
  if (expression.length > 4096) throw new FormulaError('Formula too long (max 4096 chars)');
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new FormulaError('Formula is empty');
  if (tokens.length > 1024) throw new FormulaError('Formula too complex (max 1024 tokens)');
  new Parser(tokens).parse();
}

// ---------- Visibility rule (mirror of server logic) ----------
// We DO evaluate this client-side. The server STILL filters too (defense
// in depth — a hidden field's value must not leak through the response).
// The client check just avoids rendering a row whose value the server
// would have stripped anyway, so the editor list looks right.

function looseEq(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a === typeof b) return a === b;
  const an = Number(a);
  const bn = Number(b);
  return Number.isFinite(an) && Number.isFinite(bn) && an === bn;
}

export function isFieldVisible(
  rule: VisibilityRule | null | undefined,
  vars: Record<string, unknown>,
): boolean {
  if (!rule || !rule.when) return true;
  const { fieldKey, op, value } = rule.when;
  if (typeof fieldKey !== 'string') return true;
  const actual = Object.prototype.hasOwnProperty.call(vars, fieldKey)
    ? vars[fieldKey]
    : null;
  switch (op) {
    case 'isSet':
      return actual !== null && actual !== undefined && actual !== '';
    case 'equals':
      return looseEq(actual, value);
    case 'in':
      if (!Array.isArray(value)) return false;
      return (value as unknown[]).some((v) => looseEq(actual, v));
    default:
      return true;
  }
}
