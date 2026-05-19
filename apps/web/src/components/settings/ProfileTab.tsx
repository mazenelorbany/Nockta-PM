import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ApiError } from '@nockta/sdk';
import { Check, Pencil, X } from 'lucide-react';

import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { AvatarCircle } from '../task-bits';

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
  const { user, setUser } = useAuth();
  const meQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<MeResponse>('/auth/me'),
  });
  const me = meQuery.data;

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-2xl space-y-6">
      <SectionTitle
        title={'Profile'}
        hint={'Edit your display name. Email + role are managed elsewhere.'}
      />

      <Fieldset legend={'Identity'}>
        <div className="flex items-center gap-4 py-1">
          <AvatarCircle user={me ?? user ?? null} size={56} />
          <div className="flex-1 min-w-0">
            <EditableNameField currentName={me?.name ?? user?.email ?? ''} onSaved={(name) => {
              // Keep the auth-store + auth/me query in sync so every surface
              // that reads `user.name` (sidebar, comments-as-self, etc.)
              // picks up the change without a hard refresh.
              if (user) setUser({ ...user, name });
            }} />
            <div className="text-sm text-muted-foreground truncate">{me?.email ?? user?.email}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {me?.companyRole ?? user?.companyRole ?? user?.kind}
            </div>
          </div>
        </div>
      </Fieldset>

      <Fieldset legend={'Session'}>
        <div className="text-sm text-muted-foreground space-y-2 py-1">
          <div>
            {'Signed in via'}{' '}
            <span className="text-foreground font-medium">
              {me?.companyRole
                ? 'Google OAuth'
                : 'magic link'}
            </span>
          </div>
          <div>
            {'Tokens are rotated every 15 minutes. Sign out from the sidebar to revoke immediately.'}
          </div>
        </div>
      </Fieldset>

      <Fieldset legend={'Time tracking'}>
        <WeeklyTargetField />
        <PomodoroToggleField />
      </Fieldset>
    </div>
  );
}

/**
 * Click-to-edit display name. Shows the name as static text with a pencil
 * icon to enter edit mode; Enter saves, Esc cancels. Validates 1-120 chars
 * client-side so the API doesn't have to return BadRequest for the common
 * mistake of leaving it blank.
 */
function EditableNameField({
  currentName,
  onSaved,
}: {
  currentName: string;
  onSaved: (name: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentName);

  // Keep draft in sync when the server-side name changes (e.g. /auth/me
  // refetched after a different mutation). Without this, opening the editor
  // would always show the stale name from when the component first mounted.
  useEffect(() => {
    setDraft(currentName);
  }, [currentName]);

  const save = useMutation({
    mutationFn: (name: string) =>
      api.patch<{ id: string; name: string }>('/users/me/profile', { name }),
    onSuccess: (resp) => {
      toast.success('Name updated');
      onSaved(resp.name);
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      setEditing(false);
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError ? err.problem.title || err.message : 'Could not save name',
      ),
  });

  function commit(): void {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      toast.error('Name cannot be empty');
      return;
    }
    if (trimmed.length > 120) {
      toast.error('Name is too long (120 max)');
      return;
    }
    if (trimmed === currentName.trim()) {
      setEditing(false);
      return;
    }
    save.mutate(trimmed);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group flex w-full items-center gap-1.5 text-left text-base font-semibold hover:text-brand transition-colors"
        title="Edit display name"
      >
        <span className="truncate">{currentName || '(no name)'}</span>
        <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            setEditing(false);
            setDraft(currentName);
          }
        }}
        maxLength={120}
        className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-base font-semibold"
      />
      <button
        type="button"
        onClick={commit}
        disabled={save.isPending}
        className="tap inline-flex h-7 w-7 items-center justify-center rounded-md text-brand hover:bg-brand/10 disabled:opacity-50"
        title="Save (Enter)"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => {
          setEditing(false);
          setDraft(currentName);
        }}
        className="tap inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        title="Cancel (Esc)"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Inline form for the user's `weeklyHoursTarget`. Optional — the streak widget
 * on the dashboard hides itself when the target is unset.
 */
function WeeklyTargetField(): JSX.Element {
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
      toast.success('Saved');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError
          ? err.problem.title || err.message
          : 'Could not save target',
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
        'Enter a number between 1 and 168 (or leave blank to clear).',
      );
      return;
    }
    save.mutate({ weeklyHoursTarget: Math.trunc(n) });
  }

  return (
    <form onSubmit={submit} className="space-y-2 py-1">
      <label className="block text-sm font-medium">
        {'Weekly hours target'}
        <span className="ms-1 text-muted-foreground font-normal">
          {'(optional)'}
        </span>
      </label>
      <p className="text-xs text-muted-foreground">
        {'When set, your dashboard shows progress vs target and a consecutive-weeks streak. Leave blank to hide the streak widget.'}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={168}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'e.g. 32'}
          className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        <span className="text-sm text-muted-foreground">
          {'hours / week'}
        </span>
        <button
          type="submit"
          disabled={save.isPending}
          className="ms-auto tap rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {save.isPending
            ? 'Saving…'
            : 'Save'}
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
      toast.success('Saved');
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError
          ? err.problem.title || err.message
          : 'Could not save target',
      ),
  });

  return (
    <div className="space-y-2 py-3 border-t border-border/60 mt-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium" htmlFor="nockta-pomodoro-toggle">
            {'Pomodoro mode'}
          </label>
          <p className="text-xs text-muted-foreground mt-1">
            {'Overlays 25-min focus / 5-min break / 15-min long-break phases on your active timer. Auto-stops the worklog at the end of each focus block.'}
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
