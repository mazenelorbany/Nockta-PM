import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { NotificationDigestService } from './digest.service';
import { NotificationMutesService } from './mutes.service';
import { NotificationSnoozeService } from './snooze.service';
import { PreferencesService } from './preferences.service';
import { RecipientResolverService } from './recipient-resolver.service';

export const NOTIFICATION_QUEUE = 'notifications';

const EVENT_TO_NOTIFICATION_TYPE: Record<string, string> = {
  'task.assigned':         'TaskAssigned',
  'task.updated':          'TaskUpdated',
  'task.status_changed':   'TaskStatusChanged',
  'task.blocked':          'TaskBlocked',
  'task.unblocked':        'TaskUnblocked',
  'comment.added':         'CommentAdded',
  'sprint.started':        'SprintStarted',
  'sprint.completed':      'SprintCompleted',
  'client.reported_bug':   'ClientReportedBug',
  'deploy.failed':         'DeploymentFailed',
  'deploy.succeeded':      'DeploymentSucceeded',
};

@Injectable()
export class NotificationDispatcherService implements OnModuleInit {
  constructor(
    private readonly emitter: EventEmitter2,
    private readonly resolver: RecipientResolverService,
    private readonly preferences: PreferencesService,
    private readonly mutes: NotificationMutesService,
    private readonly snooze: NotificationSnoozeService,
    private readonly digest: NotificationDigestService,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    this.emitter.onAny((event, payload) => {
      const name = Array.isArray(event) ? event.join('.') : (event as string);
      void this.dispatch(name, payload as Record<string, unknown>);
    });
  }

  private async dispatch(eventName: string, payload: Record<string, unknown>): Promise<void> {
    const notificationType = EVENT_TO_NOTIFICATION_TYPE[eventName];
    if (!notificationType) return;

    const recipients = await this.resolver.resolve(eventName, payload);
    if (recipients.length === 0) return;

    const taskId = (payload['taskId'] as string | undefined) ?? null;
    const docId = (payload['docId'] as string | undefined) ?? null;
    const projectId = (payload['projectId'] as string | undefined) ?? null;

    // Special-case: comments fire two distinct notification types (mentioned vs. watching).
    // Recipient.reason carries the discriminator; map to type accordingly.
    for (const r of recipients) {
      // 1) Legacy task-mute (TasksController.mute writes TaskMute). Keep
      //    this path until TaskMute is folded into NotificationMute.
      if (await this.preferences.isMuted(r.userId, taskId)) continue;

      // 2) Generalized mute — checks the new NotificationMute table for
      //    BOTH task and doc scopes. Both paths drop the notification
      //    entirely; we do NOT defer it (see decision note in module doc).
      if (await this.mutes.isMuted(r.userId, 'task', taskId)) continue;
      if (await this.mutes.isMuted(r.userId, 'doc', docId)) continue;

      // 3) DND window — same drop policy. The user's in-app bell still
      //    counts unread items via the in-app channel (preferences.snooze
      //    sentinel keeps in-app on); DND rules here suppress every channel
      //    for the active window. Reason: we don't yet have the
      //    `deliverAt`-style worker queue; deferred-delivery would silently
      //    pile rows that never fire. Caller decision-noted in module doc.
      if (await this.snooze.isWithinSnoozeWindow(r.userId)) continue;

      const finalType =
        r.reason === 'mentioned' || r.reason === 'team_mentioned'
          ? 'MentionedInComment'
          : notificationType;

      // Smart-digest fork (Pass I). When the user has digestEnabled=true,
      // enqueueOrBatch folds the event into their pending bucket and we skip
      // the immediate delivery queue entirely. The in-app bell still updates
      // when the eventual digest flush fires (the digest renderer emits
      // notification.digest_ready, which downstream sinks render). For users
      // not on digest mode, the call returns false instantly and we fall
      // through to the existing per-event delivery path.
      const batched = await this.digest.enqueueOrBatch({
        recipientUserId: r.userId,
        type: finalType,
        payload,
        taskId,
        projectId,
        reason: r.reason,
      });
      if (batched) continue;

      const channels = await this.preferences.channelsFor(r.userId, finalType, projectId);

      await this.queue.add(
        'deliver',
        {
          recipientUserId: r.userId,
          type: finalType,
          channels,
          payload,
          taskId,
          projectId,
          reason: r.reason,
          enqueuedAt: new Date().toISOString(),
        },
        { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
      );
    }
  }
}
