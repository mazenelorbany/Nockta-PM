// =============================================================================
// PDF serialiser — gated behind the optional `pdfkit` package.
//
// Same rationale as the xlsx renderer: most deployments don't generate PDFs,
// so we don't want pdfkit + its font files in the always-installed footprint.
// Dynamic import means a fresh checkout that doesn't install pdfkit still
// compiles + boots; the renderer throws a graceful "install pdfkit" error
// when the user actually tries a PDF export.
//
// Layout:
//   - Header: export name (bold, 16pt) + generated timestamp (10pt grey).
//   - Tabular body with the column headers repeated at the top of each
//     50-row chunk. Each chunk is followed by a page break.
//
// To enable: `pnpm add pdfkit --filter @nockta/api`.
// =============================================================================

import { InternalServerErrorException } from '@nestjs/common';

export const PDF_MISSING_MESSAGE =
  "PDF export requires the 'pdfkit' package. Run pnpm add pdfkit to enable.";

const ROWS_PER_PAGE = 50;

export async function renderPdf(
  exportName: string,
  columns: string[],
  rows: Array<Record<string, string | number | null>>,
  generatedAt: Date,
): Promise<Buffer> {
  // pdfkit is optional — when not installed, the dynamic import throws.
  let PdfModule: unknown;
  try {
    // @ts-expect-error — dependency is optional; type may not resolve.
    PdfModule = await import('pdfkit');
  } catch {
    throw new InternalServerErrorException(PDF_MISSING_MESSAGE);
  }
  const PDFDocument = (PdfModule as { default?: unknown }).default ?? PdfModule;
  // The pdfkit type signature is a constructor — cast through unknown to
  // avoid pulling @types/pdfkit just to compile this gated path. The chainable
  // methods are self-returning so callers can write `doc.fontSize(10).fillColor(...)`.
  type DocShape = PdfDoc & {
    addPage: () => DocShape;
    end: () => void;
    on: (event: string, cb: (chunk: Buffer | Uint8Array) => void) => DocShape;
  };
  const DocCtor = PDFDocument as unknown as new (options?: Record<string, unknown>) => DocShape;
  const doc = new DocCtor({ margin: 40, size: 'A4' });

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));

    try {
      // Header
      doc.fontSize(16).fillColor('#111').text(exportName);
      doc
        .fontSize(10)
        .fillColor('#666')
        .text(`Generated ${generatedAt.toISOString()}`);
      doc.moveDown(1);

      // Body in 50-row chunks. We re-emit the column header at the top of
      // every chunk so the user can scan a long report without scrolling
      // back to page 1.
      let cursor = 0;
      while (cursor < rows.length) {
        const chunk = rows.slice(cursor, cursor + ROWS_PER_PAGE);
        renderTable(doc, columns, chunk);
        cursor += ROWS_PER_PAGE;
        if (cursor < rows.length) doc.addPage();
      }
      if (rows.length === 0) {
        doc.fontSize(11).fillColor('#666').text('No rows.');
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// pdfkit's API is chainable — each method returns the doc — so we type each
// as self-returning so `doc.fontSize(10).fillColor(...)` typechecks.
interface PdfDoc {
  fontSize: (n: number) => PdfDoc;
  fillColor: (c: string) => PdfDoc;
  text: (s: string, ...args: unknown[]) => PdfDoc;
  moveDown: (lines?: number) => PdfDoc;
}

function renderTable(
  doc: PdfDoc,
  columns: string[],
  rows: Array<Record<string, string | number | null>>,
): void {
  doc.fontSize(10).fillColor('#000');
  doc.text(columns.join(' | '));
  doc.fillColor('#999').text('-'.repeat(Math.min(120, columns.join(' | ').length)));
  doc.fillColor('#111');
  for (const row of rows) {
    const line = columns
      .map((col) => {
        const raw = row[col];
        const s = raw === null || raw === undefined ? '' : String(raw);
        return s.length > 40 ? s.slice(0, 37) + '...' : s;
      })
      .join(' | ');
    doc.text(line);
  }
}
