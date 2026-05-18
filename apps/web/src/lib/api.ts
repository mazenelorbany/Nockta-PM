import { createClient } from '@nockta/sdk';

import { API_PREFIX, API_URL } from './env';
import { useAuth } from './auth-store';

let refreshInFlight: Promise<string | null> | null = null;

export const api = createClient({
  baseUrl: `${API_URL}${API_PREFIX}`,
  getAccessToken: () => useAuth.getState().tokens?.accessToken ?? null,
  onUnauthorized: async () => {
    refreshInFlight ??= (async () => {
      const refresh = useAuth.getState().tokens?.refreshToken;
      if (!refresh) return null;
      try {
        const res = await fetch(`${API_URL}${API_PREFIX}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh }),
        });
        if (!res.ok) {
          useAuth.getState().logout();
          return null;
        }
        const data = (await res.json()) as {
          accessToken: string;
          refreshToken: string;
          accessTokenExpiresAt: string;
          refreshTokenExpiresAt: string;
        };
        useAuth.getState().setTokens({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          accessExpiresAt: data.accessTokenExpiresAt,
          refreshExpiresAt: data.refreshTokenExpiresAt,
        });
        return data.accessToken;
      } finally {
        // Reset the in-flight cache after this round completes.
        setTimeout(() => {
          refreshInFlight = null;
        }, 0);
      }
    })();
    return refreshInFlight;
  },
});
