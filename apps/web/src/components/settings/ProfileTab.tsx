import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@nockta/sdk';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { AvatarCircle } from '../task-bits';
import { InstallPwaCard } from './InstallPwaCard';
import { Fieldset, SectionTitle } from './primitives';

// =============================================================================
// ProfileTab — read-only view of the signed-in user's profile + session info.
// Sourced from /auth/me so it always reflects the canonical server values
// rather than whatever the auth-store cached at login.
//
// =============================================================================

interface MeResponse {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  companyRole: 'Admin' | 'Member' | null;
  kind: 'internal' | 'client';
}

interface MyPreferences {
  weeklyHoursTarget: number | null;
  pomodoroEnabled: boolean;
}

export function ProfileTab(): JSX.Element {
  const { user } = useAuth();
  const { t } = useTranslation();
  const meQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<MeResponse>('/auth/me'),
  });
  const me = meQuery.data;

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-2xl space-y-6">
      <SectionTitle
        title={t('settings.profile.title', 'Profile')}
        hint={t(
          'settings.profile.hint',
          'Read-only for now — managed via your Google Workspace account.',
        )}
      />

      <Fieldset legend={t('settings.profile.identity', 'Identity')}>
        <div className="flex items-center gap-4 py-1">
          <AvatarCircle user={me ?? user ?? null} size={56} />
          <div className="flex-1">
            <div className="text-base font-semibold">{me?.name ?? user?.email}</div>
            <div className="text-sm text-muted-foreground">{me?.email ?? user?.email}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {me?.companyRole ?? user?.companyRole ?? user?.kind}
            </div>
          </div>
        </div>
      </Fieldset>

      <Fieldset legend={t('settings.profile.session', 'Session')}>
        <div className="text-sm text-muted-foreground space-y-2 py-1">
          <div>
            {t('settings.profile.session_via', 'Signed in via')}{' '}
            <span className="text-foreground font-medium">
              {me?.companyRole
                ? t('settings.profile.session_google', 'Google OAuth')
                : t('settings.profile.session_magic', 'magic link')}
            </span>
          </div>
          <div>
            {t(
              'settings.profile.session_rotation',
              'Tokens are rotated every 15 minutes. Sign out from the sidebar to revoke immediately.',
            )}
          </div>
        </div>
      </Fieldset>

      <Fieldset legend={t('settings.profile.time_tracking', 'Time tracking')}>
        <WeeklyTargetField />
        <PomodoroToggleField />
      </Fieldset>

      <Fieldset legend="App" hint="Install Nockta as a desktop / home-screen app for offline support and push.">
        <InstallPwaCard />
      </Fieldset>
    </div>
  );
}

/**
 * Inline form for the user's `weeklyHoursTarget`. Optional — the streak widget
 * on the dashboard hides itself when the target is unset.
 */
function WeeklyTargetField(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const prefsQuery = useQuery({
    queryKey: ['me', 'preferences'],
    queryFn: () => api.get<MyPreferences>('/users/me/preferences'),
  });
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (prefsQuery.data) {
      setDraft(prefsQuery.data.weeklyHoursTarget?.toString() ?? '');
    }
  }, [prefsQuery.data]);

  const save = useMutation({
    mutationFn: (input: { weeklyHoursTarget: number | null }) =>
      api.patch<MyPreferences>('/users/me/preferences', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me', 'preferences'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics', 'me'] });
      toast.success(t('settings.profile.saved', 'Saved'));
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError
          ? err.problem.title || err.message
          : t('settings.profile.save_error', 'Could not save target'),
      ),
  });

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = draft.trim();
    if (trimmed === '') {
      save.mutate({ weeklyHoursTarget: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 1 || n > 168) {
      toast.error(
        t(
          'settings.profile.bad_range',
          'Enter a number between 1 and 168 (or leave blank to clear).',
        ),
      );
      return;
    }
    save.mutate({ weeklyHoursTarget: Math.trunc(n) });
  }

  return (
    <form onSubmit={submit} className="space-y-2 py-1">
      <label className="block text-sm font-medium">
        {t('settings.profile.weekly_target_label', 'Weekly hours target')}
        <span className="ms-1 text-muted-foreground font-normal">
          {t('settings.profile.weekly_target_optional', '(optional)')}
        </span>
      </label>
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.profile.weekly_target_hint',
          'When set, your dashboard shows progress vs target and a consecutive-weeks streak. Leave blank to hide the streak widget.',
        )}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={168}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('settings.profile.placeholder_eg', 'e.g. 32')}
          className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        <span className="text-sm text-muted-foreground">
          {t('settings.profile.hours_per_week', 'hours / week')}
        </span>
        <button
          type="submit"
          disabled={save.isPending}
          className="ms-auto tap rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {save.isPending
            ? t('settings.profile.saving', 'Saving…')
            : t('settings.profile.save', 'Save')}
        </button>
      </div>
    </form>
  );
}

/**
 * Pomodoro mode toggle. Lives in the same Time-tracking fieldset as
 * `WeeklyTargetField` because the two preferences share a query (`['me',
 * 'preferences']`) — flipping this re-uses the existing PATCH /users/me/
 * preferences endpoint with the `pomodoroEnabled` field. The actual state
 * machine is client-side (see `apps/web/src/hooks/usePomodoro.ts`); this
 * toggle just persists the opt-in so it survives a fresh login.
 */
function PomodoroToggleField(): JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const prefsQuery = useQuery({
    queryKey: ['me', 'preferences'],
    queryFn: () => api.get<MyPreferences>('/users/me/preferences'),
  });
  const enabled = prefsQuery.data?.pomodoroEnabled ?? false;

  const save = useMutation({
    mutationFn: (input: { pomodoroEnabled: boolean }) =>
      api.patch<MyPreferences>('/users/me/preferences', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me', 'preferences'] });
      toast.success(t('settings.profile.saved', 'Saved'));
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError
          ? err.problem.title || err.message
          : t('settings.profile.save_error', 'Could not save target'),
      ),
  });

  return (
    <div className="space-y-2 py-3 border-t border-border/60 mt-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium" htmlFor="nockta-pomodoro-toggle">
            {t('settings.profile.pomodoro_label', 'Pomodoro mode')}
          </label>
          <p className="text-xs text-muted-foreground mt-1">
            {t(
              'settings.profile.pomodoro_hint',
              'Overlays 25-min focus / 5-min break / 15-min long-break phases on your active timer. Auto-stops the worklog at the end of each focus block.',
            )}
          </p>
        </div>
        <button
          id="nockta-pomodoro-toggle"
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={save.isPending || prefsQuery.isLoading}
          onClick={() => save.mutate({ pomodoroEnabled: !enabled })}
          className={
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 ' +
            (enabled ? 'bg-primary' : 'bg-input')
          }
        >
          <span
            aria-hidden
            className={
              'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-lg ring-0 transition-transform ' +
              (enabled ? 'translate-x-5' : 'translate-x-0')
            }
          />
        </button>
      </div>
    </div>
  );
}
