import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import toast from 'react-hot-toast';

import { api } from '../../lib/api';

import { Fieldset, HelpHint, SectionTitle, Toggle, apiErrorMessage } from './primitives';
import { BrowserPushRow } from './notifications-tab/BrowserPushRow';
import { DoNotDisturbSection } from './notifications-tab/DoNotDisturbSection';
import { SmartDigestSection } from './notifications-tab/SmartDigestSection';
import { SnoozeAllRow, formatSnooze } from './notifications-tab/SnoozeAllRow';
import { NOTIFICATION_EVENTS, type NotificationPref } from './notifications-tab/types';

// =============================================================================
// NotificationsTab — per-event delivery matrix + workspace-wide snooze +
// browser-push opt-in. The matrix is a small grid (event × channel) and the
// snooze control is a sentinel row maintained server-side.
// =============================================================================

export function NotificationsTab(): JSX.Element {
  const queryClient = useQueryClient();
  const prefsQuery = useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => api.get<NotificationPref[]>('/notifications/preferences'),
  });

  const upsert = useMutation({
    mutationFn: (body: {
      channel: 'in_app' | 'chat';
      eventType: string;
      enabled: boolean;
      digestMode?: boolean;
    }) => api.post('/notifications/preferences', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notification-prefs'] }),
    onError: (err) =>
      toast.error(apiErrorMessage(err, 'Could not save preference')),
  });

  function enabled(channel: 'in_app' | 'chat', eventType: string): boolean {
    const p = prefsQuery.data?.find(
      (x) => x.channel === channel && x.eventType === eventType && !x.projectId,
    );
    return p?.enabled ?? true;
  }

  // Workspace-wide snooze. Server-side a single sentinel row carries the
  // timestamp; we surface the latest future snoozeUntil across all rows so
  // the chip below tells the user when their focus block ends.
  const snoozeAll = useMutation({
    mutationFn: (minutes: number) =>
      api.patch('/notifications/preferences/snooze-all', { minutes }),
    onSuccess: (_, minutes) => {
      void queryClient.invalidateQueries({ queryKey: ['notification-prefs'] });
      toast.success(
        minutes === 0
          ? 'Snooze cleared'
          : `Snoozed for ${formatSnooze(minutes)}`,
      );
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, 'Could not snooze')),
  });
  const snoozedUntil = useMemo<Date | null>(() => {
    const rows = prefsQuery.data ?? [];
    let latest: number | null = null;
    for (const r of rows) {
      if (!r.snoozeUntil) continue;
      const t = new Date(r.snoozeUntil).getTime();
      if (Number.isFinite(t) && t > Date.now() && (latest === null || t > latest)) {
        latest = t;
      }
    }
    return latest ? new Date(latest) : null;
  }, [prefsQuery.data]);

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-3xl space-y-6">
      <SectionTitle
        title={'Notifications'}
        hint={'Per-event delivery channels. Defaults: in-app on, chat off until you bind Google Chat.'}
      />

      <Fieldset
        legend={'Delivery channels'}
        hint={'Configure browser pushes and workspace-wide snooze.'}
      >
        <BrowserPushRow />
        <SnoozeAllRow
          snoozedUntil={snoozedUntil}
          onSnooze={(m) => snoozeAll.mutate(m)}
          pending={snoozeAll.isPending}
        />
      </Fieldset>

      <DoNotDisturbSection />

      <SmartDigestSection />

      <Fieldset
        legend={'Event matrix'}
        hint={'Per-event delivery. In-app pings the bell badge; Chat needs Google Chat bound under Integrations.'}
      >
        <div className="rounded-lg border border-border overflow-hidden -mx-1">
          <div className="grid grid-cols-[1fr_70px_70px] sm:grid-cols-[1fr_120px_120px] px-3 sm:px-4 py-2 bg-secondary/40 border-b border-border text-xs nockta-eyebrow text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {'Event'}
              <HelpHint hint={"Triggers fire whenever the matching change happens to a task you're watching, an @mention of you, or a project you've subscribed to."} />
            </span>
            <span className="text-center">
              {'In-app'}
            </span>
            <span className="text-center">{'Chat'}</span>
          </div>
          {NOTIFICATION_EVENTS.map((ev) => {
            // Translate event labels via the central event-name table so the
            // matrix labels match the rest of the app's terminology in each
            // locale. Falls back to the English literal baked into the const.
            const eventLabel = ev.label;
            return (
              <div
                key={ev.type}
                className="grid grid-cols-[1fr_70px_70px] sm:grid-cols-[1fr_120px_120px] items-center px-3 sm:px-4 py-3 border-b border-border last:border-b-0 text-sm gap-2"
              >
                <span>{eventLabel}</span>
                <span className="flex justify-center">
                  <Toggle
                    ariaLabel={`In-app — ${eventLabel}`}
                    checked={enabled('in_app', ev.type)}
                    onChange={(v) =>
                      upsert.mutate({ channel: 'in_app', eventType: ev.type, enabled: v })
                    }
                  />
                </span>
                <span className="flex justify-center">
                  <Toggle
                    ariaLabel={`Chat — ${eventLabel}`}
                    checked={enabled('chat', ev.type)}
                    onChange={(v) =>
                      upsert.mutate({ channel: 'chat', eventType: ev.type, enabled: v })
                    }
                  />
                </span>
              </div>
            );
          })}
        </div>
      </Fieldset>
    </div>
  );
}
