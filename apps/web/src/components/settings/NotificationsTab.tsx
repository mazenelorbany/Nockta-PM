import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { Fieldset, HelpHint, SectionTitle, Toggle, apiErrorMessage } from './primitives';

// =============================================================================
// NotificationsTab — per-event delivery matrix + workspace-wide snooze +
// browser-push opt-in. The matrix is a small grid (event × channel) and the
// snooze control is a sentinel row maintained server-side.
// =============================================================================

interface NotificationPref {
  id: string;
  userId: string;
  channel: 'in_app' | 'chat';
  eventType: string;
  enabled: boolean;
  snoozeUntil: string | null;
  digestMode: boolean;
  projectId: string | null;
}

const NOTIFICATION_EVENTS = [
  { type: 'TaskAssigned',       label: 'Task assigned to me' },
  { type: 'TaskUpdated',        label: 'Watched task updated' },
  { type: 'TaskStatusChanged',  label: 'Watched task status changed' },
  { type: 'TaskBlocked',        label: 'Watched task blocked' },
  { type: 'CommentAdded',       label: 'Comment on watched task' },
  { type: 'MentionedInComment', label: '@mention in comment' },
  { type: 'SprintStarted',      label: 'Sprint started' },
  { type: 'SprintCompleted',    label: 'Sprint completed' },
  { type: 'DeploymentFailed',   label: 'Deployment failed' },
  { type: 'ClientReportedBug',  label: 'Client reported a bug' },
];

export function NotificationsTab(): JSX.Element {
  const { t, i18n } = useTranslation();
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
      toast.error(apiErrorMessage(err, t('settings.notifications.save_error', 'Could not save preference'))),
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
          ? t('settings.notifications.snooze_cleared', 'Snooze cleared')
          : t('settings.notifications.snooze_set', 'Snoozed for {{label}}', {
              label: formatSnooze(minutes),
            }),
      );
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, t('settings.notifications.snooze_error', 'Could not snooze'))),
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
        title={t('settings.notifications.title', 'Notifications')}
        hint={t(
          'settings.notifications.hint',
          'Per-event delivery channels. Defaults: in-app on, chat off until you bind Google Chat.',
        )}
      />

      <Fieldset
        legend={t('settings.notifications.delivery_legend', 'Delivery channels')}
        hint={t(
          'settings.notifications.delivery_hint',
          'Configure browser pushes and workspace-wide snooze.',
        )}
      >
        <BrowserPushRow />
        <WebPushRow />
        <SnoozeAllRow
          snoozedUntil={snoozedUntil}
          onSnooze={(m) => snoozeAll.mutate(m)}
          pending={snoozeAll.isPending}
        />
      </Fieldset>

      <DoNotDisturbSection />

      <SmartDigestSection />

      <Fieldset
        legend={t('settings.notifications.matrix_legend', 'Event matrix')}
        hint={t(
          'settings.notifications.matrix_hint',
          'Per-event delivery. In-app pings the bell badge; Chat needs Google Chat bound under Integrations.',
        )}
      >
        <div className="rounded-lg border border-border overflow-hidden -mx-1">
          <div className="grid grid-cols-[1fr_70px_70px] sm:grid-cols-[1fr_120px_120px] px-3 sm:px-4 py-2 bg-secondary/40 border-b border-border text-xs nockta-eyebrow text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {t('settings.notifications.matrix_event', 'Event')}
              <HelpHint hint={t('settings.notifications.matrix_event_hint', "Triggers fire whenever the matching change happens to a task you're watching, an @mention of you, or a project you've subscribed to.")} />
            </span>
            <span className="text-center">
              {t('settings.notifications.matrix_in_app', 'In-app')}
            </span>
            <span className="text-center">{t('settings.notifications.matrix_chat', 'Chat')}</span>
          </div>
          {NOTIFICATION_EVENTS.map((ev) => {
            // Translate event labels via the central event-name table so the
            // matrix labels match the rest of the app's terminology in each
            // locale. Falls back to the English literal baked into the const.
            const eventLabel = t(`settings.notifications.event.${ev.type}`, ev.label);
            return (
              <div
                key={ev.type}
                className="grid grid-cols-[1fr_70px_70px] sm:grid-cols-[1fr_120px_120px] items-center px-3 sm:px-4 py-3 border-b border-border last:border-b-0 text-sm gap-2"
              >
                <span>{eventLabel}</span>
                <span className="flex justify-center">
                  <Toggle
                    ariaLabel={`${t('settings.notifications.matrix_in_app', 'In-app')} — ${eventLabel}`}
                    checked={enabled('in_app', ev.type)}
                    onChange={(v) =>
                      upsert.mutate({ channel: 'in_app', eventType: ev.type, enabled: v })
                    }
                  />
                </span>
                <span className="flex justify-center">
                  <Toggle
                    ariaLabel={`${t('settings.notifications.matrix_chat', 'Chat')} — ${eventLabel}`}
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

// =============================================================================
// WebPushRow — true OS-level push via the service worker. Distinct from the
// `BrowserPushRow` above, which uses the in-tab Notification API and only
// fires while the tab is open. WebPush delivers even when the browser is
// closed (subject to the OS/browser limitations).
// =============================================================================

type WebPushState = 'idle' | 'unsupported' | 'denied' | 'on' | 'off' | 'enabling' | 'disabling';

function WebPushRow(): JSX.Element {
  const [state, setState] = useState<WebPushState>('idle');
  const [vapidConfigured, setVapidConfigured] = useState<boolean | null>(null);

  // Probe state on mount: support, current permission, existing subscription,
  // and whether the server is even configured for push.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import('../../lib/web-push');
      if (!mod.isSupported()) {
        if (!cancelled) setState('unsupported');
        return;
      }
      if (mod.getPermission() === 'denied') {
        if (!cancelled) setState('denied');
        return;
      }
      // Pre-fetch VAPID config so we can show a helpful disabled state.
      try {
        const vapid = await api.get<{ publicKey: string | null; configured: boolean }>(
          '/notifications/web-push/vapid-public-key',
        );
        if (!cancelled) setVapidConfigured(vapid.configured);
      } catch {
        if (!cancelled) setVapidConfigured(false);
      }
      const existing = await mod.getSubscription();
      if (!cancelled) setState(existing ? 'on' : 'off');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable(): Promise<void> {
    setState('enabling');
    try {
      const mod = await import('../../lib/web-push');
      const perm = await mod.requestPermission();
      if (perm === 'denied') {
        setState('denied');
        toast.error('Permission denied. Re-enable in your browser settings.');
        return;
      }
      if (perm === 'unsupported') {
        setState('unsupported');
        return;
      }
      await mod.subscribe();
      setState('on');
      toast.success('Push notifications on');
    } catch (err) {
      setState('off');
      toast.error(err instanceof Error ? err.message : 'Could not enable push');
    }
  }

  async function disable(): Promise<void> {
    setState('disabling');
    try {
      const mod = await import('../../lib/web-push');
      await mod.unsubscribe();
      setState('off');
      toast.success('Push notifications off');
    } catch {
      setState('off');
    }
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-4 flex items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand/10 text-brand shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 12h.01" />
          <path d="M9 19a8 8 0 0 1 0-14" />
          <path d="M14 19a13 13 0 0 0 0-14" />
          <path d="M22 12a18 18 0 0 0-22 0" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-1">
          Push notifications
          <HelpHint hint="OS-level push that fires even when Nockta is closed. Backed by the service worker + your browser's push service." />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          Get @mentions, blockers, and assignments as native pushes — even when this tab is closed.
          {vapidConfigured === false && (
            <>
              <br />
              <span className="text-status-blocked">
                Server is missing VAPID keys — ask an admin to configure VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
              </span>
            </>
          )}
        </p>
      </div>
      <div className="shrink-0">
        {state === 'unsupported' && (
          <span className="text-xs text-muted-foreground">Not supported in this browser.</span>
        )}
        {state === 'denied' && (
          <span className="text-xs text-status-blocked">Blocked in browser settings.</span>
        )}
        {(state === 'off' || state === 'enabling') && vapidConfigured !== false && (
          <button
            type="button"
            onClick={enable}
            disabled={state === 'enabling'}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {state === 'enabling' ? 'Enabling…' : 'Enable'}
          </button>
        )}
        {(state === 'on' || state === 'disabling') && (
          <button
            type="button"
            onClick={disable}
            disabled={state === 'disabling'}
            className="rounded-md border border-brand/40 bg-brand/10 text-brand px-3 py-1.5 text-xs hover:bg-brand/20 disabled:opacity-50"
          >
            {state === 'disabling' ? 'Turning off…' : 'On — turn off'}
          </button>
        )}
        {state === 'off' && vapidConfigured === false && (
          <span className="text-xs text-muted-foreground">Disabled by server.</span>
        )}
      </div>
    </div>
  );
}

function BrowserPushRow(): JSX.Element {
  const [state, setState] = useState<'on' | 'off' | 'denied' | 'unsupported' | 'prompt'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (
      Notification.permission === 'granted' &&
      localStorage.getItem('nockta.browser-push') === 'on'
    ) {
      return 'on';
    }
    if (Notification.permission === 'granted') return 'off';
    return 'prompt';
  });

  async function enable(): Promise<void> {
    const mod = await import('../../lib/use-notifications');
    const r = await mod.enableBrowserNotifications();
    if (r === 'unsupported') {
      toast.error('This browser does not support notifications.');
      setState('unsupported');
    } else if (r === 'denied') {
      toast.error('Permission denied. Re-enable in your browser site settings.');
      setState('denied');
    } else if (r === 'granted') {
      toast.success('Desktop notifications on');
      setState('on');
    }
  }
  function disable(): void {
    void import('../../lib/use-notifications').then((mod) =>
      mod.disableBrowserNotifications(),
    );
    setState('off');
    toast.success('Desktop notifications off');
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-4 flex items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand/10 text-brand shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-1">
          Desktop notifications
          <HelpHint hint="System-level toasts when the browser tab isn't focused. The in-app bell keeps counting either way." />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          Surface @mentions, blockers, and assignments as system toasts when the tab isn't focused.
          The in-app bell stays on regardless.
        </p>
      </div>
      <div className="shrink-0">
        {state === 'unsupported' && (
          <span className="text-xs text-muted-foreground">Not supported in this browser.</span>
        )}
        {state === 'denied' && (
          <span className="text-xs text-status-blocked">Blocked in browser settings.</span>
        )}
        {state === 'prompt' && (
          <button
            type="button"
            onClick={enable}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Enable
          </button>
        )}
        {state === 'off' && (
          <button
            type="button"
            onClick={enable}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            Turn on
          </button>
        )}
        {state === 'on' && (
          <button
            type="button"
            onClick={disable}
            className="rounded-md border border-brand/40 bg-brand/10 text-brand px-3 py-1.5 text-xs hover:bg-brand/20"
          >
            On — turn off
          </button>
        )}
      </div>
    </div>
  );
}

function SnoozeAllRow({
  snoozedUntil,
  onSnooze,
  pending,
}: {
  snoozedUntil: Date | null;
  onSnooze: (minutes: number) => void;
  pending: boolean;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const presets: { label: string; minutes: number }[] = [
    { label: t('settings.notifications.snooze_preset_1h', '1 hour'), minutes: 60 },
    { label: t('settings.notifications.snooze_preset_4h', '4 hours'), minutes: 240 },
    { label: t('settings.notifications.snooze_preset_tomorrow', 'Until tomorrow 9am'), minutes: minutesUntilTomorrow9am() },
    { label: t('settings.notifications.snooze_preset_monday', 'Until Monday 9am'), minutes: minutesUntilMonday9am() },
  ];
  return (
    <div className="rounded-lg border border-border bg-background/40 p-4 flex items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-1">
          {t('settings.notifications.snooze_title', 'Snooze everything')}
          <HelpHint hint={t('settings.notifications.snooze_hint', 'Mutes Chat + desktop pings. The in-app bell badge still counts so you can find missed items when you return.')} />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          {t(
            'settings.notifications.snooze_body',
            'Mute Chat + desktop pings (in-app stays on so the bell badge still counts) for a focus block.',
          )}
          {snoozedUntil && (
            <>
              <br />
              <span className="text-foreground font-medium">
                {t('settings.notifications.snooze_currently_until', 'Currently snoozed until {{when}}', {
                  when: snoozedUntil.toLocaleString(i18n.language),
                })}
              </span>
            </>
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={pending}
              onClick={() => onSnooze(p.minutes)}
              className="rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {p.label}
            </button>
          ))}
          {snoozedUntil && (
            <button
              type="button"
              disabled={pending}
              onClick={() => onSnooze(0)}
              className="rounded-md border border-brand/40 bg-brand/10 text-brand px-2.5 py-1 text-xs hover:bg-brand/20 disabled:opacity-50"
            >
              {t('settings.notifications.snooze_clear', 'Clear snooze')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function minutesUntilTomorrow9am(): number {
  const d = new Date();
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return Math.max(1, Math.round((tomorrow.getTime() - d.getTime()) / 60_000));
}

function minutesUntilMonday9am(): number {
  const d = new Date();
  const monday = new Date(d);
  // 1 = Monday in JS getDay(); cycle to next Monday (skip today if it's already Mon).
  const offset = ((1 - d.getDay() + 7) % 7) || 7;
  monday.setDate(d.getDate() + offset);
  monday.setHours(9, 0, 0, 0);
  return Math.max(1, Math.round((monday.getTime() - d.getTime()) / 60_000));
}

function formatSnooze(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.round(minutes / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// =============================================================================
// Do Not Disturb — recurring weekly snooze windows. CRUD against
// /notifications/snooze-rules. UI is a weekly grid + per-rule editor.
// =============================================================================

const ISO_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type IsoDay = (typeof ISO_DAYS)[number];

interface SnoozeRule {
  id: string;
  daysOfWeek: IsoDay[];
  startHour: number;
  endHour: number;
  enabled: boolean;
}

function DoNotDisturbSection(): JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['notifications', 'snooze-rules'],
    queryFn: () => api.get<SnoozeRule[]>('/notifications/snooze-rules'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Omit<SnoozeRule, 'id'>) => api.post('/notifications/snooze-rules', body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notifications', 'snooze-rules'] }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, ...rest }: SnoozeRule) =>
      api.patch(`/notifications/snooze-rules/${id}`, rest),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notifications', 'snooze-rules'] }),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/snooze-rules/${id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['notifications', 'snooze-rules'] }),
  });

  const rules = query.data ?? [];

  return (
    <Fieldset
      legend="Do Not Disturb"
      hint="Recurring quiet hours. During a window, in-app + Chat notifications are dropped (the bell still counts what you missed)."
    >
      <div className="space-y-3">
        {rules.length === 0 && (
          <div className="text-xs text-muted-foreground rounded-md border border-dashed border-border px-4 py-3">
            No quiet hours set. Add one below — e.g. weekday evenings or the whole weekend.
          </div>
        )}
        {rules.map((rule) => (
          <SnoozeRuleCard
            key={rule.id}
            rule={rule}
            onChange={(next) => updateMutation.mutate({ ...rule, ...next })}
            onRemove={() => removeMutation.mutate(rule.id)}
          />
        ))}
        <button
          type="button"
          onClick={() =>
            createMutation.mutate({
              daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'],
              startHour: 19,
              endHour: 9,
              enabled: true,
            })
          }
          className="rounded-md border border-dashed border-border bg-background/40 px-3 py-2 text-xs hover:bg-accent w-full"
        >
          + Add quiet hours
        </button>
      </div>
    </Fieldset>
  );
}

function SnoozeRuleCard({
  rule,
  onChange,
  onRemove,
}: {
  rule: SnoozeRule;
  onChange: (next: Partial<SnoozeRule>) => void;
  onRemove: () => void;
}): JSX.Element {
  function toggleDay(day: IsoDay): void {
    const next = rule.daysOfWeek.includes(day)
      ? rule.daysOfWeek.filter((d) => d !== day)
      : [...rule.daysOfWeek, day];
    if (next.length === 0) return; // keep at least one day
    onChange({ daysOfWeek: next });
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 grid grid-cols-7 gap-1">
          {ISO_DAYS.map((d) => {
            const active = rule.daysOfWeek.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={`tap rounded-md px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
                  active
                    ? 'bg-brand text-brand-foreground'
                    : 'bg-muted/30 text-muted-foreground hover:bg-muted/50'
                }`}
              >
                {d}
              </button>
            );
          })}
        </div>
        <Toggle
          checked={rule.enabled}
          onChange={(v) => onChange({ enabled: v })}
          ariaLabel="Toggle rule"
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">From</span>
        <HourSelect value={rule.startHour} onChange={(h) => onChange({ startHour: h })} />
        <span className="text-muted-foreground">to</span>
        <HourSelect value={rule.endHour} onChange={(h) => onChange({ endHour: h })} />
        <span className="text-muted-foreground tabular-nums">
          ({rule.endHour < rule.startHour ? 'overnight, ' : ''}UTC)
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRemove}
          className="tap rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-status-blocked hover:border-status-blocked/40"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function HourSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}): JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
    >
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>
          {h.toString().padStart(2, '0')}:00
        </option>
      ))}
    </select>
  );
}

// =============================================================================
// SmartDigestSection — Pass I (Notifications 8 → 9).
//
// Toggle + channel picker + preview line. Reads/writes the new digest prefs
// surface (User.digestEnabled / User.digestChannel) via
// GET/PATCH /notifications/digest. The preview pulls the most recent digest
// bucket (sent or in-flight) so the user can verify their config is doing
// what they expect.
// =============================================================================

interface DigestPreferences {
  enabled: boolean;
  channel: 'email' | 'chat';
  preview: {
    totalCount: number;
    grouped: Record<string, number>;
    firstQueuedAt: string;
    sentAt: string | null;
  } | null;
}

function SmartDigestSection(): JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['notifications', 'digest'],
    queryFn: () => api.get<DigestPreferences>('/notifications/digest'),
  });

  const update = useMutation({
    mutationFn: (body: Partial<{ enabled: boolean; channel: 'email' | 'chat' }>) =>
      api.patch<DigestPreferences>('/notifications/digest', body),
    onSuccess: (data) => {
      queryClient.setQueryData(['notifications', 'digest'], (prev: DigestPreferences | undefined) =>
        prev ? { ...prev, ...data } : (data as DigestPreferences),
      );
      toast.success('Smart digest updated');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update digest')),
  });

  const prefs = query.data;

  return (
    <Fieldset
      legend="Smart digest"
      hint="Roll up rapid-fire notifications into a single email/chat message every ~5 minutes. Great for noisy projects where individual pings interrupt flow."
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-background/40 p-4 flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand/10 text-brand shrink-0">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="3" y="4" width="18" height="14" rx="2" />
              <path d="M3 8h18" />
              <path d="M7 12h6" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Batch notifications into a digest</div>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              When on, individual notifications are folded into a rolled-up message that flushes every 5 minutes (or sooner if 10+ items pile up). In-app bell pings continue normally.
            </p>
          </div>
          <div className="shrink-0">
            <Toggle
              ariaLabel="Smart digest"
              checked={prefs?.enabled ?? false}
              onChange={(v) => update.mutate({ enabled: v })}
            />
          </div>
        </div>

        {prefs?.enabled && (
          <div className="rounded-lg border border-border bg-background/40 p-4 flex items-center gap-3">
            <div className="flex-1">
              <div className="text-sm font-medium">Deliver via</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Chat requires you to have bound Google Chat under Integrations.
              </p>
            </div>
            <select
              value={prefs.channel}
              onChange={(e) => update.mutate({ channel: e.target.value as 'email' | 'chat' })}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              <option value="email">Email</option>
              <option value="chat">Google Chat</option>
            </select>
          </div>
        )}

        {prefs?.enabled && prefs.preview && (
          <div className="rounded-lg border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground space-y-1">
            <div>
              <span className="text-foreground font-medium">Your last digest</span>{' '}
              {prefs.preview.sentAt
                ? `was sent at ${new Date(prefs.preview.sentAt).toLocaleString()}`
                : `is buffering since ${new Date(prefs.preview.firstQueuedAt).toLocaleString()}`}
              .
            </div>
            <div>
              <span className="tabular-nums">{prefs.preview.totalCount}</span> item
              {prefs.preview.totalCount === 1 ? '' : 's'}:{' '}
              {Object.entries(prefs.preview.grouped)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${k}`)
                .join(', ') || 'none yet'}
              .
            </div>
          </div>
        )}
      </div>
    </Fieldset>
  );
}
