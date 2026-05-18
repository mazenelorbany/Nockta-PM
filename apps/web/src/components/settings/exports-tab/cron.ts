// =============================================================================
// Client-side cron sanity check. Doesn't replicate the server's full grammar
// (the API will reject anything more exotic), just catches the common typos.
// =============================================================================
export function isLikelyValidCron(s: string): boolean {
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  return parts.every((part, i) => isValidCronField(part, ranges[i]![0], ranges[i]![1]));
}

function isValidCronField(field: string, lo: number, hi: number): boolean {
  if (field === '*') return true;
  for (const segment of field.split(',')) {
    let range = segment;
    if (segment.includes('/')) {
      const [r, step] = segment.split('/');
      range = r ?? '*';
      if (!/^\d+$/.test(step ?? '')) return false;
    }
    if (range === '*') continue;
    if (range.includes('-')) {
      const [a, b] = range.split('-');
      const na = Number(a);
      const nb = Number(b);
      if (!Number.isInteger(na) || !Number.isInteger(nb)) return false;
      if (na < lo || nb > hi || na > nb) return false;
    } else {
      const n = Number(range);
      if (!Number.isInteger(n) || n < lo || n > hi) return false;
    }
  }
  return true;
}
