import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../auth/mail.service';

// =============================================================================
// DigestSinkService — terminal handler for `notification.digest_ready`.
//
// The digest service rolls events into a single bucket per user and emits one
// `notification.digest_ready` event when the bucket is flushed (10 items, or
// 5 minutes elapsed). For a long time nothing subscribed to that event: a
// user who enabled digest mode silently lost every notification — no bell
// row, no email, no chat. This service closes that gap.
//
// Delivery strategy:
//
//   1. Always persist one in-app Notification row per item so the bell badge
//      stays coherent (matches non-digest mode's per-item behaviour). The
//      user sees a burst of N rows at flush time, which is the digest's
//      whole point: collapse N delivery interruptions into one.
//
//   2. If the user's `digestChannel` is 'email', build a text summary and
//      send it via MailService. Failures are logged and swallowed — in-app
//      already covered the recipient; a transient SMTP outage shouldn't
//      take the digest down.
//
//   3. If `digestChannel` is 'chat', emit a single `chat.dispatch_required`
//      event with `type='DigestSummary'`. The existing chat-dispatcher picks
//      it up and renders via the new DigestSummary case in card-builders.
//      One consolidated card honours the "fewer interruptions" intent of
//      digest mode (per-item fan-out would defeat the feature).
// =============================================================================

interface DigestItem {
  notificationType: string;
  payload: Record<string, unknown>;
  taskId: string | null;
  projectId: string | null;
  reason: string;
  queuedAt: string;
}

interface DigestReadyEvent {
  digestId: string;
  recipientUserId: string;
  channelKind: string;
  firstQueuedAt: string;
  totalCount: number;
  grouped: {
    mentions: DigestItem[];
    assignments: DigestItem[];
    blocked: DigestItem[];
    dueSoon: DigestItem[];
    other: DigestItem[];
  };
  items: DigestItem[];
}

@Injectable()
export class DigestSinkService implements OnModuleInit {
  private readonly logger = new Logger(DigestSinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.emitter.on('notification.digest_ready', (payload) => {
      void this.deliver(payload as DigestReadyEvent);
    });
  }

  private async deliver(evt: DigestReadyEvent): Promise<void> {
    if (evt.items.length === 0) return;

    // 1. In-app rows. createMany over a per-item loop because the bell only
    //    cares about the row existing; we don't need the returned ids.
    try {
      await this.prisma.notification.createMany({
        data: evt.items.map((it) => ({
          recipientUserId: evt.recipientUserId,
          type: it.notificationType,
          payload: { ...it.payload, reason: it.reason, viaDigest: evt.digestId },
          relatedTaskId: it.taskId,
          relatedProjectId: it.projectId,
        })),
      });
    } catch (err) {
      this.logger.warn(
        `digest ${evt.digestId}: failed to persist in-app rows — ${err instanceof Error ? err.message : err}`,
      );
    }

    // 2. Channel fan-out.
    if (evt.channelKind === 'email') {
      await this.sendEmailDigest(evt).catch((err) => {
        this.logger.error(
          { digestId: evt.digestId, recipient: evt.recipientUserId, err },
          'digest email delivery failed — in-app rows were still persisted',
        );
      });
    } else if (evt.channelKind === 'chat') {
      // Hand off to chat-dispatcher via the existing per-notification event
      // shape. The DigestSummary type is rendered as a single consolidated
      // card by card-builders, so the user gets one chat ping, not N.
      this.emitter.emit('chat.dispatch_required', {
        recipientUserId: evt.recipientUserId,
        type: 'DigestSummary',
        payload: {
          totalCount: evt.totalCount,
          firstQueuedAt: evt.firstQueuedAt,
          groupedCounts: {
            mentions: evt.grouped.mentions.length,
            assignments: evt.grouped.assignments.length,
            blocked: evt.grouped.blocked.length,
            dueSoon: evt.grouped.dueSoon.length,
            other: evt.grouped.other.length,
          },
        },
        taskId: null,
        projectId: null,
        reason: 'digest',
      });
    } else {
      // Unknown channel — bell already covered it; warn once so misconfig
      // surfaces in logs.
      this.logger.warn(
        `digest ${evt.digestId}: unknown channelKind="${evt.channelKind}", skipping out-of-band delivery`,
      );
    }
  }

  private async sendEmailDigest(evt: DigestReadyEvent): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: evt.recipientUserId },
      select: { email: true, name: true },
    });
    if (!user) return;

    const lines: string[] = [];
    lines.push(`Hi ${user.name},`);
    lines.push('');
    lines.push(`Here's a summary of ${evt.totalCount} notification${evt.totalCount === 1 ? '' : 's'} from Nockta Flow.`);
    lines.push('');

    const sections: Array<[string, DigestItem[]]> = [
      ['Mentions', evt.grouped.mentions],
      ['Assignments', evt.grouped.assignments],
      ['Blocked', evt.grouped.blocked],
      ['Due soon / overdue', evt.grouped.dueSoon],
      ['Other', evt.grouped.other],
    ];
    for (const [heading, items] of sections) {
      if (items.length === 0) continue;
      lines.push(`— ${heading} (${items.length}) —`);
      for (const it of items.slice(0, 10)) {
        const title = (it.payload['title'] as string | undefined) ?? it.notificationType;
        const link = it.taskId ? ` — ${Env.APP_URL_INTERNAL}/tasks/${it.taskId}` : '';
        lines.push(`  • ${title}${link}`);
      }
      if (items.length > 10) lines.push(`  …and ${items.length - 10} more`);
      lines.push('');
    }
    lines.push(`Open the inbox: ${Env.APP_URL_INTERNAL}/notifications`);

    await this.mail.send({
      to: user.email,
      subject: `[Nockta] Digest — ${evt.totalCount} update${evt.totalCount === 1 ? '' : 's'}`,
      text: lines.join('\n'),
    });
  }
}
