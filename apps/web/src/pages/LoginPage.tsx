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

const MANTRAS = [
  'ENGINEERED',
  'NOT ASSEMBLED',
  'SENIOR OR NOTHING',
  'WE SHIP THEN MEASURE',
  'OPERATORS IN THE ROOM',
  'BRINGING THE PIECES',
];

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
    <div className="min-h-screen flex bg-background text-foreground flex-col overflow-hidden">
      <div className="flex-1 flex flex-col md:flex-row">
        {/* Brand panel — cinematic gradient, oversized N watermark, dense bento footer */}
        <div className="hidden md:flex md:w-[58%] bg-brand-gradient relative overflow-hidden p-12 lg:p-16 flex-col justify-between">
          {/* Faint grid overlay */}
          <div
            className="absolute inset-0 opacity-[0.04] pointer-events-none"
            style={{
              backgroundImage:
                'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
              backgroundSize: '64px 64px',
            }}
          />
          {/* Subtle wide product still — heavily darkened, lives behind the type */}
          <div
            className="absolute inset-0 bg-cover bg-center pointer-events-none opacity-[0.18] mix-blend-luminosity"
            style={{
              backgroundImage:
                "url('https://picsum.photos/seed/nockta-flow-login/1920/1200')",
            }}
            aria-hidden="true"
          />
          <div className="absolute inset-0 bg-gradient-to-tr from-background/80 via-background/30 to-transparent pointer-events-none" />
          {/* Brand cube — the stacked Nockta cubes ("scale") sit bottom-right
              as a quiet hero element. Real brand asset rather than a traced
              SVG mark so the login page reads as Nockta proper. */}
          <img
            src="/scale.png"
            alt=""
            aria-hidden="true"
            className="absolute -right-24 -bottom-24 h-[560px] w-[560px] object-contain pointer-events-none select-none opacity-70"
          />

          {/* Top row — lockup + status pill */}
          <div className="relative z-10 flex items-center justify-between">
            <NocktaLogo height={32} />
            <span className="nockta-eyebrow text-muted-foreground inline-flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-status-done animate-pulse" />
              {'Build · Connect · Scale'}
            </span>
          </div>

          {/* Headline block — H1 stays 3 lines max, inline image pill in line 2 */}
          <div className="relative z-10 space-y-6 max-w-3xl">
            <span className="nockta-eyebrow text-brand">
              {'Internal Engineering Operations'}
            </span>
            <h1
              className="display-heading text-foreground leading-[1.02]"
              style={{ fontSize: 'clamp(3rem, 5.4vw, 5.25rem)' }}
            >
              {'Bringing the'}
              <span
                className="inline-block align-middle mx-3 lg:mx-4 h-[0.72em] w-[1.5em] rounded-full bg-cover bg-center ring-1 ring-border"
                style={{
                  backgroundImage:
                    "url('https://picsum.photos/seed/nockta-team-pill/640/480')",
                  filter: 'grayscale(0.15) contrast(1.1)',
                }}
                aria-hidden="true"
              />
              {'pieces'}{' '}
              <span className="text-brand">{'together.'}</span>
            </h1>
            <p className="text-base text-muted-foreground max-w-md leading-relaxed">
              {'Tasks, sprints, code, deployments, and clients — engineered into one opinionated workspace. Three sides of the same cube.'}
            </p>
          </div>

          {/* Dense 2x2 bento footer — grid-flow-dense, varied tile sizes, no empty cells */}
          <div className="relative z-10 grid grid-cols-3 grid-rows-2 gap-2.5 max-w-xl auto-rows-fr grid-flow-dense">
            <FeatureTile
              className="col-span-2 row-span-2"
              kicker={'What it replaces'}
              title={'Linear, Notion, Slack, GSheets — all routed through one model.'}
              imageSeed="nockta-stack"
            />
            <StatTile label={'Disciplines'} value="5" />
            <StatTile label={'Workflow presets'} value="3" />
          </div>
        </div>

        {/* Sign-in panel */}
        <div className="flex-1 flex items-center justify-center p-6 lg:p-12 relative">
          {/* Mobile-only lockup at top */}
          <div className="md:hidden absolute top-6 left-6">
            <NocktaLogo height={24} />
          </div>

          <div className="w-full max-w-sm space-y-7">
            <div className="space-y-2">
              <span className="nockta-eyebrow text-muted-foreground">
                {'Welcome back'}
              </span>
              <h2 className="text-3xl font-bold tracking-tight">
                {'Sign in to Flow'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {'Internal users sign in with Google. External collaborators use a one-time email link.'}
              </p>
            </div>

            <a
              href={`${API_URL}${API_PREFIX}/auth/google`}
              className="tap flex items-center justify-center gap-2 w-full rounded-md bg-white py-2.5 text-sm font-semibold text-black hover:opacity-90 transition-[opacity,transform] duration-150"
            >
              <GoogleGlyph />
              {'Continue with Google'}
            </a>

            <MagicLinkForm />


            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="flex-1 h-px bg-border" />
              <span className="uppercase tracking-wider">{'or'}</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
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

            <p className="nockta-eyebrow text-muted-foreground/60 text-center pt-4">
              {'v0.1 · Internal Engineering Operations'}
            </p>
          </div>
        </div>
      </div>

      {/* Marquee strip — brand mantras pulled from nockta.com */}
      <div className="border-t border-border bg-card/40 backdrop-blur-sm overflow-hidden h-10 relative">
        <div className="absolute inset-0 flex items-center whitespace-nowrap">
          <div className="flex animate-marquee">
            {[...MANTRAS, ...MANTRAS, ...MANTRAS, ...MANTRAS].map((m, i) => (
              <span
                key={i}
                className="nockta-eyebrow text-muted-foreground/70 px-6 inline-flex items-center gap-6"
              >
                {m}
                <span className="text-brand">+</span>
              </span>
            ))}
          </div>
        </div>
      </div>
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

function StatTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card/50 backdrop-blur-sm p-3 flex flex-col justify-between">
      <div className="display-heading text-foreground tabular-nums" style={{ fontSize: 'clamp(1.5rem, 2.6vw, 2rem)' }}>
        {value}
      </div>
      <div className="nockta-eyebrow text-muted-foreground text-[0.6rem]">{label}</div>
    </div>
  );
}

function FeatureTile({
  className = '',
  kicker,
  title,
  imageSeed,
}: {
  className?: string;
  kicker: string;
  title: string;
  imageSeed: string;
}): JSX.Element {
  return (
    <div
      className={`relative overflow-hidden rounded-md border border-border bg-card/50 backdrop-blur-sm group ${className}`}
    >
      <div
        className="absolute inset-0 bg-cover bg-center transition-transform duration-[900ms] ease-out group-hover:scale-105"
        style={{
          backgroundImage: `url('https://picsum.photos/seed/${imageSeed}/1280/720')`,
          filter: 'grayscale(0.6) contrast(1.05) brightness(0.55)',
        }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-card via-card/70 to-card/20" />
      <div className="relative h-full flex flex-col justify-between p-3">
        <div className="nockta-eyebrow text-muted-foreground">{kicker}</div>
        <div className="text-sm font-semibold tracking-tight text-foreground leading-snug max-w-[18rem]">
          {title}
        </div>
      </div>
    </div>
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
