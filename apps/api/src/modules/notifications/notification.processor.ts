import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';

import { NOTIFICATION_QUEUE } from './notification-dispatcher.service';

interface NotificationJob {
  recipientUserId: string;
  type: string;
  // Email was removed as a notification channel (spec §10). Gmail SMTP is
  // reserved for magic-link delivery, handled directly by AuthModule.
  channels: { inApp: boolean; chat: boolean };
  payload: Record<string, unknown>;
  taskId: string | null;
  projectId: string | null;
  reason: string;
  enqueuedAt: string;
}

@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<NotificationJob>): Promise<void> {
    const { recipientUserId, type, channels, payload, taskId, projectId, reason } = job.data;

    // 1. In-app: persist + broadcast (always on).
    if (channels.inApp) {
      const notification = await this.prisma.notification.create({
        data: {
          recipientUserId,
          type,
          payload: { ...payload, reason },
          relatedTaskId: taskId,
          relatedProjectId: projectId,
        },
      });
      // notification.created drives the realtime badge update via RealtimeBroadcaster.
      this.emitter.emit('notification.created', {
        notificationId: notification.id,
        recipientUserId,
        type,
        relatedTaskId: taskId,
        relatedProjectId: projectId,
      });
    }

    // 2. Chat: hand off to the Chat module via a domain event. Chat module subscribes and actually sends.
    if (channels.chat) {
      this.emitter.emit('chat.dispatch_required', {
        recipientUserId,
        type,
        payload,
        taskId,
        projectId,
        reason,
      });
    }
  }
}
