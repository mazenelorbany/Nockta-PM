import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import sharp from 'sharp';

import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

import { ATTACHMENT_THUMB_QUEUE } from './attachments.service';

/**
 * Thumbnail extraction for images, videos, and PDFs.
 *
 * Images go straight through sharp. Videos shell out to `ffmpeg` (first
 * keyframe ~1s in). PDFs shell out to `pdftocairo` from poppler-utils
 * (page 1 only). The resulting raster is then handed back to sharp for the
 * 200/800 WebP downscale so every variant uses the same image pipeline.
 *
 * Container image must include `ffmpeg` and `poppler-utils` (see
 * apps/api/Dockerfile).
 */
@Processor(ATTACHMENT_THUMB_QUEUE)
export class AttachmentThumbnailProcessor extends WorkerHost {
  private readonly logger = new Logger(AttachmentThumbnailProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<{ attachmentId: string }>): Promise<void> {
    const att = await this.prisma.attachment.findUnique({ where: { id: job.data.attachmentId } });
    if (!att) return;

    let rasterBuffer: Buffer | null = null;
    try {
      if (att.mimeType.startsWith('image/')) {
        rasterBuffer = await this.storage.getBuffer(att.storageKey);
      } else if (att.mimeType.startsWith('video/')) {
        rasterBuffer = await this.extractVideoFrame(att.storageKey);
      } else if (att.mimeType === 'application/pdf') {
        rasterBuffer = await this.extractPdfFirstPage(att.storageKey);
      } else {
        return; // unsupported media — leave thumbnail nulls in place
      }
    } catch (err) {
      this.logger.warn(
        `Thumbnail extraction failed for ${att.id} (${att.mimeType}): ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (!rasterBuffer) return;

    const [thumb200, thumb800] = await Promise.all([
      sharp(rasterBuffer).rotate().resize({ width: 200, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
      sharp(rasterBuffer).rotate().resize({ width: 800, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
    ]);
    const thumb200Key = `${att.storageKey}.thumb-200.webp`;
    const thumb800Key = `${att.storageKey}.thumb-800.webp`;
    await Promise.all([
      this.storage.putBuffer(thumb200Key, thumb200, 'image/webp'),
      this.storage.putBuffer(thumb800Key, thumb800, 'image/webp'),
    ]);
    await this.prisma.attachment.update({
      where: { id: att.id },
      data: { thumb200Key, thumb800Key },
    });
  }

  private async extractVideoFrame(storageKey: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'nockta-thumb-'));
    const inputPath = join(dir, 'in.bin');
    const outputPath = join(dir, 'frame.jpg');
    try {
      const buf = await this.storage.getBuffer(storageKey);
      await writeFile(inputPath, buf);
      // -ss 00:00:01 → seek to 1 second; -frames:v 1 → grab exactly one frame;
      // -vf "scale=1280:-2" → cap width at 1280 to keep ffmpeg fast and sharp
      //   handles the final downscale.
      await spawnAndWait('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-ss', '00:00:01.000',
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', 'scale=1280:-2',
        outputPath,
      ]);
      return await readFile(outputPath);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extractPdfFirstPage(storageKey: string): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'nockta-thumb-'));
    const inputPath = join(dir, 'in.pdf');
    const outputPrefix = join(dir, 'page');
    try {
      const buf = await this.storage.getBuffer(storageKey);
      await writeFile(inputPath, buf);
      // pdftocairo -png -singlefile -r 100 produces `<prefix>.png` for page 1.
      await spawnAndWait('pdftocairo', [
        '-png', '-singlefile', '-r', '100',
        '-f', '1', '-l', '1',
        inputPath, outputPrefix,
      ]);
      return await readFile(`${outputPrefix}.png`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function spawnAndWait(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}
