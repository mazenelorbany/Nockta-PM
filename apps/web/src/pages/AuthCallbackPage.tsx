import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';

export function AuthCallbackPage(): JSX.Element {
  const navigate = useNavigate();
  const { setTokens, setUser } = useAuth();

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const access = params.get('access_token');
    const refresh = params.get('refresh_token');
    const accessExp = params.get('access_expires_at');
    const refreshExp = params.get('refresh_expires_at');
    if (!access || !refresh || !accessExp || !refreshExp) {
      navigate('/login', { replace: true });
      return;
    }
    setTokens({ accessToken: access, refreshToken: refresh, accessExpiresAt: accessExp, refreshExpiresAt: refreshExp });
    void api
      .get<{
        id: string;
        email: string;
        companyRole: 'Admin' | 'Member' | null;
        kind: 'internal' | 'client';
      }>('/auth/me')
      .then((user) => {
        setUser(user);
        navigate('/', { replace: true });
      })
      .catch(() => navigate('/login', { replace: true }));
  }, [navigate, setTokens, setUser]);

  return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Signing you in…</div>;
}
