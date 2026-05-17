import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { WebPushService, type PushPayload } from './web-push.service';

// =============================================================================
// WebPushListener — fan-out hinge.
//
// The existing NotificationProcessor emits `notification.created` after it
// writes a row + asks the chat dispatcher to deliver. We hook the SAME
// event so web push runs in parallel: same recipient resolution, same
// mute/snooze gates already applied upstream. This keeps the dispatcher
// untouched (Pass 1 ownership boundary — we cannot edit
// notifications.service.ts).
//
// Payload shape mirrors what the React client expects in its SW push handler:
//   { title, body, url?, tag? }
// We synthesize title/body from the notification type + payload fields the
// dispatcher already passes through.
// =============================================================================

interface NotificationCreatedEvent {
  notificationId: string;
  recipientUserId: string;
  type: string;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
}

@Injectable()
export class WebPushListener {
  private readonly logger = new Logger(WebPushListener.name);

  constructor(
    private readonly webPush: WebPushService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('notification.created', { async: true })
  async onNotificationCreated(event: NotificationCreatedEvent): Promise<void> {
    if (!this.webPush.isConfigured()) return;
    try {
      // Re-read the notification so we have access to its payload for
      // synthesizing a body. The dispatcher passes only ids on the event
      // bus by design (so listeners don't get stale payload snapshots).
      const n = await this.prisma.notification.findUnique({
        where: { id: event.notificationId },
      });
      if (!n) return;
      const payload = synthPayload(event.type, n.payload as Record<string, unknown> | null, {
        taskId: event.relatedTaskId,
        projectId: event.relatedProjectId,
      });
      await this.webPush.dispatch(event.recipientUserId, payload);
    } catch (err) {
      this.logger.warn(
        `web push dispatch on notification.created failed: ${(err as Error).message}`,
      );
    }
  }
}

// =============================================================================
// Notification → push payload mapping. We pick title + body from the
// notification's payload bag (whatever the dispatcher passed). Falls back
// gracefully so a malformed payload still surfaces *something* useful.
// =============================================================================

function synthPayload(
  type: string,
  raw: Record<string, unknown> | null,
  ctx: { taskId: string | null; projectId: string | null },
): PushPayload {
  const r = raw ?? {};
  const taskKey = stringOr(r['taskKey'], null);
  const taskTitle = stringOr(r['taskTitle'], null);
  const actor = stringOr(r['actorName'], null);
  const title = headlineFor(type, { taskKey, actor });
  const body = bodyFor(type, { taskTitle, actor }) ?? title;
  const url = ctx.taskId
    ? `/?task=${ctx.taskId}`
    : ctx.projectId
      ? `/projects/${ctx.projectId}`
      : '/inbox';
  return {
    title,
    body,
    url,
    tag: ctx.taskId ?? type,
  };
}

function stringOr(v: unknown, fallback: string | null): string | null {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function headlineFor(type: string, ctx: { taskKey: string | null; actor: string | null }): string {
  const key = ctx.taskKey ? ` ${ctx.taskKey}` : '';
  switch (type) {
    case 'TaskAssigned':
      return `Assigned to you${key}`;
    case 'MentionedInComment':
      return `${ctx.actor ?? 'Someone'} mentioned you${key}`;
    case 'TaskBlocked':
      return `Blocked${key}`;
    case 'TaskUnblocked':
      return `Unblocked${key}`;
    case 'CommentAdded':
      return `New comment${key}`;
    case 'TaskStatusChanged':
      return `Status changed${key}`;
    case 'TaskUpdated':
      return `Task updated${key}`;
    case 'SprintStarted':
      return 'Sprint started';
    case 'SprintCompleted':
      return 'Sprint completed';
    case 'DeploymentFailed':
      return 'Deployment failed';
    case 'ClientReportedBug':
      return 'Client reported a bug';
    default:
      return 'Nockta Flow';
  }
}

function bodyFor(
  type: string,
  ctx: { taskTitle: string | null; actor: string | null },
): string | null {
  if (ctx.taskTitle) return ctx.taskTitle;
  if (ctx.actor && type === 'CommentAdded') return `${ctx.actor} commented on a task you watch`;
  return null;
}
