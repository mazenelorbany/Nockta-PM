import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

interface AuthState {
  tokens: Tokens | null;
  user: {
    id: string;
    email: string;
    name?: string;
    companyRole: 'Admin' | 'Member' | null;
    kind: 'internal' | 'client';
  } | null;
  setTokens: (t: Tokens) => void;
  setUser: (u: AuthState['user']) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      tokens: null,
      user: null,
      setTokens: (tokens) => set({ tokens }),
      setUser: (user) => set({ user }),
      logout: () => set({ tokens: null, user: null }),
    }),
    { name: 'nockta.auth' },
  ),
);
