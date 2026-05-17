// =============================================================================
// CSV serialiser — RFC-4180-ish.
//
// Hand-rolled (no papaparse dependency in this repo). The rules:
//   - Fields containing `,`, `"`, `\n`, or `\r` get wrapped in `"…"`.
//   - Embedded `"` characters become `""`.
//   - Records are joined with `\r\n` (the spec; Excel barfs on lone \n on
//     Windows).
//   - Numbers are stringified with `String(n)`; null/undefined → empty.
//
// This is intentionally tiny — a streaming version would be a worthwhile
// follow-up if we ever export >10k rows, but the processor caps the row
// fetch at 10_000 today.
// =============================================================================

export function renderCsv(
  columns: string[],
  rows: Array<Record<string, string | number | null>>,
): Buffer {
  const out: string[] = [];
  out.push(columns.map((c) => escapeField(c)).join(','));
  for (const row of rows) {
    const cells = columns.map((col) => {
      const raw = row[col];
      return escapeField(toCell(raw));
    });
    out.push(cells.join(','));
  }
  return Buffer.from(out.join('\r\n') + '\r\n', 'utf-8');
}

/** Public for tests — escape one CSV field. */
export function escapeField(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value);
}
