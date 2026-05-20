import { InternalServerErrorException } from '@nestjs/common';

import type {
  ProjectReportPayload,
  SprintReportPayload,
  SprintReportTaskRow,
  SprintReportUserRow,
} from './sprint-report.service';

// =============================================================================
// renderSprintReportPdf — produces a branded PDF for a sprint or project
// report. Distinct from the generic CSV-style `renderPdf` in
// exports/serializers/pdf.ts because the layout here is purpose-built: a
// brand header strip, a sprint/project meta block, summary tiles, and two
// tables (completed tasks + hours by user).
//
// Branding
// --------
// - "NOCKTA" wordmark rendered as bold typography in the brand purple
//   (#8B5CF6) — no image asset to ship.
// - Brand color used as the accent for tile values, section dividers, and
//   the row stripes on the tasks table.
// - Footer on every page: "Nockta Flow — generated {ts} by {name}".
//
// pdfkit is loaded via static import now that it ships as a real
// dependency (apps/api/package.json). The dynamic-import dance the CSV
// exporter does is no longer needed for this path; we keep that one
// optional because it's behind a feature flag.
// =============================================================================

const BRAND_HEX = '#8B5CF6';      // hsl(262, 84%, 60%) from packages/ui --brand dark
const BRAND_HEX_LIGHT = '#EDE7FE';
const TEXT_HEX = '#111827';
const MUTED_HEX = '#6B7280';
const DIVIDER_HEX = '#E5E7EB';

const PAGE_MARGIN = 48;

export async function renderSprintReportPdf(
  payload: SprintReportPayload | ProjectReportPayload,
): Promise<Buffer> {
  // pdfkit's default export is the PDFDocument constructor.
  let PdfModule: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    PdfModule = require('pdfkit');
  } catch (err) {
    throw new InternalServerErrorException(
      `Failed to load pdfkit: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const PDFDocument = (PdfModule as { default?: unknown }).default ?? PdfModule;
  const DocCtor = PDFDocument as unknown as new (
    options?: Record<string, unknown>,
  ) => PdfDoc;
  const doc = new DocCtor({ size: 'A4', margin: PAGE_MARGIN, info: { Title: pdfTitle(payload) } });

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));

    try {
      drawHeader(doc, payload);
      drawMetaBlock(doc, payload);
      drawSummaryTiles(doc, payload);
      drawCompletedTasks(doc, payload.completedTasks);
      drawByUser(doc, payload.byUser);
      drawFooter(doc, payload);
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// pdfkit's API is chainable; type each method as self-returning so we don't
// need @types/pdfkit's full surface area. Only the methods we actually use.
interface PdfDoc {
  page: { width: number; height: number; margins: { top: number; bottom: number; left: number; right: number } };
  x: number;
  y: number;
  fontSize: (n: number) => PdfDoc;
  fillColor: (c: string) => PdfDoc;
  strokeColor: (c: string) => PdfDoc;
  lineWidth: (n: number) => PdfDoc;
  font: (name: string) => PdfDoc;
  text: (s: string, x?: number | unknown, y?: number | unknown, options?: Record<string, unknown>) => PdfDoc;
  moveDown: (n?: number) => PdfDoc;
  moveTo: (x: number, y: number) => PdfDoc;
  lineTo: (x: number, y: number) => PdfDoc;
  stroke: () => PdfDoc;
  rect: (x: number, y: number, w: number, h: number) => PdfDoc;
  fill: () => PdfDoc;
  fillAndStroke: (fillColor?: string, strokeColor?: string) => PdfDoc;
  addPage: () => PdfDoc;
  end: () => void;
  on: (event: string, cb: (chunk: Buffer | Uint8Array) => void) => PdfDoc;
  widthOfString: (s: string) => number;
}

function pdfTitle(payload: SprintReportPayload | ProjectReportPayload): string {
  if (payload.kind === 'sprint') {
    return `${payload.project.key} · ${payload.sprint.name} · Nockta Flow`;
  }
  return `${payload.project.key} · Project Report · Nockta Flow`;
}

function drawHeader(doc: PdfDoc, payload: SprintReportPayload | ProjectReportPayload): void {
  // Coloured strip across the top with the Nockta wordmark on the left and
  // the report kind on the right.
  const stripHeight = 56;
  doc.rect(0, 0, doc.page.width, stripHeight).fillColor(BRAND_HEX).fill();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(
    'NOCKTA',
    PAGE_MARGIN,
    18,
    { lineBreak: false },
  );
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#EDE7FE')
    .text('FLOW', PAGE_MARGIN + 88, 27, { lineBreak: false });

  const label = payload.kind === 'sprint' ? 'Sprint Report' : 'Project Report';
  const labelWidth = doc.widthOfString(label);
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#ffffff')
    .text(label, doc.page.width - PAGE_MARGIN - labelWidth, 22, { lineBreak: false });

  doc.y = stripHeight + 24;
  doc.x = PAGE_MARGIN;
}

function drawMetaBlock(
  doc: PdfDoc,
  payload: SprintReportPayload | ProjectReportPayload,
): void {
  const title =
    payload.kind === 'sprint'
      ? `${payload.project.key} · ${payload.sprint.name}`
      : `${payload.project.key} · ${payload.project.name}`;
  doc.fillColor(TEXT_HEX).font('Helvetica-Bold').fontSize(20).text(title);
  doc.moveDown(0.2);

  if (payload.kind === 'sprint' && payload.sprint.goal) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor(MUTED_HEX).text(`"${payload.sprint.goal}"`);
    doc.moveDown(0.4);
  }

  const lines: string[] = [];
  lines.push(`Project: ${payload.project.name}`);
  if (payload.kind === 'sprint') {
    lines.push(`Sprint state: ${payload.sprint.state}`);
    if (payload.sprint.startDate && payload.sprint.endDate) {
      lines.push(
        `Sprint dates: ${fmtDate(payload.sprint.startDate)} → ${fmtDate(payload.sprint.endDate)}`,
      );
    }
  }
  lines.push(`Report window: ${fmtDate(payload.window.from)} → ${fmtDate(payload.window.to)}`);

  doc.font('Helvetica').fontSize(10).fillColor(MUTED_HEX);
  for (const line of lines) doc.text(line);

  doc.moveDown(0.6);
  drawDivider(doc);
  doc.moveDown(0.4);
}

function drawSummaryTiles(
  doc: PdfDoc,
  payload: SprintReportPayload | ProjectReportPayload,
): void {
  const totals = payload.totals;
  const tasksCompleted = totals.tasksCompleted;
  const totalHours = secsToHours(totals.totalSeconds);
  const avgHours = tasksCompleted === 0 ? 0 : totals.totalSeconds / tasksCompleted / 3600;

  const tiles: Array<[label: string, value: string]> = [
    ['Tasks completed', String(tasksCompleted)],
    ['Hours logged', formatHours(totalHours)],
    ['Avg hours / task', formatHours(avgHours)],
  ];

  const startY = doc.y;
  const usableWidth = doc.page.width - PAGE_MARGIN * 2;
  const gap = 12;
  const tileWidth = (usableWidth - gap * (tiles.length - 1)) / tiles.length;
  const tileHeight = 56;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    const x = PAGE_MARGIN + i * (tileWidth + gap);
    doc
      .rect(x, startY, tileWidth, tileHeight)
      .fillColor(BRAND_HEX_LIGHT)
      .fill();
    doc
      .fillColor(MUTED_HEX)
      .font('Helvetica')
      .fontSize(9)
      .text(t[0].toUpperCase(), x + 12, startY + 10, { lineBreak: false });
    doc
      .fillColor(BRAND_HEX)
      .font('Helvetica-Bold')
      .fontSize(22)
      .text(t[1], x + 12, startY + 24, { lineBreak: false });
  }
  doc.y = startY + tileHeight + 20;
}

function drawCompletedTasks(doc: PdfDoc, rows: SprintReportTaskRow[]): void {
  sectionTitle(doc, 'Completed tasks');
  if (rows.length === 0) {
    emptyState(doc, 'No tasks completed in this window.');
    return;
  }

  // Column geometry. We use absolute pixel widths so the table fits A4
  // (assumed 595pt wide, minus margins → ~499pt usable).
  const cols = [
    { key: 'key', label: 'Key', width: 64 },
    { key: 'title', label: 'Task', width: 220 },
    { key: 'assignee', label: 'Assignee', width: 110 },
    { key: 'hours', label: 'Hours', width: 50 },
    { key: 'completedAt', label: 'Completed', width: 55 },
  ] as const;
  drawTableHeader(doc, cols);
  let zebra = false;
  for (const r of rows) {
    ensureSpace(doc, 24);
    const rowY = doc.y;
    if (zebra) {
      const usableWidth = doc.page.width - PAGE_MARGIN * 2;
      doc.rect(PAGE_MARGIN, rowY - 2, usableWidth, 22).fillColor('#FAFAFA').fill();
    }
    zebra = !zebra;
    let x = PAGE_MARGIN;
    drawCell(doc, r.key, x, rowY, cols[0].width, { font: 'Helvetica-Bold', size: 9, color: BRAND_HEX });
    x += cols[0].width;
    drawCell(doc, truncate(r.title, 60), x, rowY, cols[1].width, { font: 'Helvetica', size: 9, color: TEXT_HEX });
    x += cols[1].width;
    drawCell(doc, r.assignee?.name ?? '—', x, rowY, cols[2].width, { font: 'Helvetica', size: 9, color: TEXT_HEX });
    x += cols[2].width;
    drawCell(doc, formatHours(secsToHours(r.loggedSeconds)), x, rowY, cols[3].width, {
      font: 'Helvetica',
      size: 9,
      color: TEXT_HEX,
      align: 'right',
    });
    x += cols[3].width;
    drawCell(doc, r.completedAt ? fmtDate(r.completedAt) : '—', x, rowY, cols[4].width, {
      font: 'Helvetica',
      size: 9,
      color: MUTED_HEX,
    });
    doc.y = rowY + 20;
  }
  doc.moveDown(0.5);
}

function drawByUser(doc: PdfDoc, users: SprintReportUserRow[]): void {
  sectionTitle(doc, 'Hours by user');
  if (users.length === 0) {
    emptyState(doc, 'No time logged in this window.');
    return;
  }
  const cols = [
    { key: 'name', label: 'Person', width: 200 },
    { key: 'email', label: 'Email', width: 220 },
    { key: 'tasks', label: 'Tasks', width: 40 },
    { key: 'hours', label: 'Hours', width: 40 },
  ] as const;
  drawTableHeader(doc, cols);
  let zebra = false;
  for (const r of users) {
    ensureSpace(doc, 24);
    const rowY = doc.y;
    if (zebra) {
      const usableWidth = doc.page.width - PAGE_MARGIN * 2;
      doc.rect(PAGE_MARGIN, rowY - 2, usableWidth, 22).fillColor('#FAFAFA').fill();
    }
    zebra = !zebra;
    let x = PAGE_MARGIN;
    drawCell(doc, r.user.name, x, rowY, cols[0].width, { font: 'Helvetica-Bold', size: 10, color: TEXT_HEX });
    x += cols[0].width;
    drawCell(doc, r.user.email, x, rowY, cols[1].width, { font: 'Helvetica', size: 9, color: MUTED_HEX });
    x += cols[1].width;
    drawCell(doc, String(r.taskCount), x, rowY, cols[2].width, { font: 'Helvetica', size: 9, color: TEXT_HEX, align: 'right' });
    x += cols[2].width;
    drawCell(doc, formatHours(secsToHours(r.totalSeconds)), x, rowY, cols[3].width, {
      font: 'Helvetica-Bold',
      size: 9,
      color: BRAND_HEX,
      align: 'right',
    });
    doc.y = rowY + 20;
  }
}

function drawFooter(
  doc: PdfDoc,
  payload: SprintReportPayload | ProjectReportPayload,
): void {
  const footer = `Nockta Flow — generated ${fmtDateTime(payload.generatedAt)} by ${payload.generatedBy.name} <${payload.generatedBy.email}>`;
  const y = doc.page.height - 28;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED_HEX);
  doc.text(footer, PAGE_MARGIN, y, {
    width: doc.page.width - PAGE_MARGIN * 2,
    align: 'center',
    lineBreak: false,
  });
}

// ----- low-level helpers -----

function drawDivider(doc: PdfDoc): void {
  const y = doc.y;
  doc
    .moveTo(PAGE_MARGIN, y)
    .lineTo(doc.page.width - PAGE_MARGIN, y)
    .strokeColor(DIVIDER_HEX)
    .lineWidth(1)
    .stroke();
  doc.y = y + 4;
}

function sectionTitle(doc: PdfDoc, text: string): void {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.fillColor(TEXT_HEX).font('Helvetica-Bold').fontSize(12).text(text);
  // Brand-colored underline accent — short, only as wide as the label.
  const width = doc.widthOfString(text);
  const y = doc.y;
  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + width, y).strokeColor(BRAND_HEX).lineWidth(1.5).stroke();
  doc.moveDown(0.5);
}

function emptyState(doc: PdfDoc, text: string): void {
  doc.fillColor(MUTED_HEX).font('Helvetica-Oblique').fontSize(10).text(text);
  doc.moveDown(0.5);
}

function drawTableHeader(
  doc: PdfDoc,
  cols: ReadonlyArray<{ label: string; width: number }>,
): void {
  const y = doc.y;
  let x = PAGE_MARGIN;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED_HEX);
  for (const c of cols) {
    doc.text(c.label.toUpperCase(), x, y, { width: c.width, lineBreak: false });
    x += c.width;
  }
  doc.y = y + 14;
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor(DIVIDER_HEX)
    .lineWidth(0.5)
    .stroke();
  doc.y += 4;
}

interface CellOpts {
  font: string;
  size: number;
  color: string;
  align?: 'left' | 'right' | 'center';
}

function drawCell(doc: PdfDoc, text: string, x: number, y: number, w: number, opts: CellOpts): void {
  doc
    .font(opts.font)
    .fontSize(opts.size)
    .fillColor(opts.color)
    .text(text, x + 4, y + 4, {
      width: w - 8,
      align: opts.align ?? 'left',
      lineBreak: false,
      ellipsis: true,
    });
}

function ensureSpace(doc: PdfDoc, needed: number): void {
  if (doc.y + needed > doc.page.height - 40) {
    doc.addPage();
    doc.y = PAGE_MARGIN;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function secsToHours(sec: number): number {
  return sec / 3600;
}

function formatHours(h: number): string {
  if (h === 0) return '—';
  if (Number.isInteger(h)) return `${h}h`;
  return `${h.toFixed(1)}h`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
