import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { NocktaLogo } from '@nockta/ui';

import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { API_PREFIX, API_URL } from '../lib/env';

type Persona =
  | 'admin'
  | 'engineering'
  | 'design'
  | 'guest-contributor'
  | 'guest-viewer'
  | 'guest-client';

interface AppConfig {
  devLoginEnabled: boolean;
}

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuth();
  const [loadingPersona, setLoadingPersona] = useState<Persona | null>(null);

  const configQuery = useQuery({
    queryKey: ['app-config'],
    queryFn: () => api.get<AppConfig>('/config').catch(() => null),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const config = configQuery.data;

  async function devLogin(persona: Persona): Promise<void> {
    setLoadingPersona(persona);
    try {
      const tokens = await api.post<{
        accessToken: string;
        refreshToken: string;
        accessTokenExpiresAt: string;
        refreshTokenExpiresAt: string;
      }>('/auth/dev-login', { persona });
      setTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpiresAt: tokens.accessTokenExpiresAt,
        refreshExpiresAt: tokens.refreshTokenExpiresAt,
      });
      const me = await api.get<{
        id: string; email: string; name?: string;
        companyRole: 'Admin' | 'Member' | null; kind: 'internal' | 'client';
      }>('/auth/me');
      setUser(me);
      // Single-shell model: clients (kind=client) and internal users share
      // the same app. ProjectTabs / sidebar gate by user kind so the client
      // shell hides internal-only sections; nothing to redirect.
      navigate('/', { replace: true });
    } catch (err) {
      const detail =
        err instanceof ApiError
          ? err.problem.title || err.message
          : 'Sign-in failed';
      toast.error(detail);
    } finally {
      setLoadingPersona(null);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Top bar — logo + system status. Internal tool, no marketing chrome. */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/60">
        <NocktaLogo height={22} />
        <span className="nockta-eyebrow text-muted-foreground inline-flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-status-done" />
          {'system online'}
        </span>
      </header>

      {/* Sign-in card — centered, single column, no hero. */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-7">
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">
              {'Sign in'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {'Internal: continue with Google. External collaborators: use the email link below.'}
            </p>
          </div>

          <a
            href={`${API_URL}${API_PREFIX}/auth/google`}
            className="tap flex items-center justify-center gap-2 w-full rounded-md bg-white py-2.5 text-sm font-semibold text-black hover:opacity-90 transition-opacity duration-150"
          >
            <GoogleGlyph />
            {'Continue with Google'}
          </a>

          <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
            <div className="flex-1 h-px bg-border" />
            <span className="uppercase tracking-wider">{'or'}</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <MagicLinkForm />

          {/* Dev-only persona buttons. The /config endpoint reports
              devLoginEnabled=false when NODE_ENV=production, which is
              where the corresponding /auth/dev-login route is also
              disabled. Hiding the buttons here avoids confusing the
              user with a row of options that all 401. */}
          {config?.devLoginEnabled && (
            <div className="space-y-2 pt-2 border-t border-border/60">
              <div className="flex items-center justify-between pt-3">
                <span className="nockta-eyebrow text-muted-foreground/70">
                  {'Quick login · dev only'}
                </span>
                {loadingPersona && (
                  <span className="text-[10px] text-muted-foreground animate-pulse">
                    {'signing in…'}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <PersonaButton
                  label={'Admin'}
                  sub={'Full access'}
                  disabled={loadingPersona !== null}
                  active={loadingPersona === 'admin'}
                  onClick={() => void devLogin('admin')}
                />
                <PersonaButton
                  label={'Engineering'}
                  sub={'Member · Eng team'}
                  disabled={loadingPersona !== null}
                  active={loadingPersona === 'engineering'}
                  onClick={() => void devLogin('engineering')}
                />
                <PersonaButton
                  label={'Design'}
                  sub={'Member · Design team'}
                  disabled={loadingPersona !== null}
                  active={loadingPersona === 'design'}
                  onClick={() => void devLogin('design')}
                />
                <PersonaButton
                  label={'Guest · Contributor'}
                  sub={'External · can edit'}
                  disabled={loadingPersona !== null}
                  active={loadingPersona === 'guest-contributor'}
                  onClick={() => void devLogin('guest-contributor')}
                />
                <PersonaButton
                  label={'Guest · Viewer'}
                  sub={'External · read-only'}
                  disabled={loadingPersona !== null}
                  active={loadingPersona === 'guest-viewer'}
                  onClick={() => void devLogin('guest-viewer')}
                />
                <PersonaButton
                  label={'Guest · Client'}
                  sub={'Bug reports only'}
                  disabled={loadingPersona !== null}
                  active={loadingPersona === 'guest-client'}
                  onClick={() => void devLogin('guest-client')}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer — single line of operator metadata. Replaces the brand marquee. */}
      <footer className="border-t border-border/60 px-6 py-3">
        <div className="flex items-center justify-between text-[10px] tracking-wider uppercase text-muted-foreground/60 font-mono">
          <span>{'nockta flow · v0.1'}</span>
          <span className="hidden sm:inline">{'internal engineering ops'}</span>
          <a
            href="https://nockta.com"
            target="_blank"
            rel="noopener"
            className="hover:text-foreground transition-colors"
          >
            {'nockta.com →'}
          </a>
        </div>
      </footer>
    </div>
  );
}

function PersonaButton({
  label,
  sub,
  disabled,
  active,
  onClick,
}: {
  label: string;
  sub: string;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'tap text-left rounded-md border border-dashed border-border px-3 py-2 transition-colors ' +
        'disabled:opacity-40 disabled:cursor-not-allowed ' +
        (active
          ? 'border-brand text-brand bg-accent'
          : 'text-foreground hover:border-brand hover:text-brand hover:bg-accent/60')
      }
    >
      <div className="text-sm font-semibold leading-none">{label}</div>
      <div className="nockta-eyebrow text-muted-foreground text-[0.6rem] mt-1">{sub}</div>
    </button>
  );
}

// MagicLinkForm — single-input "email me a sign-in link" affordance for
// external collaborators (kind=client). Replaces the apps/client portal's
// RequestMagicLinkPage now that clients share the same shell as internal
// users. POSTs /auth/magic-link/request and shows a "check your email"
// confirmation. The email lands on /auth/magic via MagicLinkCallbackPage.
function MagicLinkForm(): JSX.Element {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      await api.post('/auth/magic-link/request', { email: trimmed });
      setSent(true);
    } catch (err) {
      const detail =
        err instanceof ApiError ? err.problem.title || err.message : 'Could not send link';
      toast.error(detail);
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-1">
        <p className="text-sm text-foreground">
          {'Check your email'}
        </p>
        <p className="text-xs text-muted-foreground">
          {`We sent a one-time sign-in link to ${email}. It expires in 15 minutes.`}
        </p>
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setEmail('');
          }}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline mt-1"
        >
          {'Use a different email'}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-2">
      <label className="nockta-eyebrow text-muted-foreground/70 block">
        {'Email me a sign-in link'}
      </label>
      <div className="flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={sending || email.trim().length === 0}
          className="tap rounded-md bg-secondary px-3 py-2 text-xs font-medium text-foreground hover:bg-secondary/80 disabled:opacity-50 transition-colors"
        >
          {sending
            ? 'Sending…'
            : 'Send link'}
        </button>
      </div>
    </form>
  );
}

function GoogleGlyph(): JSX.Element {
  return (
    <svg className="h-4 w-4" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}
