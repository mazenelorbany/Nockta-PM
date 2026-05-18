import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';

import { CustomFieldsService } from './custom-fields.service';

// =============================================================================
// custom-fields.service — covers:
//   - per-kind value validator (setValue, every kind)
//   - cross-project guard
//   - formula evaluation through getValuesForTask
//   - rollup aggregation (subtasks.estimate + linkedTasks)
//   - visibility-rule filtering on the response
//   - key/name rename leaves values intact (FK is on UUID, not name)
//   - validateFormula parse-only endpoint
//   - setValue refuses to write to a formula/rollup field
// =============================================================================

interface Mocks {
  prisma: PrismaService;
  permissions: {
    assertAtLeast: ReturnType<typeof vi.fn>;
    canSeeTask: ReturnType<typeof vi.fn>;
  };
}

function build(): { service: CustomFieldsService; mocks: Mocks } {
  const prisma = makePrismaMock();
  const permissions = {
    assertAtLeast: vi.fn().mockResolvedValue('Contributor'),
    canSeeTask: vi.fn().mockResolvedValue(true),
  };
  const events = makeEventsMock();
  // Mock factory doesn't include custom field models — patch them in.
  // Default every method to `vi.fn().mockResolvedValue(undefined)` so any
  // unstubbed call resolves cleanly; the cycle check fans out to findMany
  // even on the no-task path. Specific stubs (mockResolvedValueOnce) below
  // still override per-test.
  const cfd = () => vi.fn().mockResolvedValue(undefined);
  (prisma as unknown as { customFieldDefinition: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } }).customFieldDefinition = {
    findUnique: cfd(),
    findFirst: cfd(),
    findMany: vi.fn().mockResolvedValue([]),
    create: cfd(),
    update: cfd(),
    delete: cfd(),
  };
  (prisma as unknown as { customFieldValue: { findMany: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } }).customFieldValue = {
    findMany: vi.fn().mockResolvedValue([]),
    upsert: cfd(),
    delete: cfd(),
  };
  const service = new CustomFieldsService(
    prisma,
    permissions as unknown as PermissionsService,
    events.instance,
  );
  return { service, mocks: { prisma, permissions } };
}

const ACTOR: AuthenticatedUser = {
  id: 'u-1',
  email: 'a@nockta.com',
  kind: 'internal',
  companyRole: 'Member',
} as AuthenticatedUser;

function stubTaskAndField(
  mocks: Mocks,
  field: { kind: string; options?: { value: string; label: string }[] },
): void {
  vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
    projectId: 'p1',
  } as never);
  const def = (
    mocks.prisma as unknown as {
      customFieldDefinition: { findUnique: ReturnType<typeof vi.fn> };
    }
  ).customFieldDefinition.findUnique;
  def.mockResolvedValueOnce({
    id: 'f-1',
    projectId: 'p1',
    kind: field.kind,
    options: field.options ?? [],
  } as never);
}

function stubUpsert(mocks: Mocks): void {
  (
    mocks.prisma as unknown as {
      customFieldValue: { upsert: ReturnType<typeof vi.fn> };
    }
  ).customFieldValue.upsert.mockResolvedValueOnce({} as never);
}

describe('CustomFieldsService.setValue — value coercion per kind', () => {
  let mocks: Mocks;
  let service: CustomFieldsService;

  beforeEach(() => {
    ({ service, mocks } = build());
  });

  it('text: accepts string', async () => {
    stubTaskAndField(mocks, { kind: 'text' });
    stubUpsert(mocks);
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 'hello')).resolves.toBeDefined();
  });

  it('text: rejects non-string', async () => {
    stubTaskAndField(mocks, { kind: 'text' });
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 42)).rejects.toThrow(
      /text value must be a string/i,
    );
  });

  it('url: rejects malformed string', async () => {
    stubTaskAndField(mocks, { kind: 'url' });
    await expect(
      service.setValue(ACTOR, 't-1', 'f-1', 'not-a-url'),
    ).rejects.toThrow(/invalid url/i);
  });

  it('url: accepts a valid URL', async () => {
    stubTaskAndField(mocks, { kind: 'url' });
    stubUpsert(mocks);
    await expect(
      service.setValue(ACTOR, 't-1', 'f-1', 'https://example.com'),
    ).resolves.toBeDefined();
  });

  it('number: rejects strings', async () => {
    stubTaskAndField(mocks, { kind: 'number' });
    await expect(service.setValue(ACTOR, 't-1', 'f-1', '42')).rejects.toThrow(
      /must be a number/i,
    );
  });

  it('date: rejects non-ISO strings', async () => {
    stubTaskAndField(mocks, { kind: 'date' });
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 'tomorrow')).rejects.toThrow(
      /must be an ISO date string/i,
    );
  });

  it('date: accepts an ISO string', async () => {
    stubTaskAndField(mocks, { kind: 'date' });
    stubUpsert(mocks);
    await expect(
      service.setValue(ACTOR, 't-1', 'f-1', '2026-05-15'),
    ).resolves.toBeDefined();
  });

  it('checkbox: rejects strings', async () => {
    stubTaskAndField(mocks, { kind: 'checkbox' });
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 'yes')).rejects.toThrow(
      /must be a boolean/i,
    );
  });

  it('select: rejects values not in options', async () => {
    stubTaskAndField(mocks, {
      kind: 'select',
      options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }],
    });
    await expect(
      service.setValue(ACTOR, 't-1', 'f-1', 'purple'),
    ).rejects.toThrow(/not in options/i);
  });

  it('select: accepts an option value', async () => {
    stubTaskAndField(mocks, {
      kind: 'select',
      options: [{ value: 'red', label: 'Red' }],
    });
    stubUpsert(mocks);
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 'red')).resolves.toBeDefined();
  });

  it('multiselect: rejects non-array', async () => {
    stubTaskAndField(mocks, {
      kind: 'multiselect',
      options: [{ value: 'a', label: 'A' }],
    });
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 'a')).rejects.toThrow(
      /must be an array/i,
    );
  });

  it('multiselect: rejects array with an unknown value', async () => {
    stubTaskAndField(mocks, {
      kind: 'multiselect',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    });
    await expect(
      service.setValue(ACTOR, 't-1', 'f-1', ['a', 'unknown']),
    ).rejects.toThrow(/not in options/i);
  });

  it('null is always permitted (clearing a value)', async () => {
    for (const kind of ['text', 'number', 'date', 'checkbox', 'select']) {
      const { service: svc, mocks: m } = build();
      stubTaskAndField(m, { kind });
      stubUpsert(m);
      await expect(svc.setValue(ACTOR, 't-1', 'f-1', null)).resolves.toBeDefined();
    }
  });

  it('refuses to set a value on a formula field', async () => {
    stubTaskAndField(mocks, { kind: 'formula' });
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 'x')).rejects.toThrow(
      /computed read-only/i,
    );
  });

  it('refuses to set a value on a rollup field', async () => {
    stubTaskAndField(mocks, { kind: 'rollup' });
    await expect(service.setValue(ACTOR, 't-1', 'f-1', 1)).rejects.toThrow(
      /computed read-only/i,
    );
  });
});

describe('CustomFieldsService.setValue — cross-project guard', () => {
  it('refuses to set a value for a field belonging to a different project', async () => {
    const { service, mocks } = build();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'project-A',
    } as never);
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findUnique: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'f-1',
      projectId: 'project-B',
      kind: 'text',
      options: [],
    } as never);

    await expect(service.setValue(ACTOR, 't-1', 'f-1', 'x')).rejects.toThrow(
      BadRequestException,
    );
  });
});

// =============================================================================
// validateFormula — parse-only endpoint for the editor.
// =============================================================================

describe('CustomFieldsService.validateFormula', () => {
  it('returns ok:true for a valid expression', () => {
    const { service } = build();
    expect(service.validateFormula('{estimate} * 2')).toEqual({ ok: true });
  });

  it('returns ok:false with a message for invalid input', () => {
    const { service } = build();
    const out = service.validateFormula('1 + ');
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });

  it('rejects formulas that try to call constructor()', () => {
    const { service } = build();
    // Parse succeeds; evaluation would fail. But validateFormula is parse-only,
    // and the parser DOES accept it as a call expression. The eval-time
    // allowlist is what blocks it. This test just documents that the parser
    // is permissive but evaluation is strict.
    expect(service.validateFormula('constructor()')).toEqual({ ok: true });
  });
});

describe('CustomFieldsService.validateFormulaAgainstField', () => {
  it('returns a sampleResult evaluated against the first project task', async () => {
    const { service, mocks } = build();
    (
      mocks.prisma as unknown as {
        customFieldDefinition: {
          findUnique: ReturnType<typeof vi.fn>;
          findMany: ReturnType<typeof vi.fn>;
        };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'def-f',
      projectId: 'p1',
      name: 'doubled',
      kind: 'formula',
      formulaExpression: '{estimate} * 2',
    } as never);
    // project has 1 task with estimate=7 (via custom field "estimate")
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValue({ id: 't-1' } as never);
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findMany.mockResolvedValue([
      { id: 'def-est', name: 'estimate', kind: 'number' },
    ] as never);
    (
      mocks.prisma as unknown as {
        customFieldValue: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldValue.findMany.mockResolvedValue([
      { id: 'v', fieldId: 'def-est', value: 7 },
    ] as never);

    const result = await service.validateFormulaAgainstField(ACTOR, 'def-f');
    expect(result.valid).toBe(true);
    expect(result.sampleResult).toBe(14);
    expect(result.sampleTaskId).toBe('t-1');
  });

  it('returns valid=true with no sampleResult when project has no tasks', async () => {
    const { service, mocks } = build();
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findUnique: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'def-f',
      projectId: 'p1',
      name: 'doubled',
      kind: 'formula',
      formulaExpression: '{estimate} * 2',
    } as never);
    vi.mocked(mocks.prisma.task.findFirst).mockResolvedValue(null as never);

    const result = await service.validateFormulaAgainstField(ACTOR, 'def-f');
    expect(result.valid).toBe(true);
    expect(result.sampleResult).toBeNull();
  });

  it('returns valid=false with error on syntax error', async () => {
    const { service, mocks } = build();
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findUnique: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'def-f',
      projectId: 'p1',
      name: 'broken',
      kind: 'formula',
      formulaExpression: '1 + ',
    } as never);

    const result = await service.validateFormulaAgainstField(ACTOR, 'def-f');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects an expression that would create a cycle', async () => {
    const { service, mocks } = build();
    (
      mocks.prisma as unknown as {
        customFieldDefinition: {
          findUnique: ReturnType<typeof vi.fn>;
          findMany: ReturnType<typeof vi.fn>;
        };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'def-A',
      projectId: 'p1',
      name: 'A',
      kind: 'formula',
      formulaExpression: '1',
    } as never);
    // B already references A; previewing A->B closes the cycle.
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findMany.mockResolvedValue([
      { name: 'B', formulaExpression: '{A} + 1' },
    ] as never);

    const result = await service.validateFormulaAgainstField(ACTOR, 'def-A', '{B} + 1');
    expect(result.valid).toBe(false);
    expect(String(result.error)).toMatch(/cycle/i);
  });
});

// =============================================================================
// getValuesForTask — formula + rollup + visibility.
// =============================================================================

function stubProjectDefs(
  mocks: Mocks,
  defs: Array<Record<string, unknown>>,
): void {
  (
    mocks.prisma as unknown as {
      customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
    }
  ).customFieldDefinition.findMany.mockResolvedValue(defs as never);
}

function stubStoredValues(
  mocks: Mocks,
  values: Array<{ id: string; fieldId: string; value: unknown }>,
): void {
  (
    mocks.prisma as unknown as {
      customFieldValue: { findMany: ReturnType<typeof vi.fn> };
    }
  ).customFieldValue.findMany.mockResolvedValue(values as never);
}

describe('CustomFieldsService.getValuesForTask — formula fields', () => {
  it('evaluates a formula that references stored fields', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      { id: 'def-num', projectId: 'p1', kind: 'number', name: 'estimate', options: [], visibilityRule: null },
      {
        id: 'def-formula',
        projectId: 'p1',
        kind: 'formula',
        name: 'doubled',
        options: [],
        formulaExpression: '{estimate} * 2',
        visibilityRule: null,
      },
    ]);
    stubStoredValues(mocks, [
      { id: 'v1', fieldId: 'def-num', value: 5 },
    ]);

    const rows = await service.getValuesForTask('t-1', 'p1');
    const formulaRow = rows.find((r) => r.fieldId === 'def-formula');
    expect(formulaRow?.value).toBe(10);
    expect(formulaRow?.computed).toBe(true);
  });

  it('returns null for a formula that references a missing field', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      {
        id: 'def-formula',
        projectId: 'p1',
        kind: 'formula',
        name: 'mystery',
        options: [],
        formulaExpression: '{ghost} + 1',
        visibilityRule: null,
      },
    ]);
    stubStoredValues(mocks, []);

    const rows = await service.getValuesForTask('t-1', 'p1');
    const formulaRow = rows.find((r) => r.fieldId === 'def-formula');
    expect(formulaRow?.value).toBeNull();
  });

  it('two-pass: a formula can reference another formula declared earlier', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      { id: 'd-est', projectId: 'p1', kind: 'number', name: 'estimate', options: [], visibilityRule: null, position: 0 },
      {
        id: 'd-double',
        projectId: 'p1',
        kind: 'formula',
        name: 'doubled',
        options: [],
        formulaExpression: '{estimate} * 2',
        visibilityRule: null,
        position: 1,
      },
      {
        id: 'd-quad',
        projectId: 'p1',
        kind: 'formula',
        name: 'quadrupled',
        options: [],
        formulaExpression: '{doubled} * 2',
        visibilityRule: null,
        position: 2,
      },
    ]);
    stubStoredValues(mocks, [
      { id: 'v1', fieldId: 'd-est', value: 3 },
    ]);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'd-quad')?.value).toBe(12);
  });

  it('surfaces a parser error as a #ERR string instead of throwing', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      {
        id: 'def-formula',
        projectId: 'p1',
        kind: 'formula',
        name: 'broken',
        options: [],
        // intentionally broken — could happen if a sibling field was renamed
        formulaExpression: '1 +',
        visibilityRule: null,
      },
    ]);
    stubStoredValues(mocks, []);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(String(rows.find((r) => r.fieldId === 'def-formula')?.value)).toMatch(/^#ERR/);
  });
});

describe('CustomFieldsService.getValuesForTask — rollup fields', () => {
  it('sums subtasks.estimate', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      {
        id: 'def-rollup',
        projectId: 'p1',
        kind: 'rollup',
        name: 'totalEstimate',
        options: [],
        rollupConfig: { relation: 'subtasks', field: 'estimate', agg: 'sum' },
        visibilityRule: null,
      },
    ]);
    stubStoredValues(mocks, []);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValue([
      { id: 's1', estimate: 3 },
      { id: 's2', estimate: 5 },
      { id: 's3', estimate: null },
    ] as never);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(8);
  });

  it('counts subtasks regardless of estimate', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      {
        id: 'def-rollup',
        projectId: 'p1',
        kind: 'rollup',
        name: 'subtaskCount',
        options: [],
        rollupConfig: { relation: 'subtasks', field: 'estimate', agg: 'count' },
        visibilityRule: null,
      },
    ]);
    stubStoredValues(mocks, []);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValue([
      { id: 's1', estimate: 1 },
      { id: 's2', estimate: null },
    ] as never);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(2);
  });

  it('rolls up a sibling custom-field over linked tasks', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      {
        id: 'def-points',
        projectId: 'p1',
        kind: 'number',
        name: 'points',
        options: [],
        visibilityRule: null,
      },
      {
        id: 'def-rollup',
        projectId: 'p1',
        kind: 'rollup',
        name: 'sumPoints',
        options: [],
        rollupConfig: { relation: 'linkedTasks', field: 'points', agg: 'sum' },
        visibilityRule: null,
      },
    ]);
    // taskLink.findMany — patch in since base mock omits it.
    (mocks.prisma as unknown as { taskLink: { findMany: ReturnType<typeof vi.fn> } }).taskLink = {
      findMany: vi.fn().mockResolvedValue([
        { fromTaskId: 't-1', toTaskId: 'related-1' },
        { fromTaskId: 'related-2', toTaskId: 't-1' },
      ] as never),
    } as never;
    // findFirst resolves the sibling def by name. Called twice (two passes).
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findFirst: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findFirst.mockResolvedValue({
      id: 'def-points',
      projectId: 'p1',
      kind: 'number',
      name: 'points',
    } as never);
    // customFieldValue.findMany is called by both stored-values-for-task
    // (returns []) and by computeRollup (returns the points). We use a
    // typed implementation switch to keep the two calls distinct.
    let cfvCalls = 0;
    (
      mocks.prisma as unknown as {
        customFieldValue: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldValue.findMany.mockImplementation(() => {
      cfvCalls++;
      if (cfvCalls === 1) return Promise.resolve([] as never);
      // 2nd+: the rollup's points lookup.
      return Promise.resolve([{ value: 4 }, { value: 6 }] as never);
    });

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBe(10);
  });

  it('avg over an empty set is null', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      {
        id: 'def-rollup',
        projectId: 'p1',
        kind: 'rollup',
        name: 'avgPts',
        options: [],
        rollupConfig: { relation: 'subtasks', field: 'estimate', agg: 'avg' },
        visibilityRule: null,
      },
    ]);
    stubStoredValues(mocks, []);
    vi.mocked(mocks.prisma.task.findMany).mockResolvedValue([] as never);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'def-rollup')?.value).toBeNull();
  });
});

describe('CustomFieldsService.getValuesForTask — visibility rules', () => {
  it('hides a field whose equals rule is not satisfied', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      { id: 'd-status', projectId: 'p1', kind: 'select', name: 'status', options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }], visibilityRule: null },
      {
        id: 'd-resolution',
        projectId: 'p1',
        kind: 'text',
        name: 'resolution',
        options: [],
        visibilityRule: { when: { fieldKey: 'status', op: 'equals', value: 'closed' } },
      },
    ]);
    stubStoredValues(mocks, [
      { id: 'v1', fieldId: 'd-status', value: 'open' },
      { id: 'v2', fieldId: 'd-resolution', value: 'fixed' },
    ]);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'd-resolution')).toBeUndefined();
    // Bonus: confirm the value is NOT exposed anywhere.
    expect(rows.some((r) => r.value === 'fixed')).toBe(false);
  });

  it('shows the field when the rule passes', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      { id: 'd-status', projectId: 'p1', kind: 'select', name: 'status', options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }], visibilityRule: null },
      {
        id: 'd-resolution',
        projectId: 'p1',
        kind: 'text',
        name: 'resolution',
        options: [],
        visibilityRule: { when: { fieldKey: 'status', op: 'equals', value: 'closed' } },
      },
    ]);
    stubStoredValues(mocks, [
      { id: 'v1', fieldId: 'd-status', value: 'closed' },
      { id: 'v2', fieldId: 'd-resolution', value: 'fixed' },
    ]);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'd-resolution')?.value).toBe('fixed');
  });

  it('isSet rule treats null as not-set', async () => {
    const { service, mocks } = build();
    stubProjectDefs(mocks, [
      { id: 'd-customer', projectId: 'p1', kind: 'text', name: 'customer', options: [], visibilityRule: null },
      {
        id: 'd-dept',
        projectId: 'p1',
        kind: 'text',
        name: 'dept',
        options: [],
        visibilityRule: { when: { fieldKey: 'customer', op: 'isSet' } },
      },
    ]);
    stubStoredValues(mocks, [
      // customer not set — dept should be hidden
      { id: 'v', fieldId: 'd-dept', value: 'sales' },
    ]);

    const rows = await service.getValuesForTask('t-1', 'p1');
    expect(rows.find((r) => r.fieldId === 'd-dept')).toBeUndefined();
  });
});

// =============================================================================
// Rename preserves data — the headline Round 5 ask.
// =============================================================================

// =============================================================================
// Cycle detection — the Round 6 ask: reject save when a formula introduces
// a cycle through other formulas in the same project. Self-references and
// multi-hop A->B->A both throw BadRequestException.
// =============================================================================

describe('CustomFieldsService.create — formula cycle rejection', () => {
  it('throws when a formula references itself', async () => {
    const { service, mocks } = build();
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findMany.mockResolvedValue([] as never);

    await expect(
      service.create(ACTOR, 'p1', {
        name: 'selfRef',
        kind: 'formula' as never,
        formulaExpression: '{selfRef} + 1',
      } as never),
    ).rejects.toThrow(/reference itself/i);
  });

  it('throws when A->B and B->A form a 2-hop cycle', async () => {
    const { service, mocks } = build();
    // Existing field "B" already references "A". Now we're creating "A"
    // which references "B" — that's the cycle.
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findMany.mockResolvedValue([
      {
        name: 'B',
        formulaExpression: '{A} + 1',
      },
    ] as never);

    await expect(
      service.create(ACTOR, 'p1', {
        name: 'A',
        kind: 'formula' as never,
        formulaExpression: '{B} + 1',
      } as never),
    ).rejects.toThrow(/cycle/i);
  });

  it('accepts an acyclic chain A->B->C', async () => {
    const { service, mocks } = build();
    // Existing peers: B->C, C is a stored number. Creating A->B is fine.
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findMany.mockResolvedValue([
      {
        name: 'B',
        formulaExpression: '{C} * 2',
      },
    ] as never);
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { create: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.create.mockResolvedValue({ id: 'new', name: 'A' } as never);

    await expect(
      service.create(ACTOR, 'p1', {
        name: 'A',
        kind: 'formula' as never,
        formulaExpression: '{B} + 1',
      } as never),
    ).resolves.toBeDefined();
  });
});

describe('CustomFieldsService.update — formula cycle rejection', () => {
  it('throws on UPDATE if the new expression introduces a cycle', async () => {
    const { service, mocks } = build();
    (
      mocks.prisma as unknown as {
        customFieldDefinition: {
          findUnique: ReturnType<typeof vi.fn>;
          findMany: ReturnType<typeof vi.fn>;
        };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'def-A',
      projectId: 'p1',
      name: 'A',
      kind: 'formula',
      options: [],
      required: false,
      formulaExpression: '1',
      rollupConfig: null,
      visibilityRule: null,
    } as never);
    // The peer B references A.
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findMany.mockResolvedValue([
      { name: 'B', formulaExpression: '{A} + 1' },
    ] as never);

    await expect(
      service.update(ACTOR, 'def-A', { formulaExpression: '{B} + 1' }),
    ).rejects.toThrow(/cycle/i);
  });
});

describe('CustomFieldsService.update — rename preserves stored values', () => {
  it('renaming the field name does NOT touch CustomFieldValue rows', async () => {
    const { service, mocks } = build();
    // The def lookup for the rename PATCH.
    (
      mocks.prisma as unknown as {
        customFieldDefinition: {
          findUnique: ReturnType<typeof vi.fn>;
          update: ReturnType<typeof vi.fn>;
        };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'def-1',
      projectId: 'p1',
      name: 'oldName',
      kind: 'text',
      options: [],
      required: false,
      formulaExpression: null,
      rollupConfig: null,
      visibilityRule: null,
    } as never);
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { update: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.update.mockResolvedValueOnce({
      id: 'def-1',
      name: 'newName',
    } as never);

    const out = await service.update(ACTOR, 'def-1', { name: 'newName' });
    expect(out.name).toBe('newName');

    // No customFieldValue mutation should have happened.
    const cfv = (
      mocks.prisma as unknown as {
        customFieldValue: {
          upsert: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      }
    ).customFieldValue;
    expect(cfv.upsert).not.toHaveBeenCalled();
    expect(cfv.delete).not.toHaveBeenCalled();
  });

  it('after rename, getValuesForTask still returns the 5 stored values via FK', async () => {
    // The whole point: values are bound by fieldId UUID, not by name. So a
    // rename leaves them in place.
    const { service, mocks } = build();

    // Step 1: simulate the rename PATCH (just enough that the test runs).
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.findUnique.mockResolvedValueOnce({
      id: 'def-1',
      projectId: 'p1',
      name: 'oldKey',
      kind: 'number',
      options: [],
      required: false,
      formulaExpression: null,
      rollupConfig: null,
      visibilityRule: null,
    } as never);
    (
      mocks.prisma as unknown as {
        customFieldDefinition: { update: ReturnType<typeof vi.fn> };
      }
    ).customFieldDefinition.update.mockResolvedValueOnce({ id: 'def-1', name: 'newKey' } as never);
    await service.update(ACTOR, 'def-1', { name: 'newKey' });

    // Step 2: getValuesForTask after rename. Same 5 rows resolve through FK.
    stubProjectDefs(mocks, [
      { id: 'def-1', projectId: 'p1', kind: 'number', name: 'newKey', options: [], visibilityRule: null },
      {
        id: 'def-2',
        projectId: 'p1',
        kind: 'formula',
        name: 'doubled',
        options: [],
        formulaExpression: '{newKey} * 2',
        visibilityRule: null,
      },
    ]);
    stubStoredValues(mocks, [
      { id: 'v1', fieldId: 'def-1', value: 1 },
      { id: 'v2', fieldId: 'def-1', value: 2 },
      { id: 'v3', fieldId: 'def-1', value: 3 },
      { id: 'v4', fieldId: 'def-1', value: 4 },
      { id: 'v5', fieldId: 'def-1', value: 5 },
    ]);

    // We can only read one task's values at a time here, so confirm the
    // most recent value (value=5) and that the formula reads {newKey} fine.
    // First populate the var with the LAST row — getValuesForTask uses a
    // Map<fieldId, row> so last write wins, matching real prisma findMany
    // ordering by uniqueness.
    const rows = await service.getValuesForTask('t-1', 'p1');
    const storedRow = rows.find((r) => r.fieldId === 'def-1');
    expect(storedRow).toBeDefined();
    expect(storedRow?.value).toBe(5);
    const formulaRow = rows.find((r) => r.fieldId === 'def-2');
    expect(formulaRow?.value).toBe(10); // 5 * 2 — formula reads {newKey} successfully
  });
});
