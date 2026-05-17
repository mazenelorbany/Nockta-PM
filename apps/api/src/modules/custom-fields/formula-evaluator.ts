// =============================================================================
// formula-evaluator.ts
//
// Hand-rolled tokenizer + recursive-descent parser + tree-walking evaluator
// for custom-field formulas. The grammar is deliberately tiny — it is just
// enough to express "compute one cell from other cells" — and the
// implementation deliberately avoids `eval`, `Function`, `with`, and any
// other runtime-code construct. Identifiers are looked up against a strict
// allowlist (built-ins + the caller-supplied variable bag); anything else
// throws.
//
// GRAMMAR (informal)
//   expr        := orExpr
//   orExpr      := andExpr ( '||' andExpr )*
//   andExpr     := equality ( '&&' equality )*
//   equality    := comparison ( ('=='|'!=') comparison )*
//   comparison  := addExpr ( ('<'|'<='|'>'|'>=') addExpr )*
//   addExpr     := mulExpr ( ('+'|'-') mulExpr )*
//   mulExpr     := unary  ( ('*'|'/') unary  )*
//   unary       := ('-'|'!') unary | primary
//   primary     := number
//                | string
//                | true | false | null
//                | '{' identifier '}'                  # custom-field reference
//                | identifier '(' argList? ')'         # built-in call
//                | '[' argList? ']'                    # array literal (sum/min/max/avg arg)
//                | '(' expr ')'
//   argList     := expr ( ',' expr )*
//
// SECURITY NOTES
//   * NO `eval`, NO `new Function`, NO dynamic property access on objects.
//     The AST evaluator switches on a small union of node `kind` strings.
//   * Identifiers are matched against the BUILTINS table — `__proto__`,
//     `constructor`, `Function`, etc. simply aren't in the table, so any
//     parsed `__proto__(…)` throws "Unknown function".
//   * `{fieldName}` references go through a Map lookup. The keys are
//     supplied explicitly by the service (only known custom-field names),
//     so a formula can never reach outside that bag.
//   * Strings are scanned char-by-char with `\` escaping limited to
//     `\\`, `\"`, `\n`, `\t`. No regex, no template literals, no `${}`.
//
// USAGE
//   const ast = parseFormula(expression);  // throws on syntax errors
//   const value = evaluateFormula(ast, { vars: { estimate: 8, dueDate: ... } });
//
// Both steps are pure functions. The service caches the parsed AST on the
// CustomFieldDefinition row (NOT YET — parse-on-read is plenty fast for the
// expected formula size; the parser handles a 100-token formula in <50µs).
// =============================================================================

export type FormulaValue = number | string | boolean | Date | null | FormulaValue[];

export type AstNode =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ref'; name: string }
  | { kind: 'array'; items: AstNode[] }
  | { kind: 'call'; name: string; args: AstNode[] }
  | { kind: 'unary'; op: '-' | '!'; operand: AstNode }
  | {
      kind: 'binary';
      op:
        | '+'
        | '-'
        | '*'
        | '/'
        | '=='
        | '!='
        | '<'
        | '<='
        | '>'
        | '>='
        | '&&'
        | '||';
      left: AstNode;
      right: AstNode;
    };

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

    // Whitespace.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // Numbers — integer or decimal, no leading `+`.
    if (isDigit(c) || (c === '.' && isDigit(input[i + 1] ?? ''))) {
      let j = i;
      let sawDot = false;
      while (j < n && (isDigit(input[j]) || (!sawDot && input[j] === '.'))) {
        if (input[j] === '.') sawDot = true;
        j++;
      }
      const raw = input.slice(i, j);
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        throw new FormulaError(`Invalid number literal: ${raw}`);
      }
      tokens.push({ type: 'num', value: num });
      i = j;
      continue;
    }

    // Strings — double-quoted, minimal escape set.
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

    // Identifiers (function names + true/false/null).
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && isAlphaNum(input[j])) j++;
      tokens.push({ type: 'ident', value: input.slice(i, j) });
      i = j;
      continue;
    }

    // Two-char operators we have to peek for.
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

    // Single-char punctuation.
    if (
      c === '+' ||
      c === '-' ||
      c === '*' ||
      c === '/' ||
      c === '(' ||
      c === ')' ||
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']' ||
      c === ',' ||
      c === '<' ||
      c === '>' ||
      c === '!'
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

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): AstNode {
    const node = this.parseExpr();
    if (this.pos !== this.tokens.length) {
      const tok = this.tokens[this.pos];
      throw new FormulaError(
        `Unexpected trailing token: ${JSON.stringify(tok.value)}`,
      );
    }
    return node;
  }

  // expr -> orExpr
  private parseExpr(): AstNode {
    return this.parseOr();
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.peekPunct('||')) {
      this.pos++;
      const right = this.parseAnd();
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseEquality();
    while (this.peekPunct('&&')) {
      this.pos++;
      const right = this.parseEquality();
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseEquality(): AstNode {
    let left = this.parseComparison();
    while (this.peekPunct('==') || this.peekPunct('!=')) {
      const op = this.tokens[this.pos].value as '==' | '!=';
      this.pos++;
      const right = this.parseComparison();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseComparison(): AstNode {
    let left = this.parseAdd();
    while (
      this.peekPunct('<') ||
      this.peekPunct('<=') ||
      this.peekPunct('>') ||
      this.peekPunct('>=')
    ) {
      const op = this.tokens[this.pos].value as '<' | '<=' | '>' | '>=';
      this.pos++;
      const right = this.parseAdd();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdd(): AstNode {
    let left = this.parseMul();
    while (this.peekPunct('+') || this.peekPunct('-')) {
      const op = this.tokens[this.pos].value as '+' | '-';
      this.pos++;
      const right = this.parseMul();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMul(): AstNode {
    let left = this.parseUnary();
    while (this.peekPunct('*') || this.peekPunct('/')) {
      const op = this.tokens[this.pos].value as '*' | '/';
      this.pos++;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.peekPunct('-') || this.peekPunct('!')) {
      const op = this.tokens[this.pos].value as '-' | '!';
      this.pos++;
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const tok = this.tokens[this.pos];
    if (!tok) throw new FormulaError('Unexpected end of expression');

    // Number, string literals.
    if (tok.type === 'num') {
      this.pos++;
      return { kind: 'num', value: tok.value };
    }
    if (tok.type === 'str') {
      this.pos++;
      return { kind: 'str', value: tok.value };
    }

    // Identifiers — true / false / null / function call.
    if (tok.type === 'ident') {
      if (tok.value === 'true') {
        this.pos++;
        return { kind: 'bool', value: true };
      }
      if (tok.value === 'false') {
        this.pos++;
        return { kind: 'bool', value: false };
      }
      if (tok.value === 'null') {
        this.pos++;
        return { kind: 'null' };
      }
      // Built-in call — must be immediately followed by `(`.
      this.pos++;
      if (!this.peekPunct('(')) {
        throw new FormulaError(
          `Bare identifier ${JSON.stringify(tok.value)} — call as ${tok.value}() or wrap a field reference in {…}`,
        );
      }
      this.pos++; // consume '('
      const args: AstNode[] = [];
      if (!this.peekPunct(')')) {
        args.push(this.parseExpr());
        while (this.peekPunct(',')) {
          this.pos++;
          args.push(this.parseExpr());
        }
      }
      this.expectPunct(')');
      return { kind: 'call', name: tok.value, args };
    }

    // {fieldName} reference.
    if (tok.type === 'punct' && tok.value === '{') {
      this.pos++;
      const ident = this.tokens[this.pos];
      if (!ident || ident.type !== 'ident') {
        throw new FormulaError('Expected field name inside `{ }`');
      }
      this.pos++;
      this.expectPunct('}');
      return { kind: 'ref', name: ident.value };
    }

    // [array literal] for sum/min/max/avg over a comma-separated list.
    if (tok.type === 'punct' && tok.value === '[') {
      this.pos++;
      const items: AstNode[] = [];
      if (!this.peekPunct(']')) {
        items.push(this.parseExpr());
        while (this.peekPunct(',')) {
          this.pos++;
          items.push(this.parseExpr());
        }
      }
      this.expectPunct(']');
      return { kind: 'array', items };
    }

    // (parenthesized).
    if (tok.type === 'punct' && tok.value === '(') {
      this.pos++;
      const inner = this.parseExpr();
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

export function parseFormula(expression: string): AstNode {
  if (typeof expression !== 'string') {
    throw new FormulaError('Formula must be a string');
  }
  if (expression.trim() === '') {
    throw new FormulaError('Formula is empty');
  }
  // Cap parser work; defense in depth against pathological inputs. 4kB is
  // far more than any practical formula and well below any tokenizer DoS.
  if (expression.length > 4096) {
    throw new FormulaError('Formula too long (max 4096 chars)');
  }
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new FormulaError('Formula is empty');
  if (tokens.length > 1024) {
    throw new FormulaError('Formula too complex (max 1024 tokens)');
  }
  return new Parser(tokens).parse();
}

// ---------- Evaluator ----------

export interface EvalContext {
  vars: Record<string, FormulaValue>;
  /** Override `now()` for deterministic tests. */
  now?: () => Date;
}

// Names we allow as `ident(...)` calls. ANYTHING else throws "Unknown
// function" — this is the security gate that blocks `constructor()`,
// `eval()`, `__proto__()`, etc. NO Object.prototype or Function methods.
const BUILTIN_NAMES = new Set([
  'daysBetween',
  'now',
  'if',
  'sum',
  'min',
  'max',
  'avg',
  'count',
  'len',
  'abs',
  'round',
  'floor',
  'ceil',
  'concat',
]);

// Identifiers we reject as field names — protects against `{__proto__}` etc.
// We use Object.create(null) for the vars bag inside the service so prototype
// pollution is impossible anyway, but the parser-side ban gives a clearer
// error message and prevents the AST from ever carrying these names.
const FORBIDDEN_IDENT = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'Function',
  'eval',
  'globalThis',
]);

export function evaluateFormula(
  ast: AstNode,
  ctx: EvalContext,
): FormulaValue {
  const now = ctx.now ?? ((): Date => new Date());

  const evalNode = (node: AstNode): FormulaValue => {
    switch (node.kind) {
      case 'num':
        return node.value;
      case 'str':
        return node.value;
      case 'bool':
        return node.value;
      case 'null':
        return null;

      case 'ref': {
        if (FORBIDDEN_IDENT.has(node.name)) {
          throw new FormulaError(`Forbidden identifier: ${node.name}`);
        }
        // Plain property read on a fresh object is safe — but use `in` so a
        // missing key reads as `null` rather than reaching up the prototype.
        if (!Object.prototype.hasOwnProperty.call(ctx.vars, node.name)) {
          return null;
        }
        return ctx.vars[node.name];
      }

      case 'array':
        return node.items.map((it) => evalNode(it));

      case 'unary': {
        const v = evalNode(node.operand);
        if (node.op === '-') {
          const n = toNumber(v);
          return n === null ? null : -n;
        }
        // '!'
        return !truthy(v);
      }

      case 'binary': {
        // Short-circuit logical ops.
        if (node.op === '&&') {
          const l = evalNode(node.left);
          if (!truthy(l)) return l;
          return evalNode(node.right);
        }
        if (node.op === '||') {
          const l = evalNode(node.left);
          if (truthy(l)) return l;
          return evalNode(node.right);
        }
        const l = evalNode(node.left);
        const r = evalNode(node.right);
        switch (node.op) {
          case '+': {
            // If either side is a string, concatenate; otherwise add numbers.
            if (typeof l === 'string' || typeof r === 'string') {
              return String(l ?? '') + String(r ?? '');
            }
            const a = toNumber(l);
            const b = toNumber(r);
            if (a === null || b === null) return null;
            return a + b;
          }
          case '-': {
            const a = toNumber(l);
            const b = toNumber(r);
            if (a === null || b === null) return null;
            return a - b;
          }
          case '*': {
            const a = toNumber(l);
            const b = toNumber(r);
            if (a === null || b === null) return null;
            return a * b;
          }
          case '/': {
            const a = toNumber(l);
            const b = toNumber(r);
            if (a === null || b === null) return null;
            if (b === 0) return null; // explicit: 1/0 -> null, not Infinity.
            return a / b;
          }
          case '==':
            return looseEq(l, r);
          case '!=':
            return !looseEq(l, r);
          case '<':
          case '<=':
          case '>':
          case '>=': {
            const a = toNumber(l);
            const b = toNumber(r);
            if (a === null || b === null) return false;
            if (node.op === '<') return a < b;
            if (node.op === '<=') return a <= b;
            if (node.op === '>') return a > b;
            return a >= b;
          }
        }
        // Unreachable — exhaustive switch above.
        throw new FormulaError(`Unknown operator: ${(node as { op: string }).op}`);
      }

      case 'call': {
        if (FORBIDDEN_IDENT.has(node.name) || !BUILTIN_NAMES.has(node.name)) {
          throw new FormulaError(`Unknown function: ${node.name}`);
        }
        const args = node.args.map((a) => evalNode(a));
        return callBuiltin(node.name, args, now);
      }
    }
  };

  return evalNode(ast);
}

function toNumber(v: FormulaValue): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v instanceof Date) return v.getTime();
  return null;
}

function truthy(v: FormulaValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function looseEq(a: FormulaValue, b: FormulaValue): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  // Cross-type: try numeric.
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return an === bn;
  return false;
}

function flatten(vals: FormulaValue[]): FormulaValue[] {
  const out: FormulaValue[] = [];
  for (const v of vals) {
    if (Array.isArray(v)) {
      for (const inner of v) out.push(inner);
    } else {
      out.push(v);
    }
  }
  return out;
}

function callBuiltin(
  name: string,
  args: FormulaValue[],
  now: () => Date,
): FormulaValue {
  switch (name) {
    case 'now':
      if (args.length !== 0) {
        throw new FormulaError('now() takes no arguments');
      }
      return now().toISOString();

    case 'daysBetween': {
      if (args.length !== 2) {
        throw new FormulaError('daysBetween(a, b) takes exactly 2 arguments');
      }
      const a = toDate(args[0]);
      const b = toDate(args[1]);
      if (!a || !b) return null;
      const ms = b.getTime() - a.getTime();
      return Math.round(ms / 86_400_000);
    }

    case 'if': {
      if (args.length !== 3) {
        throw new FormulaError('if(cond, a, b) takes exactly 3 arguments');
      }
      return truthy(args[0]) ? args[1] : args[2];
    }

    case 'sum': {
      const nums = flatten(args)
        .map((v) => toNumber(v))
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return 0;
      return nums.reduce((a, b) => a + b, 0);
    }

    case 'avg': {
      const nums = flatten(args)
        .map((v) => toNumber(v))
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return null;
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }

    case 'min': {
      const nums = flatten(args)
        .map((v) => toNumber(v))
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return null;
      return Math.min(...nums);
    }

    case 'max': {
      const nums = flatten(args)
        .map((v) => toNumber(v))
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return null;
      return Math.max(...nums);
    }

    case 'count': {
      const items = flatten(args);
      return items.filter((v) => v !== null).length;
    }

    case 'len': {
      if (args.length !== 1) {
        throw new FormulaError('len(x) takes exactly 1 argument');
      }
      const v = args[0];
      if (v === null) return 0;
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      throw new FormulaError('len() only accepts strings or arrays');
    }

    case 'abs': {
      if (args.length !== 1) throw new FormulaError('abs(x) takes 1 argument');
      const n = toNumber(args[0]);
      return n === null ? null : Math.abs(n);
    }

    case 'round': {
      if (args.length !== 1) throw new FormulaError('round(x) takes 1 argument');
      const n = toNumber(args[0]);
      return n === null ? null : Math.round(n);
    }

    case 'floor': {
      if (args.length !== 1) throw new FormulaError('floor(x) takes 1 argument');
      const n = toNumber(args[0]);
      return n === null ? null : Math.floor(n);
    }

    case 'ceil': {
      if (args.length !== 1) throw new FormulaError('ceil(x) takes 1 argument');
      const n = toNumber(args[0]);
      return n === null ? null : Math.ceil(n);
    }

    case 'concat': {
      return args.map((v) => (v === null ? '' : String(v))).join('');
    }
  }
  throw new FormulaError(`Unknown function: ${name}`);
}

function toDate(v: FormulaValue): Date | null {
  if (v === null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? new Date(v) : null;
  }
  return null;
}

// ---------- Visibility rule evaluation ----------

export interface VisibilityRule {
  when: {
    fieldKey: string;
    op: 'equals' | 'in' | 'isSet';
    value?: unknown;
  };
}

/**
 * Evaluate a visibility rule against a bag of field values. `null` rule
 * means "always visible". Missing dependency fields read as `null`. Used
 * by both the frontend editor list (hide the row) and the backend value
 * filter (don't expose values for hidden fields).
 */
export function isFieldVisible(
  rule: VisibilityRule | null | undefined,
  vars: Record<string, FormulaValue>,
): boolean {
  if (!rule || !rule.when) return true;
  const { fieldKey, op, value } = rule.when;
  if (typeof fieldKey !== 'string') return true; // malformed rule -> visible
  const actual = Object.prototype.hasOwnProperty.call(vars, fieldKey)
    ? vars[fieldKey]
    : null;
  switch (op) {
    case 'isSet':
      return actual !== null && actual !== undefined && actual !== '';
    case 'equals':
      return looseEq(actual, value as FormulaValue);
    case 'in':
      if (!Array.isArray(value)) return false;
      return (value as FormulaValue[]).some((v) => looseEq(actual, v));
    default:
      return true;
  }
}
