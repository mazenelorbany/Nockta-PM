import { Injectable } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

interface ChannelDecision {
  inApp: boolean;
  chat: boolean;
}

const DEFAULT_CHAT_ON_FOR: ReadonlySet<string> = new Set([
  'TaskAssigned',
  'MentionedInComment',
  'TaskBlocked',
  'ClientReportedBug',
]);

// Workspace-wide snooze sentinel. Written by NotificationPreferencesController
// (`PATCH /notifications/preferences/snooze-all`). When this row has a
// `snoozeUntil > now`, every channel except in-app is suppressed regardless
// of per-event prefs, so the bell badge stays accurate while the user is in
// a focus block.
const SNOOZE_ALL_EVENT = '__all__';

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve which channels a notification should fire on for a given user + event. */
  async channelsFor(
    userId: string,
    notificationType: string,
    projectId: string | null,
  ): Promise<ChannelDecision> {
    // In-app is always on (cannot be disabled).
    let chatEnabled = DEFAULT_CHAT_ON_FOR.has(notificationType);

    // Workspace-wide snooze short-circuit. One DB hit covers the sentinel and
    // the per-event prefs in the same round-trip.
    const prefs = await this.prisma.notificationPreference.findMany({
      where: {
        userId,
        OR: [
          { eventType: SNOOZE_ALL_EVENT, projectId: null },
          {
            eventType: notificationType,
            OR: [{ projectId }, { projectId: null }],
          },
        ],
      },
    });
    const now = new Date();
    const snoozeSentinel = prefs.find((p) => p.eventType === SNOOZE_ALL_EVENT);
    if (snoozeSentinel?.snoozeUntil && snoozeSentinel.snoozeUntil > now) {
      // Everything except in-app is muted. The badge still counts so the user
      // can see they have unread items after the snooze expires.
      return { inApp: true, chat: false };
    }

    const find = (channel: NotificationChannel) => {
      // Prefer project-specific row if present.
      return prefs.find((p) => p.channel === channel && p.projectId === projectId) ??
             prefs.find((p) => p.channel === channel && p.projectId === null);
    };

    const chatPref = find('chat');
    if (chatPref) chatEnabled = chatPref.enabled;

    // Per-channel snooze (used by legacy callers that didn't write the
    // workspace-wide sentinel). Still muted except in-app.
    if (chatPref?.snoozeUntil && chatPref.snoozeUntil > now) chatEnabled = false;

    // Chat requires the user to have bound their Google Chat account.
    if (chatEnabled) {
      const binding = await this.prisma.chatBinding.findUnique({ where: { userId } });
      if (!binding) chatEnabled = false;
    }

    // Clients can never receive Chat notifications.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { kind: true } });
    if (user?.kind === 'client') chatEnabled = false;

    // Email is no longer a notification channel (spec §10). Gmail SMTP is
    // reserved for magic-link auth. Any legacy `email` preference rows are
    // simply ignored here.
    return { inApp: true, chat: chatEnabled };
  }

  async isMuted(userId: string, taskId: string | null): Promise<boolean> {
    if (!taskId) return false;
    const mute = await this.prisma.taskMute.findUnique({
      where: { userId_taskId: { userId, taskId } },
    });
    return mute !== null;
  }
}
