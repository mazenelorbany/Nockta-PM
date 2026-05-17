// =============================================================================
// XLSX serialiser — gated behind the optional `exceljs` package.
//
// Reasoning for gating: exceljs is ~3MB installed and pulls in a long
// transitive tail. The vast majority of Nockta deployments only ever export
// CSV — adding exceljs to the always-installed dep list would slow down
// every CI run for a feature 5% of customers use. Instead the import is
// dynamic; if the package isn't installed the renderer throws a clear,
// user-actionable error.
//
// To enable: `pnpm add exceljs --filter @nockta/api`.
// =============================================================================

export const XLSX_MISSING_MESSAGE =
  "XLSX export requires the 'exceljs' package. Run pnpm add exceljs to enable.";

export async function renderXlsx(
  sheetName: string,
  columns: string[],
  rows: Array<Record<string, string | number | null>>,
): Promise<Buffer> {
  // exceljs is an optional dep — when not installed, the dynamic import throws
  // and we surface a friendlier error to the operator. `as unknown` keeps tsc
  // happy regardless of whether @types/exceljs / exceljs are present in
  // node_modules at typecheck time.
  let ExcelJS: unknown;
  try {
    // @ts-expect-error — dependency is optional; type may not resolve.
    ExcelJS = await import('exceljs');
  } catch {
    throw new Error(XLSX_MISSING_MESSAGE);
  }

  // The module shape is either `{ default: { Workbook } }` (ESM-wrapped) or
  // the bare workbook constructor namespace (CJS). Both expose `.Workbook`.
  const mod = (ExcelJS as { default?: unknown }).default ?? ExcelJS;
  const ExcelMod = mod as {
    Workbook: new () => {
      columns: Array<{ header: string; key: string; width: number }>;
      addWorksheet(name: string): {
        columns: Array<{ header: string; key: string; width: number }>;
        addRow(row: Record<string, unknown>): void;
        getRow(n: number): { font: { bold?: boolean } };
      };
      xlsx: { writeBuffer(): Promise<ArrayBuffer> };
    };
  };
  const workbook = new ExcelMod.Workbook();
  // Sheet names cap at 31 chars in Excel; trim defensively.
  const safeName = sheetName.slice(0, 31) || 'Export';
  const sheet = workbook.addWorksheet(safeName);

  sheet.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(10, c.length + 2)) }));
  for (const row of rows) {
    sheet.addRow(row);
  }
  // Make the header row bold so the user can scan columns at a glance.
  const header = sheet.getRow(1);
  header.font = { bold: true };

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
