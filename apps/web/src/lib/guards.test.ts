import { describe, expect, it } from 'vitest';

import {
  canSeeAdminMemberActions,
  shouldRedirectToLogin,
  visibleTasksForViewer,
} from './guards';
import type { AuthTokens, AuthenticatedUser } from './guards';

// =============================================================================
// guards.test.ts — security predicates from guards.ts. Each function maps to
// a "could the wrong user see the wrong thing?" check. Run as a pure unit
// suite via apps/web/vitest.config.ts (Node environment, no DOM).
// =============================================================================

const VALID_TOKENS: AuthTokens = {
  accessToken: 'access',
  refreshToken: 'refresh',
  accessExpiresAt: '2099-01-01T00:00:00Z',
  refreshExpiresAt: '2099-02-01T00:00:00Z',
};

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'u-1',
    email: 'someone@nockta.com',
    kind: 'internal',
    companyRole: 'Member',
    ...overrides,
  };
}

describe('shouldRedirectToLogin', () => {
  it('redirects when no tokens are present', () => {
    expect(shouldRedirectToLogin(null)).toBe(true);
  });

  it('does not redirect when tokens exist (even if expired — refresh handles that)', () => {
    // The refresh path is the source of truth for expiry; redirecting on
    // expired tokens here would cause a spurious /login flash when refresh
    // is in flight. Pin the behavior so a future refactor doesn't break it.
    expect(shouldRedirectToLogin(VALID_TOKENS)).toBe(false);
    expect(
      shouldRedirectToLogin({
        ...VALID_TOKENS,
        accessExpiresAt: '2000-01-01T00:00:00Z',
      }),
    ).toBe(false);
  });
});

describe('canSeeAdminMemberActions', () => {
  it('hides admin actions from anonymous users', () => {
    expect(canSeeAdminMemberActions(null)).toBe(false);
  });

  it('hides admin actions from internal Members (project Managers don\'t get workspace admin)', () => {
    expect(canSeeAdminMemberActions(user({ companyRole: 'Member' }))).toBe(false);
  });

  it('hides admin actions from clients (defense in depth — they shouldn\'t even see the page)', () => {
    expect(
      canSeeAdminMemberActions(user({ kind: 'client', companyRole: null })),
    ).toBe(false);
  });

  it('shows admin actions to workspace Admins', () => {
    expect(canSeeAdminMemberActions(user({ companyRole: 'Admin' }))).toBe(true);
  });
});

describe('visibleTasksForViewer', () => {
  const allTasks = [
    { id: 't-internal', visibility: 'internal' as const },
    { id: 't-client', visibility: 'client_visible' as const },
  ];

  it('shows everything to a Manager', () => {
    expect(
      visibleTasksForViewer(allTasks, {
        role: 'Manager',
        defaultTaskVisibility: 'internal',
      }),
    ).toEqual(allTasks);
  });

  it('shows everything to a Contributor', () => {
    expect(
      visibleTasksForViewer(allTasks, {
        role: 'Contributor',
        defaultTaskVisibility: 'internal',
      }),
    ).toEqual(allTasks);
  });

  it('shows everything to a Viewer', () => {
    expect(
      visibleTasksForViewer(allTasks, {
        role: 'Viewer',
        defaultTaskVisibility: 'internal',
      }),
    ).toEqual(allTasks);
  });

  it('hides internal tasks from clients in curated mode', () => {
    // This is the big one — if it ever flips, every guest on every curated
    // project sees the team's internal chatter. The test is on the FE
    // mirror of tasks.service.listByProject's filter; they MUST agree.
    const result = visibleTasksForViewer(allTasks, {
      role: 'Client',
      defaultTaskVisibility: 'internal',
    });
    expect(result).toEqual([{ id: 't-client', visibility: 'client_visible' }]);
  });

  it('shows everything to clients on an open project (defaultTaskVisibility=client_visible)', () => {
    // The "Open" sharing mode opt-in: project Manager has chosen to share
    // the whole scope. Internal tasks become visible.
    expect(
      visibleTasksForViewer(allTasks, {
        role: 'Client',
        defaultTaskVisibility: 'client_visible',
      }),
    ).toEqual(allTasks);
  });

  it('returns empty array when role is null', () => {
    expect(
      visibleTasksForViewer(allTasks, {
        role: null,
        defaultTaskVisibility: 'client_visible',
      }),
    ).toEqual([]);
  });
});
