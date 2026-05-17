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
    /// Resolved server-side from the user's first WorkspaceMember row.
    /// Always populated on tokens minted after Round 6 Pass A; the legacy
    /// path falls back to the bootstrap 'default' workspace.
    workspaceId?: string;
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
