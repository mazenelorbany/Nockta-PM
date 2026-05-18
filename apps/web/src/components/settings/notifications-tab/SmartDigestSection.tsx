import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';

import { api } from '../../../lib/api';
import { Fieldset, Toggle, apiErrorMessage } from '../primitives';

import type { DigestPreferences } from './types';

// =============================================================================
// SmartDigestSection — Pass I (Notifications 8 → 9).
//
// Toggle + channel picker + preview line. Reads/writes the new digest prefs
// surface (User.digestEnabled / User.digestChannel) via
// GET/PATCH /notifications/digest. The preview pulls the most recent digest
// bucket (sent or in-flight) so the user can verify their config is doing
// what they expect.
// =============================================================================

export function SmartDigestSection(): JSX.Element {
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
