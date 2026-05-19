import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

import { ClamAVService } from './clamav.service';
import { ATTACHMENT_SCAN_QUEUE } from './attachments.service';

@Processor(ATTACHMENT_SCAN_QUEUE)
export class AttachmentScanProcessor extends WorkerHost {
  private readonly logger = new Logger(AttachmentScanProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly clamav: ClamAVService,
    private readonly events: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<{ attachmentId: string }>): Promise<void> {
    const att = await this.prisma.attachment.findUnique({ where: { id: job.data.attachmentId } });
    if (!att) return;

    let buf: Buffer;
    try {
      buf = await this.storage.getBuffer(att.storageKey);
    } catch (err) {
      this.logger.error({ err, key: att.storageKey }, 'failed to fetch object for scan');
      throw err;
    }

    const result = await this.clamav.scanBuffer(buf);
    if (result.clean) {
      await this.prisma.attachment.update({
        where: { id: att.id },
        data: { scanStatus: 'clean', scanResult: result.raw },
      });
      return;
    }

    // Infected: move to quarantine, mark in DB, emit event.
    await this.prisma.attachment.update({
      where: { id: att.id },
      data: { scanStatus: 'infected', scanResult: result.signature ?? result.raw },
    });
    await this.storage.moveToQuarantine(att.storageKey).catch((err) => {
      this.logger.error({ err }, 'failed to quarantine infected object');
    });
    this.events.emit('attachment.infected', {
      attachmentId: att.id,
      projectId: att.projectId,
      signature: result.signature,
    });
  }
}
