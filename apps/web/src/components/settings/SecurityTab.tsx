import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clock,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';

import { Fieldset, HelpHint, SectionTitle } from './primitives';

// =============================================================================
// SecurityTab — account snapshot, MFA enrollment, session revocation, recent
// activity (audit log), and data requests. All destructive actions go through
// window.confirm. MFA + sessions hit /auth/* endpoints introduced in Auth 7→9.
// =============================================================================

// ---- Types mirroring the backend response shapes --------------------------

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
  expiresAt: string;
}

interface AuditLogRow {
  id: string;
  action: string;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function SecurityTab(): JSX.Element {
  const { user, tokens, logout } = useAuth();
  const queryClient = useQueryClient();

  function signOut(): void {
    if (window.confirm('Sign out of this session?')) {
      logout();
      window.location.href = '/login';
    }
  }
  function signOutEverywhere(): void {
    if (
      window.confirm(
        'Sign out of every browser and device? Other sessions will be revoked on next request.',
      )
    ) {
      void api
        .post('/auth/logout', { allDevices: true })
        .catch(() => {
          /* fall through to local logout regardless */
        })
        .finally(() => {
          logout();
          window.location.href = '/login';
        });
    }
  }

  const sessionStart = tokens?.accessExpiresAt
    ? new Date(new Date(tokens.accessExpiresAt).getTime() - 60 * 60 * 1000)
    : null;
  const sessionExpires = tokens?.accessExpiresAt ? new Date(tokens.accessExpiresAt) : null;

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-3xl space-y-6 sm:space-y-8">
      <SectionTitle
        title={'Security & Privacy'}
        hint={'Account access, two-factor auth, session control, and your data.'}
      />

      <Fieldset legend={'Account'}>
        <div className="flex items-center gap-3 py-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-brand/10 text-brand">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold">{'Account'}</div>
            <div className="text-xs text-muted-foreground">
              {'Signed in via Google Workspace'}
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-y-3 text-xs pt-1">
          <dt className="text-muted-foreground inline-flex items-center gap-1">
            {'Email'}
          </dt>
          <dd className="col-span-2 font-medium">{user?.email ?? '—'}</dd>
          <dt className="text-muted-foreground">{'Role'}</dt>
          <dd className="col-span-2 font-medium">
            {user?.companyRole ?? 'Member'}
          </dd>
          <dt className="text-muted-foreground inline-flex items-center gap-1">
            {'Kind'}
            <HelpHint hint={"'internal' = signs in via Google OAuth. 'client' = magic-link guest using the client portal."} />
          </dt>
          <dd className="col-span-2 font-medium capitalize">{user?.kind ?? 'internal'}</dd>
          {sessionStart && (
            <>
              <dt className="text-muted-foreground">
                {'Session started'}
              </dt>
              <dd className="col-span-2 font-medium tabular-nums">
                {sessionStart.toLocaleString(undefined)}
              </dd>
            </>
          )}
          {sessionExpires && (
            <>
              <dt className="text-muted-foreground inline-flex items-center gap-1">
                {'Expires'}
                <HelpHint hint={'The access token expiry. The refresh token in your cookie stays valid longer; we rotate the access token silently every 15 minutes.'} />
              </dt>
              <dd className="col-span-2 font-medium tabular-nums">
                {sessionExpires.toLocaleString(undefined)}
              </dd>
            </>
          )}
        </dl>
      </Fieldset>

      <SessionsSection
        currentRefreshToken={tokens?.refreshToken ?? null}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ['auth', 'audit-log'] });
        }}
      />

      <AuditLogSection />

      <Fieldset legend={'Quick actions'}>
        <div className="rounded-lg border border-border bg-background/40 divide-y divide-border">
          <SecurityAction
            icon={<LogOut className="h-4 w-4" />}
            title={'Sign out of this session'}
            body={"Revokes the current browser's access and refresh tokens."}
            cta={'Sign out'}
            onClick={signOut}
          />
          <SecurityAction
            icon={<LogOut className="h-4 w-4 text-status-blocked" />}
            title={'Sign out of every device'}
            body={'Revokes all refresh tokens for your account, everywhere.'}
            cta={'Sign out everywhere'}
            tone="danger"
            onClick={signOutEverywhere}
          />
        </div>
      </Fieldset>

      <Fieldset
        legend={'Your data'}
        hint={'Export and deletion are routed to a workspace admin for now — self-serve is on the roadmap.'}
      >
        <div className="rounded-lg border border-border bg-background/40 divide-y divide-border">
          <SecurityAction
            icon={<Download className="h-4 w-4" />}
            title={'Request data export'}
            body={"A copy of your tasks, comments, and worklog as JSON. We'll email you when it's ready."}
            cta={'Email Admin'}
            href="mailto:admin@nockta.com?subject=Data export request"
          />
          <SecurityAction
            icon={<AlertTriangle className="h-4 w-4 text-status-blocked" />}
            title={'Delete account'}
            body={'Permanently removes your account and authored content. Cannot be undone.'}
            cta={'Email Admin'}
            tone="danger"
            href="mailto:admin@nockta.com?subject=Account deletion request"
          />
        </div>
      </Fieldset>
    </div>
  );
}

// MFA enrollment + disable flow was removed (GRILL-SUMMARY.md §23).

// =============================================================================
// Sessions — list active refresh tokens + revoke
// =============================================================================

function SessionsSection({
  currentRefreshToken,
  onChanged,
}: {
  currentRefreshToken: string | null;
  onChanged: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () =>
      api.get<SessionRow[]>(
        `/auth/sessions${currentRefreshToken ? `?currentRefreshToken=${encodeURIComponent(currentRefreshToken)}` : ''}`,
      ),
  });

  const revokeOne = useMutation({
    mutationFn: (id: string) => api.post(`/auth/sessions/${id}/revoke`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
      onChanged();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: () =>
      api.post('/auth/sessions/revoke-others', {
        ...(currentRefreshToken ? { refreshToken: currentRefreshToken } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
      onChanged();
    },
  });

  const rows = sessionsQuery.data ?? [];
  const otherCount = rows.filter((r) => !r.current).length;

  return (
    <Fieldset legend="Active sessions" hint="Each row is a separate browser or device.">
      <div className="rounded-lg border border-border bg-background/40 divide-y divide-border">
        {sessionsQuery.isLoading && (
          <div className="px-4 py-3 text-xs text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading sessions…
          </div>
        )}
        {!sessionsQuery.isLoading && rows.length === 0 && (
          <div className="px-4 py-3 text-xs text-muted-foreground">No active sessions.</div>
        )}
        {rows.map((row) => (
          <SessionRowView
            key={row.id}
            row={row}
            onRevoke={() => {
              if (
                row.current
                  ? window.confirm('This will sign you out of this browser. Continue?')
                  : window.confirm('Revoke this session?')
              ) {
                revokeOne.mutate(row.id);
              }
            }}
          />
        ))}
      </div>
      {otherCount > 0 && (
        <div className="flex justify-end mt-2">
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Revoke ${otherCount} other session(s)?`)) {
                revokeOthers.mutate();
              }
            }}
            className="tap rounded-md border border-status-blocked/40 px-3 py-1.5 text-xs text-status-blocked hover:bg-status-blocked/10"
          >
            Sign out of {otherCount} other session{otherCount === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </Fieldset>
  );
}

function SessionRowView({
  row,
  onRevoke,
}: {
  row: SessionRow;
  onRevoke: () => void;
}): JSX.Element {
  const ua = parseUserAgent(row.userAgent);
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted/30 text-muted-foreground shrink-0">
        {ua.mobile ? <Smartphone className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate inline-flex items-center gap-2">
          {ua.label}
          {row.current && (
            <span className="rounded-full bg-brand/10 text-brand px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              Current
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {row.ip ?? 'unknown ip'} · started {new Date(row.createdAt).toLocaleString()}
        </div>
      </div>
      <button
        type="button"
        onClick={onRevoke}
        className="tap rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-status-blocked hover:border-status-blocked/40"
      >
        Revoke
      </button>
    </div>
  );
}

function parseUserAgent(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  let label = 'Browser';
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) label = 'Chrome';
  else if (/Firefox\//.test(ua)) label = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) label = 'Safari';
  else if (/Edg\//.test(ua)) label = 'Edge';
  if (/Mac OS X/i.test(ua)) label += ' on macOS';
  else if (/Windows/i.test(ua)) label += ' on Windows';
  else if (/Linux/i.test(ua)) label += ' on Linux';
  else if (/Android/i.test(ua)) label += ' on Android';
  else if (/iPhone|iPad/i.test(ua)) label += ' on iOS';
  return { label, mobile };
}

// =============================================================================
// Audit log — last 50 security events
// =============================================================================

function AuditLogSection(): JSX.Element {
  const auditQuery = useQuery({
    queryKey: ['auth', 'audit-log'],
    queryFn: () => api.get<AuditLogRow[]>('/auth/audit-log?limit=50'),
  });

  return (
    <Fieldset
      legend="Recent activity"
      hint="The last 50 sign-ins, MFA events, and session changes on your account."
    >
      <div className="rounded-lg border border-border bg-background/40 divide-y divide-border max-h-[360px] overflow-y-auto">
        {auditQuery.isLoading && (
          <div className="px-4 py-3 text-xs text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        {auditQuery.data?.length === 0 && (
          <div className="px-4 py-3 text-xs text-muted-foreground">No activity recorded yet.</div>
        )}
        {auditQuery.data?.map((row) => (
          <div key={row.id} className="px-4 py-2.5 flex items-center gap-3">
            <AuditActionIcon action={row.action} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{prettyAuditAction(row.action)}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(row.createdAt).toLocaleString()}
                {row.ip ? ` · ${row.ip}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Fieldset>
  );
}

function AuditActionIcon({ action }: { action: string }): JSX.Element {
  let icon = <Clock className="h-3.5 w-3.5" />;
  let tone = 'bg-muted/30 text-muted-foreground';
  if (action.startsWith('login.')) {
    icon = <KeyRound className="h-3.5 w-3.5" />;
    tone = 'bg-brand/10 text-brand';
  } else if (action.startsWith('mfa.')) {
    icon =
      action === 'mfa.failed' ? (
        <X className="h-3.5 w-3.5" />
      ) : (
        <ShieldCheck className="h-3.5 w-3.5" />
      );
    tone =
      action === 'mfa.failed'
        ? 'bg-status-blocked/10 text-status-blocked'
        : 'bg-status-done/10 text-status-done';
  } else if (action.startsWith('session.')) {
    icon = <Monitor className="h-3.5 w-3.5" />;
    tone = 'bg-muted/30 text-muted-foreground';
  } else if (action === 'logout') {
    icon = <LogOut className="h-3.5 w-3.5" />;
  }
  return (
    <span className={cn('flex h-7 w-7 items-center justify-center rounded-md shrink-0', tone)}>
      {icon}
    </span>
  );
}

function prettyAuditAction(action: string): string {
  const map: Record<string, string> = {
    'login.google': 'Signed in via Google',
    'login.password': 'Signed in with password',
    'login.magic_link': 'Signed in via magic link',
    'login.dev': 'Signed in (dev mode)',
    'mfa.enrolled': 'MFA enabled',
    'mfa.verified': 'MFA code verified',
    'mfa.failed': 'MFA code rejected',
    'mfa.disabled': 'MFA disabled',
    'mfa.backup_code_used': 'Backup code used',
    logout: 'Signed out',
    'session.revoked': 'Session revoked',
    'session.revoked_others': 'Other sessions revoked',
    'token.refresh_reuse': 'Token reuse detected — all sessions revoked',
  };
  return map[action] ?? action;
}

// =============================================================================
// Shared bits
// =============================================================================

function _ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-popover border border-border shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="tap rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SecurityAction({
  icon,
  title,
  body,
  cta,
  onClick,
  href,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: string;
  onClick?: () => void;
  href?: string;
  tone?: 'danger';
}): JSX.Element {
  const buttonClass = cn(
    'tap shrink-0 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
    tone === 'danger'
      ? 'border-status-blocked/40 text-status-blocked hover:bg-status-blocked/10'
      : 'border-border bg-background/60 hover:bg-accent',
  );
  return (
    <div className="px-4 py-3.5 flex flex-wrap items-start gap-2 sm:gap-3">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="flex-1 min-w-0 basis-[calc(100%-3rem)] sm:basis-auto">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{body}</div>
      </div>
      {href ? (
        <a href={href} className={buttonClass}>
          {cta}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <button type="button" onClick={onClick} className={buttonClass}>
          {cta}
        </button>
      )}
    </div>
  );
}
