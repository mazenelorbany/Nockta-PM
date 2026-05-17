import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@nockta/sdk';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';

// MagicLinkCallbackPage — handles /auth/magic?token=...&email=...
// Email lands here, we POST to /auth/magic-link/verify, set tokens, send the
// user to /. Replaces the old apps/client MagicLinkCallbackPage so the same
// magic-link email URL keeps working post-consolidation.
export function MagicLinkCallbackPage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { setTokens, setUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    const email = params.get('email');
    if (!token || !email) {
      setError('Missing or malformed link.');
      return;
    }

    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const tokens = await api.post<{
          accessToken: string;
          refreshToken: string;
          accessTokenExpiresAt: string;
          refreshTokenExpiresAt: string;
        }>('/auth/magic-link/verify', { token, email });
        if (cancelled) return;
        setTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessExpiresAt: tokens.accessTokenExpiresAt,
          refreshExpiresAt: tokens.refreshTokenExpiresAt,
        });
        const me = await api.get<{
          id: string;
          email: string;
          name?: string;
          companyRole: 'Admin' | 'Member' | null;
          kind: 'internal' | 'client';
        }>('/auth/me');
        if (cancelled) return;
        setUser(me);
        navigate('/', { replace: true });
      } catch (err) {
        if (cancelled) return;
        const detail =
          err instanceof ApiError
            ? err.problem.title || err.message
            : 'This link is invalid or expired.';
        setError(detail);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [params, navigate, setTokens, setUser]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="max-w-sm w-full rounded-lg border border-border bg-card p-5 space-y-3">
          <p className="nockta-eyebrow text-muted-foreground">Sign in</p>
          <h1 className="text-lg font-semibold tracking-tight">{error}</h1>
          <p className="text-sm text-muted-foreground">
            Request a new link from the sign-in page.
          </p>
          <Link
            to="/login"
            className="tap inline-flex items-center justify-center rounded-md bg-secondary px-3 py-2 text-xs font-medium text-foreground hover:bg-secondary/80 transition-colors"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground">
      Signing you in…
    </div>
  );
}
