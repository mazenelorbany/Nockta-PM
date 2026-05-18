import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import {
  ExportsService,
  EXPORT_SIGNED_URL_TTL_SECONDS,
  cronMatchesMinute,
  parseCron,
} from './exports.service';
import { escapeField, renderCsv } from './serializers/csv';
import { renderXlsx, XLSX_MISSING_MESSAGE } from './serializers/xlsx';

// =============================================================================
// exports.service — behaviours that must not regress:
//
//   - CSV serialisation correctly escapes commas, quotes, and newlines.
//   - getDownloadUrl returns a URL whose expiry is exactly TTL after the run's
//     createdAt (we mock Date so the assertion is deterministic).
//   - fireDueSchedules creates an ExportRun row when the cron matches the
//     supplied tick time.
//   - XLSX serialisation throws a clear, user-actionable error when exceljs
//     isn't installed — the dynamic import returns ENOTFOUND and we surface
//     that as a graceful error rather than a stack trace.
//   - Cron parser accepts the standard 5-field syntax and rejects garbage.
// =============================================================================

const ADMIN: AuthenticatedUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@nockta.com',
  kind: 'internal',
  companyRole: 'Admin',
} as AuthenticatedUser;

interface Built {
  service: ExportsService;
  prisma: PrismaService;
  queue: { add: ReturnType<typeof vi.fn> };
}

function build(): Built {
  const prisma = makePrismaMock();
  const queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
  const service = new ExportsService(
    prisma,
    queue as unknown as Queue,
  );
  service.onModuleInit();
  return { service, prisma, queue };
}

// =============================================================================
// CSV escaping
// =============================================================================

describe('CSV serializer', () => {
  it('escapes commas, quotes, and newlines correctly', () => {
    // The killer cases for naïve CSV writers — verify each one round-trips
    // through escapeField + renderCsv as a reader would expect.
    expect(escapeField('hello')).toBe('hello');
    expect(escapeField('a,b')).toBe('"a,b"');
    expect(escapeField('she said "hi"')).toBe('"she said ""hi"""');
    expect(escapeField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('builds a header row plus escaped data rows', () => {
    const buf = renderCsv(
      ['name', 'note'],
      [
        { name: 'Plain', note: 'nothing special' },
        { name: 'Comma, here', note: 'Quote "inside"' },
        { name: 'New\nline', note: null },
      ],
    );
    const text = buf.toString('utf-8');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('name,note');
    expect(lines[1]).toBe('Plain,nothing special');
    expect(lines[2]).toBe('"Comma, here","Quote ""inside"""');
    expect(lines[3]).toBe('"New\nline",');
    // Trailing CRLF intentionally — many CSV consumers (Excel, Numbers)
    // expect the file to end with a record terminator.
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('handles numeric and null values without crashing', () => {
    const buf = renderCsv(
      ['n', 'maybe'],
      [
        { n: 42, maybe: null },
        { n: 0, maybe: '' },
      ],
    );
    const text = buf.toString('utf-8');
    expect(text).toContain('42,');
    expect(text).toContain('0,');
  });
});

// =============================================================================
// Cron parser + matcher
// =============================================================================

describe('cron parser', () => {
  it('accepts standard 5-field expressions', () => {
    expect(() => parseCron('* * * * *')).not.toThrow();
    expect(() => parseCron('0 9 * * 1')).not.toThrow();
    expect(() => parseCron('*/15 * * * *')).not.toThrow();
    expect(() => parseCron('0 0 1,15 * *')).not.toThrow();
    expect(() => parseCron('0 9-17 * * 1-5')).not.toThrow();
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('not a cron')).toThrow();
    expect(() => parseCron('* * * *')).toThrow(); // 4 fields
    expect(() => parseCron('60 * * * *')).toThrow(); // minute out of range
    expect(() => parseCron('* 24 * * *')).toThrow(); // hour out of range
  });

  it('cronMatchesMinute respects every field', () => {
    // 09:00 UTC on Mon, 1 Jan 2024 (a Monday).
    const mondayNine = new Date('2024-01-01T09:00:00Z');
    expect(cronMatchesMinute('0 9 * * 1', mondayNine)).toBe(true);
    expect(cronMatchesMinute('5 9 * * 1', mondayNine)).toBe(false);
    expect(cronMatchesMinute('0 9 * * 2', mondayNine)).toBe(false);
    expect(cronMatchesMinute('* * * * *', mondayNine)).toBe(true);
  });
});

// =============================================================================
// Signed URL expiry
// =============================================================================

describe('getDownloadUrl', () => {
  let built: Built;
  beforeEach(() => {
    built = build();
    vi.useFakeTimers();
    // Pin the clock so the assertions are deterministic. 2024-06-15T12:00 UTC
    // is a Saturday — no special semantics, just a stable point.
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the run URL with expiresAt = TTL after run.createdAt', async () => {
    const createdAt = new Date('2024-06-15T12:00:00Z');
    const expiresAt = new Date(createdAt.getTime() + EXPORT_SIGNED_URL_TTL_SECONDS * 1000);

    vi.mocked(built.prisma.exportRun.findUnique).mockResolvedValueOnce({
      id: 'run-1',
      scheduleId: null,
      kind: 'csv',
      status: 'completed',
      signedUrl: 'https://example.com/r/run-1.csv',
      storageKey: 'exports/run-1.csv',
      expiresAt,
      fileSize: 1024,
      rowCount: 10,
      sourceKind: 'all_tasks',
      sourceId: null,
      errorMessage: null,
      createdAt,
      completedAt: createdAt,
    } as never);
    // Inline run path → kind=internal admin is sufficient ownership check.

    const result = await built.service.getDownloadUrl(ADMIN, 'run-1');
    expect(result.url).toBe('https://example.com/r/run-1.csv');
    // Expiry is exactly TTL after createdAt.
    expect(new Date(result.expiresAt).getTime()).toBe(expiresAt.getTime());
    expect(new Date(result.expiresAt).getTime() - createdAt.getTime()).toBe(
      EXPORT_SIGNED_URL_TTL_SECONDS * 1000,
    );
  });

  it('rejects expired URLs', async () => {
    const createdAt = new Date('2024-06-14T11:00:00Z'); // > 24h before "now"
    vi.mocked(built.prisma.exportRun.findUnique).mockResolvedValueOnce({
      id: 'run-2',
      scheduleId: null,
      kind: 'csv',
      status: 'completed',
      signedUrl: 'https://example.com/r/run-2.csv',
      storageKey: 'exports/run-2.csv',
      expiresAt: new Date(createdAt.getTime() + EXPORT_SIGNED_URL_TTL_SECONDS * 1000),
      fileSize: 1024,
      rowCount: 10,
      sourceKind: 'all_tasks',
      sourceId: null,
      errorMessage: null,
      createdAt,
      completedAt: createdAt,
    } as never);
    await expect(built.service.getDownloadUrl(ADMIN, 'run-2')).rejects.toThrow(/expired/i);
  });

  it('refuses to return a URL for an unfinished run', async () => {
    const createdAt = new Date('2024-06-15T11:59:00Z');
    vi.mocked(built.prisma.exportRun.findUnique).mockResolvedValueOnce({
      id: 'run-3',
      scheduleId: null,
      kind: 'csv',
      status: 'running',
      signedUrl: null,
      storageKey: null,
      expiresAt: null,
      fileSize: 0,
      rowCount: 0,
      sourceKind: 'all_tasks',
      sourceId: null,
      errorMessage: null,
      createdAt,
      completedAt: null,
    } as never);
    await expect(built.service.getDownloadUrl(ADMIN, 'run-3')).rejects.toThrow(/running/);
  });
});

// =============================================================================
// fireDueSchedules
// =============================================================================

describe('fireDueSchedules', () => {
  let built: Built;
  beforeEach(() => {
    built = build();
  });

  it('creates an ExportRun and enqueues a job when the cron matches the tick', async () => {
    // Monday 09:00 UTC. Schedule cron '0 9 * * 1' fires exactly here.
    const tick = new Date('2024-01-01T09:00:00Z');

    vi.mocked(built.prisma.exportSchedule.findMany).mockResolvedValueOnce([
      {
        id: 'sched-1',
        workspaceId: 'default',
        name: 'Monday brief',
        kind: 'csv',
        sourceKind: 'all_tasks',
        sourceId: null,
        scheduleCron: '0 9 * * 1',
        deliveryKind: 'download',
        deliveryEmailNew: null,
        enabled: true,
        lastRunAt: null,
      } as never,
    ]);
    vi.mocked(built.prisma.exportRun.create).mockResolvedValueOnce({
      id: 'run-1',
      scheduleId: 'sched-1',
      kind: 'csv',
      status: 'queued',
      signedUrl: null,
      storageKey: null,
      expiresAt: new Date(tick.getTime() + EXPORT_SIGNED_URL_TTL_SECONDS * 1000),
      fileSize: 0,
      rowCount: 0,
      sourceKind: 'all_tasks',
      sourceId: null,
      errorMessage: null,
      createdAt: tick,
      completedAt: null,
    } as never);
    vi.mocked(built.prisma.exportSchedule.update).mockResolvedValueOnce({} as never);

    const fired = await built.service.fireDueSchedules(tick);

    expect(fired).toBe(1);
    expect(built.prisma.exportRun.create).toHaveBeenCalledTimes(1);
    // Job enqueued with jobId = runId so a re-tick of the same minute is
    // an idempotent no-op at the queue layer.
    expect(built.queue.add).toHaveBeenCalledTimes(1);
    const addCall = built.queue.add.mock.calls[0];
    expect(addCall?.[0]).toBe('export');
    expect(addCall?.[1]).toEqual({ runId: 'run-1' });
    expect(addCall?.[2]?.jobId).toBe('run-1');
  });

  it('does NOT fire a schedule whose cron does not match the tick', async () => {
    const tick = new Date('2024-01-01T10:00:00Z'); // hour mismatch
    vi.mocked(built.prisma.exportSchedule.findMany).mockResolvedValueOnce([
      {
        id: 'sched-1',
        workspaceId: 'default',
        name: 'Monday brief',
        kind: 'csv',
        sourceKind: 'all_tasks',
        sourceId: null,
        scheduleCron: '0 9 * * 1',
        deliveryKind: 'download',
        deliveryEmailNew: null,
        enabled: true,
        lastRunAt: null,
      } as never,
    ]);

    const fired = await built.service.fireDueSchedules(tick);
    expect(fired).toBe(0);
    expect(built.prisma.exportRun.create).not.toHaveBeenCalled();
    expect(built.queue.add).not.toHaveBeenCalled();
  });

  it('does not double-fire a schedule whose lastRunAt is the same minute', async () => {
    const tick = new Date('2024-01-01T09:00:00Z');
    vi.mocked(built.prisma.exportSchedule.findMany).mockResolvedValueOnce([
      {
        id: 'sched-1',
        workspaceId: 'default',
        name: 'Monday brief',
        kind: 'csv',
        sourceKind: 'all_tasks',
        sourceId: null,
        scheduleCron: '0 9 * * 1',
        deliveryKind: 'download',
        deliveryEmailNew: null,
        enabled: true,
        lastRunAt: new Date('2024-01-01T09:00:00Z'),
      } as never,
    ]);
    const fired = await built.service.fireDueSchedules(tick);
    expect(fired).toBe(0);
    expect(built.queue.add).not.toHaveBeenCalled();
  });
});

// =============================================================================
// XLSX graceful-error fallback
// =============================================================================

describe('XLSX serializer fallback', () => {
  it("throws a user-actionable error when exceljs isn't installed", async () => {
    // `exceljs` is intentionally NOT in apps/api's dependency list — the
    // dynamic import inside renderXlsx therefore fails at module-resolution
    // time, and the renderer translates the failure into the documented
    // user-actionable message. The API surfaces this verbatim in the run's
    // errorMessage column so the user sees `pnpm add exceljs to enable`
    // instead of a Node `Cannot find module` stack trace.
    await expect(
      renderXlsx('Sheet', ['a'], [{ a: 'x' }]),
    ).rejects.toThrow(XLSX_MISSING_MESSAGE);
  });

  // The "package IS installed" path is covered by a separate integration
  // suite (not run in this file) that ships only when exceljs is part of
  // the install set. Keeping the suite green without the dep is the
  // whole point of the gating pattern.
});

// =============================================================================
// runOnce smoke — make sure the inline path enqueues a job and persists a run
// =============================================================================

describe('runOnce (inline)', () => {
  it('creates an ExportRun with status=queued and enqueues a job', async () => {
    const built = build();
    vi.mocked(built.prisma.exportRun.create).mockResolvedValueOnce({
      id: 'run-x',
      scheduleId: null,
      kind: 'csv',
      status: 'queued',
      signedUrl: null,
      storageKey: null,
      expiresAt: new Date(Date.now() + EXPORT_SIGNED_URL_TTL_SECONDS * 1000),
      fileSize: 0,
      rowCount: 0,
      sourceKind: 'all_tasks',
      sourceId: null,
      errorMessage: null,
      createdAt: new Date(),
      completedAt: null,
    } as never);

    const run = await built.service.runOnce(ADMIN, {
      inline: { kind: 'csv', sourceKind: 'all_tasks' },
    });

    expect(run.status).toBe('queued');
    expect(built.queue.add).toHaveBeenCalledTimes(1);
    expect(built.queue.add.mock.calls[0]?.[1]).toEqual({ runId: 'run-x' });
  });

  it('rejects an inline run with sourceKind=project but no sourceId', async () => {
    const built = build();
    await expect(
      built.service.runOnce(ADMIN, {
        inline: { kind: 'csv', sourceKind: 'project' } as never,
      }),
    ).rejects.toThrow(/sourceId required/);
  });
});
