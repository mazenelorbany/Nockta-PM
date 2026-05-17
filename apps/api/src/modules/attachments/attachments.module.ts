import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StorageModule } from '../storage/storage.module';
import { AttachmentScanProcessor } from './attachment-scan.processor';
import { AttachmentThumbnailProcessor } from './attachment-thumb.processor';
import { ATTACHMENT_SCAN_QUEUE, ATTACHMENT_THUMB_QUEUE, AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import { ClamAVService } from './clamav.service';

@Module({
  imports: [
    StorageModule,
    BullModule.registerQueue({ name: ATTACHMENT_SCAN_QUEUE }),
    BullModule.registerQueue({ name: ATTACHMENT_THUMB_QUEUE }),
  ],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    AttachmentScanProcessor,
    AttachmentThumbnailProcessor,
    ClamAVService,
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
