import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { EventEmitter2} from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { CustomFieldKind } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import {
  FormulaError,
  evaluateFormula,
  isFieldVisible,
  parseFormula,
  type AstNode,
  type FormulaValue,
  type VisibilityRule,
} from './formula-evaluator';

export interface CustomFieldOption {
  value: string;
  label: string;
  color?: string;
}

export interface RollupConfig {
  relation: 'subtasks' | 'linkedTasks';
  /** A built-in Task column ('estimate' | 'storyPoints') or a sibling
   *  custom-field name. We resolve the latter by looking up the def in the
   *  same project at compute time. */
  field: string;
  agg: 'sum' | 'avg' | 'min' | 'max' | 'count';
}

export interface CustomFieldInput {
  name: string;
  kind: CustomFieldKind;
  options?: CustomFieldOption[];
  position?: number;
  required?: boolean;
  formulaExpression?: string | null;
  rollupConfig?: RollupConfig | null;
  visibilityRule?: VisibilityRule | null;
}

// Built-in task columns rollups can aggregate. Anything else gets resolved
// as a sibling custom-field name.
const TASK_NUMERIC_COLUMNS = new Set(['estimate', 'storyPoints']);

@Injectable()
export class CustomFieldsService {
  private readonly logger = new Logger(CustomFieldsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    // We intentionally take the event emitter even though the current
    // compute-on-read strategy does NOT cache formula values — we still
    // hook task.updated below to (a) emit a `custom-fields.recomputed`
    // notice that the realtime broadcaster picks up so the drawer
    // re-fetches, and (b) leave a hook in place for the day we move to
    // persisted-cache evaluation (a Round 7 audit ask).
    private readonly events?: EventEmitter2,
  ) {}

  /**
   * Re-broadcast a recompute notice whenever the upstream task service
   * announces a change. We do NOT recompute eagerly here — formula and
   * rollup values are computed on read in getValuesForTask, which keeps
   * the write path cheap and avoids "stale cached value" bugs entirely.
   * The notice exists so realtime subscribers (websockets, the drawer
   * query) know to refetch.
   */
  @OnEvent('task.updated', { async: true })
  async onTaskUpdated(payload: { taskId?: string }): Promise<void> {
    if (!payload?.taskId) return;
    try {
      // Best-effort emit; if the events instance isn't wired (test mode)
      // we just swallow it.
      this.events?.emit('custom-fields.recomputed', { taskId: payload.taskId });
    } catch (err) {
      this.logger.debug(`recompute notice failed: ${(err as Error).message}`);
    }
  }

  // ---------- Field definitions ----------

  async listForProject(actor: AuthenticatedUser, projectId: string) {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    return this.prisma.customFieldDefinition.findMany({
      where: { projectId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(actor: AuthenticatedUser, projectId: string, input: CustomFieldInput) {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    this.validate(input);
    // For formulas, walk the dependency graph across the rest of the
    // project's defs and reject cycles BEFORE we hit the DB. This is the
    // strict version of "two-pass eval quietly returns null for cycles"
    // — we want save-time rejection, per the Round 6 spec.
    if (input.kind === 'formula' && input.formulaExpression) {
      await this.assertNoFormulaCycle(projectId, input.name, input.formulaExpression, null);
    }
    try {
      return await this.prisma.customFieldDefinition.create({
        data: {
          projectId,
          name: input.name.trim(),
          kind: input.kind,
          options: (input.options ?? []) as unknown as Prisma.InputJsonValue,
          position: input.position ?? 0,
          required: input.required ?? false,
          formulaExpression: input.formulaExpression ?? null,
          // Nullable JSON columns require the Prisma.JsonNull sentinel (not
          // raw null) — passing null collapses the union to a type Prisma
          // rejects at compile time.
          rollupConfig: (input.rollupConfig ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
          visibilityRule: (input.visibilityRule ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
        throw new BadRequestException(`Field "${input.name}" already exists`);
      }
      throw err;
    }
  }

  /**
   * Rename / edit a definition. NOTE on the "bulk-rename without losing data"
   * audit ask: CustomFieldValue rows are bound to CustomFieldDefinition by
   * `fieldId` (UUID), NOT by name. Renaming the `name` column is a one-row
   * UPDATE — every value row continues to resolve through the FK. The only
   * caveat is that formula expressions reference fields by name; if a user
   * renames a field that other formulas reference, those formulas have to be
   * updated by the user (the parser will see {oldName} and return null since
   * the var bag won't have that key). We surface that in the editor copy
   * rather than auto-rewriting, because auto-rewrite would have to disambiguate
   * partial-substring matches in arbitrary expressions and is more dangerous
   * than the manual fix.
   */
  async update(actor: AuthenticatedUser, id: string, input: Partial<CustomFieldInput>) {
    const f = await this.prisma.customFieldDefinition.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Custom field not found');
    await this.permissions.assertAtLeast(actor, f.projectId, 'Manager');
    // Re-validate the post-merge shape so we don't accept a partial update
    // that produces an inconsistent def (e.g. flipping kind=formula but
    // wiping formulaExpression).
    const merged: CustomFieldInput = {
      name: input.name?.trim() ?? f.name,
      kind: (input.kind ?? f.kind) as CustomFieldKind,
      options: (input.options ?? (f.options as unknown as CustomFieldOption[])) as CustomFieldOption[],
      required: input.required ?? f.required,
      formulaExpression: input.formulaExpression ?? f.formulaExpression,
      rollupConfig: (input.rollupConfig ?? f.rollupConfig) as RollupConfig | null,
      visibilityRule: (input.visibilityRule ?? f.visibilityRule) as VisibilityRule | null,
    };
    this.validate(merged);
    if (merged.kind === 'formula' && merged.formulaExpression) {
      await this.assertNoFormulaCycle(
        f.projectId,
        merged.name,
        merged.formulaExpression,
        id,
      );
    }
    return this.prisma.customFieldDefinition.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.options !== undefined ? { options: input.options as unknown as Prisma.InputJsonValue } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.required !== undefined ? { required: input.required } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.formulaExpression !== undefined
          ? { formulaExpression: input.formulaExpression }
          : {}),
        ...(input.rollupConfig !== undefined
          ? { rollupConfig: (input.rollupConfig ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.visibilityRule !== undefined
          ? { visibilityRule: (input.visibilityRule ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async remove(actor: AuthenticatedUser, id: string) {
    const f = await this.prisma.customFieldDefinition.findUnique({ where: { id } });
    if (!f) throw new NotFoundException('Custom field not found');
    await this.permissions.assertAtLeast(actor, f.projectId, 'Manager');
    // Soft-delete to preserve historical values.
    await this.prisma.customFieldDefinition.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    return { ok: true };
  }

  // ---------- Formula parse-only endpoint ----------

  /**
   * Used by the editor UI for live validation. Returns { ok: true } on a
   * parseable expression, or { ok: false, error } on a syntax error. We do
   * NOT evaluate here — evaluation needs the per-task var bag, which is
   * editor-time unavailable.
   */
  validateFormula(expression: string): { ok: boolean; error?: string } {
    try {
      parseFormula(expression);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof FormulaError ? err.message : 'Invalid formula';
      return { ok: false, error: msg };
    }
  }

  /**
   * `POST /custom-fields/:id/validate-formula` — parse the expression AND
   * evaluate it against the first available task in the project, returning
   * `sampleResult` so the editor can show a live preview. The expression
   * argument is OPTIONAL — when omitted we use the def's stored expression.
   * This is the editor's "Test expression" button.
   */
  async validateFormulaAgainstField(
    actor: AuthenticatedUser,
    id: string,
    expression?: string,
  ): Promise<{ valid: boolean; error?: string; sampleResult?: unknown; sampleTaskId?: string }> {
    const def = await this.prisma.customFieldDefinition.findUnique({ where: { id } });
    if (!def) throw new NotFoundException('Custom field not found');
    await this.permissions.assertAtLeast(actor, def.projectId, 'Manager');

    const expr = (expression ?? def.formulaExpression ?? '').trim();
    if (!expr) return { valid: false, error: 'Expression is empty' };

    let ast: AstNode;
    try {
      ast = parseFormula(expr);
    } catch (err) {
      return { valid: false, error: err instanceof FormulaError ? err.message : 'Invalid' };
    }

    // Cycle check against the other defs in the project — saving such an
    // expression would be rejected, so the editor should know up front.
    try {
      await this.assertNoFormulaCycle(def.projectId, def.name, expr, id);
    } catch (err) {
      const msg = err instanceof BadRequestException
        ? (err.getResponse() as { message?: string })?.message ?? err.message
        : (err as Error).message;
      return { valid: false, error: msg };
    }

    // Find ANY task in the project to evaluate against. If the project has
    // no tasks yet, we still return valid=true but no sampleResult.
    // Pick any task — newest first so the editor previews against a "live"
    // row rather than an ancient seed. Task has no soft-delete column so a
    // plain findFirst on projectId is enough.
    const sample = await this.prisma.task.findFirst({
      where: { projectId: def.projectId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!sample) {
      return { valid: true, error: undefined, sampleResult: null };
    }

    // Build the var bag the same way getValuesForTask does, then evaluate
    // JUST this expression — we don't run the whole field pipeline.
    const defs = await this.prisma.customFieldDefinition.findMany({
      where: { projectId: def.projectId, archivedAt: null },
    });
    const storedRows = await this.prisma.customFieldValue.findMany({
      where: { taskId: sample.id },
    });
    const storedByFieldId = new Map<string, (typeof storedRows)[number]>();
    for (const r of storedRows) storedByFieldId.set(r.fieldId, r);
    const vars: Record<string, FormulaValue> = Object.create(null);
    for (const d of defs) {
      const stored = storedByFieldId.get(d.id);
      vars[d.name] = stored ? (stored.value as FormulaValue) : null;
    }

    try {
      const result = evaluateFormula(ast, { vars });
      return { valid: true, sampleResult: result, sampleTaskId: sample.id };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof FormulaError ? err.message : 'Evaluation error',
        sampleTaskId: sample.id,
      };
    }
  }

  /**
   * Walk the formula dependency graph: for the def-under-edit, collect the
   * field names it references; for each of those, look up the sibling def
   * in the project and, if THAT one is also a formula, recurse. If the
   * walk ever lands back on the def we're saving, throw. Self-references
   * (`name` appearing in its own expression) are the trivial case.
   *
   * `selfId` lets us exclude the current row from the lookup during
   * UPDATE — otherwise renaming a formula that references nothing else
   * would always find itself and error.
   */
  private async assertNoFormulaCycle(
    projectId: string,
    selfName: string,
    expression: string,
    selfId: string | null,
  ): Promise<void> {
    // 1. Parse OUR expression and extract direct refs.
    let ast: AstNode;
    try {
      ast = parseFormula(expression);
    } catch (err) {
      // Parse errors are surfaced by validate() — here we only care about
      // cycles, so if it can't even parse we have nothing to do.
      if (err instanceof FormulaError) return;
      throw err;
    }
    const directRefs = collectRefs(ast);
    if (directRefs.has(selfName)) {
      throw new BadRequestException(
        `Formula cannot reference itself: "${selfName}"`,
      );
    }
    if (directRefs.size === 0) return;

    // 2. Pull every other formula def in the project once — we'll BFS over
    // the graph against this map. Excluding selfId means an UPDATE doesn't
    // see its own OLD expression as a node.
    const otherFormulas = await this.prisma.customFieldDefinition.findMany({
      where: {
        projectId,
        archivedAt: null,
        kind: 'formula',
        ...(selfId ? { id: { not: selfId } } : {}),
      },
      select: { name: true, formulaExpression: true },
    });
    // name -> set of direct refs (parsed lazily).
    const refsByName = new Map<string, Set<string>>();
    for (const f of otherFormulas) {
      if (!f.formulaExpression) continue;
      try {
        refsByName.set(f.name, collectRefs(parseFormula(f.formulaExpression)));
      } catch {
        /* skip un-parseable peers — they don't form valid edges */
      }
    }

    // 3. BFS from each of OUR direct refs, looking for a path back to selfName.
    const visited = new Set<string>();
    const queue: string[] = [...directRefs];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node === selfName) {
        throw new BadRequestException(
          `Formula creates a cycle: "${selfName}" -> ... -> "${selfName}"`,
        );
      }
      if (visited.has(node)) continue;
      visited.add(node);
      const next = refsByName.get(node);
      if (next) for (const r of next) queue.push(r);
    }
  }

  // ---------- Per-task values ----------

  async listValuesForTask(actor: AuthenticatedUser, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!(await this.permissions.canSeeTask(actor, task.projectId, task.visibility))) {
      throw new NotFoundException('Task not found');
    }
    return this.getValuesForTask(taskId, task.projectId);
  }

  /**
   * Authoritative resolver for "what custom fields apply to this task and
   * what value does each carry". Returns rows in the same shape the old
   * listValuesForTask returned for storable kinds (text/number/etc.), AND
   * synthesizes rows for formula + rollup defs by computing them on read.
   * The output is also visibility-rule filtered: rows whose def's rule
   * evaluates to false against the task's other field values are stripped
   * before return, so a hidden field's value cannot leak out.
   *
   * We deliberately return the same row shape regardless of kind — the
   * client uses field.kind to decide whether to render an editor or a
   * read-only computed cell.
   */
  async getValuesForTask(taskId: string, projectId: string) {
    const [defs, storedRows] = await Promise.all([
      this.prisma.customFieldDefinition.findMany({
        where: { projectId, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.customFieldValue.findMany({
        where: { taskId },
      }),
    ]);

    const storedByFieldId = new Map<string, (typeof storedRows)[number]>();
    for (const r of storedRows) storedByFieldId.set(r.fieldId, r);

    // Var bag for formula refs + visibility-rule deps. Keys are field NAMES
    // (what the user types in {…}), values are the resolved primitives.
    // Use a null-prototype object so a malformed formula referencing
    // `__proto__` or `toString` reads as missing rather than the JS builtin.
    const vars: Record<string, FormulaValue> = Object.create(null);
    for (const d of defs) {
      const stored = storedByFieldId.get(d.id);
      if (stored) {
        vars[d.name] = stored.value as FormulaValue;
      } else {
        vars[d.name] = null;
      }
    }

    // First pass: compute formula + rollup synth values and put them into
    // the var bag so a downstream formula can reference an earlier formula.
    // We don't do cycle detection — a formula referencing a later formula
    // simply reads null on its first pass. Two passes is a pragmatic
    // compromise between correctness and complexity.
    for (let pass = 0; pass < 2; pass++) {
      for (const d of defs) {
        if (d.kind === 'formula') {
          vars[d.name] = await this.computeFormula(d, vars);
        } else if (d.kind === 'rollup') {
          vars[d.name] = await this.computeRollup(d, taskId, projectId);
        }
      }
    }

    const rows: Array<{
      id: string;
      fieldId: string;
      value: unknown;
      field: typeof defs[number];
      computed: boolean;
    }> = [];

    for (const d of defs) {
      if (!isFieldVisible(d.visibilityRule as VisibilityRule | null, vars)) {
        // Security: do not expose the value for fields whose visibility
        // rule says they don't apply to this task. Skip the row entirely.
        continue;
      }
      if (d.kind === 'formula' || d.kind === 'rollup') {
        rows.push({
          id: `${d.id}::computed::${taskId}`,
          fieldId: d.id,
          value: vars[d.name] ?? null,
          field: d,
          computed: true,
        });
      } else {
        const stored = storedByFieldId.get(d.id);
        if (!stored) continue;
        rows.push({
          id: stored.id,
          fieldId: stored.fieldId,
          value: stored.value,
          field: d,
          computed: false,
        });
      }
    }

    return rows;
  }

  private async computeFormula(
    def: { formulaExpression: string | null; name: string },
    vars: Record<string, FormulaValue>,
  ): Promise<FormulaValue> {
    if (!def.formulaExpression) return null;
    try {
      const ast = parseFormula(def.formulaExpression);
      return evaluateFormula(ast, { vars });
    } catch (err) {
      // Don't blow up the whole task fetch for a broken formula — surface
      // the error string in the row so the user can read it in the UI.
      // (The editor already validates on save, so this only happens when a
      // referenced field was renamed afterwards.)
      const msg = err instanceof FormulaError ? err.message : 'formula error';
      return `#ERR: ${msg}`;
    }
  }

  private async computeRollup(
    def: { rollupConfig: unknown; name: string; projectId: string },
    taskId: string,
    projectId: string,
  ): Promise<FormulaValue> {
    const cfg = def.rollupConfig as RollupConfig | null;
    if (!cfg || typeof cfg !== 'object') return null;
    const relation = cfg.relation;
    const field = cfg.field;
    const agg = cfg.agg;
    if (relation !== 'subtasks' && relation !== 'linkedTasks') return null;
    if (typeof field !== 'string' || !field) return null;
    if (!['sum', 'avg', 'min', 'max', 'count'].includes(agg)) return null;

    // Collect the related task IDs.
    let relatedTaskIds: string[] = [];
    if (relation === 'subtasks') {
      const subs = await this.prisma.task.findMany({
        where: { parentTaskId: taskId },
        select: { id: true, estimate: true },
      });
      // Built-in numeric columns (estimate) we can grab in the same query.
      if (field === 'estimate' && agg !== 'count') {
        const nums = subs
          .map((s) => s.estimate)
          .filter((v): v is number => typeof v === 'number');
        return aggregate(nums, agg);
      }
      if (agg === 'count') return subs.length;
      relatedTaskIds = subs.map((s) => s.id);
    } else {
      // linkedTasks: the union of taskLinks where this task is either side.
      // We don't filter by type — the "related" rollup is the most useful
      // default; if a user wants to scope to 'blocks' we can extend later.
      const links = await this.prisma.taskLink.findMany({
        where: {
          OR: [{ fromTaskId: taskId }, { toTaskId: taskId }],
        },
        select: { fromTaskId: true, toTaskId: true },
      });
      relatedTaskIds = links.map((l) =>
        l.fromTaskId === taskId ? l.toTaskId : l.fromTaskId,
      );
      if (agg === 'count') return relatedTaskIds.length;
      if (field === 'estimate') {
        const linkedTasks = await this.prisma.task.findMany({
          where: { id: { in: relatedTaskIds } },
          select: { estimate: true },
        });
        const nums = linkedTasks
          .map((t) => t.estimate)
          .filter((v): v is number => typeof v === 'number');
        return aggregate(nums, agg);
      }
    }

    if (relatedTaskIds.length === 0) return aggregate([], agg);

    // Custom-field reference. Resolve the sibling def by name in the same
    // project, then read its values on the related tasks.
    if (!TASK_NUMERIC_COLUMNS.has(field)) {
      const targetDef = await this.prisma.customFieldDefinition.findFirst({
        where: { projectId, name: field, archivedAt: null },
      });
      if (!targetDef) return null;
      const vals = await this.prisma.customFieldValue.findMany({
        where: { fieldId: targetDef.id, taskId: { in: relatedTaskIds } },
        select: { value: true },
      });
      const nums = vals
        .map((v) => v.value)
        .map((v) => (typeof v === 'number' ? v : null))
        .filter((n): n is number => n !== null);
      return aggregate(nums, agg);
    }

    return aggregate([], agg);
  }

  async setValue(actor: AuthenticatedUser, taskId: string, fieldId: string, value: unknown) {
    const [task, field] = await Promise.all([
      this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } }),
      this.prisma.customFieldDefinition.findUnique({ where: { id: fieldId } }),
    ]);
    if (!task) throw new NotFoundException('Task not found');
    if (!field) throw new NotFoundException('Custom field not found');
    if (field.projectId !== task.projectId) {
      throw new BadRequestException('Field belongs to a different project');
    }
    if (field.kind === 'formula' || field.kind === 'rollup') {
      throw new BadRequestException(
        `${field.kind} fields are computed read-only; values cannot be set directly`,
      );
    }
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');

    this.validateValue(field.kind, value, field.options as unknown as CustomFieldOption[]);

    return this.prisma.customFieldValue.upsert({
      where: { taskId_fieldId: { taskId, fieldId } },
      update: { value: value as Prisma.InputJsonValue },
      create: { taskId, fieldId, value: value as Prisma.InputJsonValue },
    });
  }

  async clearValue(actor: AuthenticatedUser, taskId: string, fieldId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task) throw new NotFoundException('Task not found');
    await this.permissions.assertAtLeast(actor, task.projectId, 'Contributor');
    await this.prisma.customFieldValue.delete({
      where: { taskId_fieldId: { taskId, fieldId } },
    }).catch(() => { /* idempotent */ });
    return { ok: true };
  }

  // ---------- Validation ----------

  private validate(input: CustomFieldInput) {
    if (!input.name?.trim()) throw new BadRequestException('Name is required');
    if (input.name.length > 60) throw new BadRequestException('Name too long');
    if (input.kind === 'select' || input.kind === 'multiselect') {
      if (!input.options || input.options.length === 0) {
        throw new BadRequestException(`${input.kind} fields need at least one option`);
      }
      for (const o of input.options) {
        if (!o.value || !o.label) throw new BadRequestException('Each option needs value and label');
      }
    }
    if (input.kind === 'formula') {
      if (!input.formulaExpression || !input.formulaExpression.trim()) {
        throw new BadRequestException('formula fields need a formulaExpression');
      }
      // Parse-only check — evaluator runs at fetch time with the per-task bag.
      try {
        parseFormula(input.formulaExpression);
      } catch (err) {
        const msg = err instanceof FormulaError ? err.message : 'invalid formula';
        throw new BadRequestException(`Invalid formula: ${msg}`);
      }
    }
    if (input.kind === 'rollup') {
      const cfg = input.rollupConfig;
      if (!cfg || typeof cfg !== 'object') {
        throw new BadRequestException('rollup fields need a rollupConfig');
      }
      if (cfg.relation !== 'subtasks' && cfg.relation !== 'linkedTasks') {
        throw new BadRequestException(
          'rollupConfig.relation must be subtasks or linkedTasks',
        );
      }
      if (!cfg.field || typeof cfg.field !== 'string') {
        throw new BadRequestException('rollupConfig.field is required');
      }
      if (!['sum', 'avg', 'min', 'max', 'count'].includes(cfg.agg)) {
        throw new BadRequestException(
          'rollupConfig.agg must be sum|avg|min|max|count',
        );
      }
    }
    if (input.visibilityRule) {
      const r = input.visibilityRule as VisibilityRule;
      if (!r.when || typeof r.when.fieldKey !== 'string') {
        throw new BadRequestException('visibilityRule.when.fieldKey is required');
      }
      if (!['equals', 'in', 'isSet'].includes(r.when.op)) {
        throw new BadRequestException(
          'visibilityRule.when.op must be equals|in|isSet',
        );
      }
    }
  }

  private validateValue(kind: CustomFieldKind, value: unknown, options: CustomFieldOption[]) {
    switch (kind) {
      case 'text':
      case 'url':
        if (value !== null && typeof value !== 'string') {
          throw new BadRequestException(`${kind} value must be a string`);
        }
        if (kind === 'url' && typeof value === 'string' && value) {
          try { new URL(value); } catch { throw new BadRequestException('Invalid URL'); }
        }
        break;
      case 'number':
        if (value !== null && typeof value !== 'number') {
          throw new BadRequestException('number value must be a number');
        }
        break;
      case 'date':
        if (value !== null) {
          if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
            throw new BadRequestException('date value must be an ISO date string');
          }
        }
        break;
      case 'checkbox':
        if (value !== null && typeof value !== 'boolean') {
          throw new BadRequestException('checkbox value must be a boolean');
        }
        break;
      case 'select': {
        if (value === null) return;
        if (typeof value !== 'string') throw new BadRequestException('select value must be a string');
        if (!options.some((o) => o.value === value)) {
          throw new BadRequestException(`Value "${value}" not in options`);
        }
        break;
      }
      case 'multiselect': {
        if (value === null) return;
        if (!Array.isArray(value)) throw new BadRequestException('multiselect value must be an array');
        for (const v of value) {
          if (typeof v !== 'string') throw new BadRequestException('multiselect items must be strings');
          if (!options.some((o) => o.value === v)) {
            throw new BadRequestException(`Value "${v}" not in options`);
          }
        }
        break;
      }
      case 'formula':
      case 'rollup':
        // Should never reach here — setValue rejects these earlier. Belt-and-
        // braces: anything stored against a computed kind is a bug.
        throw new BadRequestException(`${kind} values are computed, not stored`);
    }
  }
}

/**
 * Walk an AST and return the set of `{name}` references it contains. Used
 * by the cycle detector — we only care about ref nodes, not built-in
 * function names (which can't form cycles since they don't expand to
 * arbitrary user-defined expressions).
 */
function collectRefs(node: AstNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: AstNode): void => {
    switch (n.kind) {
      case 'ref':
        out.add(n.name);
        return;
      case 'unary':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'array':
        for (const it of n.items) walk(it);
        return;
      case 'call':
        for (const a of n.args) walk(a);
        return;
      case 'num':
      case 'str':
      case 'bool':
      case 'null':
        return;
    }
  };
  walk(node);
  return out;
}

function aggregate(
  nums: number[],
  agg: 'sum' | 'avg' | 'min' | 'max' | 'count',
): number | null {
  if (agg === 'count') return nums.length;
  if (nums.length === 0) {
    if (agg === 'sum') return 0;
    return null;
  }
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (agg === 'min') return Math.min(...nums);
  return Math.max(...nums);
}
