// =============================================================================
// Security-critical UI predicates. Pulled out of React components so they can
// be unit-tested without spinning up a DOM or rendering tree. Each function
// here corresponds to a "would the wrong user see the wrong thing?" check —
// the bug-class that screenshots and manual QA miss.
//
// Components should import these instead of re-implementing the conditions
// inline. When you find an inline check in a component, lift it here and
// add a test case below in guards.test.ts.
// =============================================================================

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  kind: 'internal' | 'client';
  companyRole: 'Admin' | 'Member' | null;
}

/**
 * The ProtectedShell in App.tsx redirects to /login when there is no token.
 * Surface as a pure predicate so a future redirect-on-401 helper can share
 * the same condition without subtle drift.
 */
export function shouldRedirectToLogin(tokens: AuthTokens | null): boolean {
  return tokens === null;
}

/**
 * Should the user see Admin-only actions on Settings → Members?
 *
 * Admin actions include: invite guest, promote / demote roles, archive
 * accounts, reset 2FA. A Manager (project Manager) has zero workspace-level
 * admin power — they only manage projects they own. Clients of course see
 * nothing.
 *
 * Returns `true` ONLY for workspace Admins. Don't widen this without a
 * very deliberate reason — it's the membership-control panel.
 */
export function canSeeAdminMemberActions(user: AuthenticatedUser | null): boolean {
  if (!user) return false;
  if (user.kind !== 'internal') return false;
  return user.companyRole === 'Admin';
}

export interface VisibilityFilterContext {
  /** The viewer's effective project role. null means "no access at all". */
  role: 'Manager' | 'Contributor' | 'Viewer' | 'Client' | null;
  /** Project's sharing mode. 'internal' = curated (per-task visibility
   *  honored), 'client_visible' = open (guests see everything). */
  defaultTaskVisibility: 'internal' | 'client_visible';
}

interface TaskLike {
  id: string;
  visibility: 'internal' | 'client_visible';
}

/**
 * Filter the task list to what the viewer is allowed to see on the board.
 *
 * Mirrors the server-side filter in tasks.service.listByProject so the UI
 * never optimistically shows a row the server is about to hide. The two
 * MUST stay in sync — this predicate is what locks the contract.
 *
 * Rules:
 *   - Internal members (Manager/Contributor/Viewer): see everything.
 *   - Clients on a curated project (defaultTaskVisibility='internal'):
 *     only see tasks explicitly marked client_visible.
 *   - Clients on an open project (defaultTaskVisibility='client_visible'):
 *     see every task.
 *   - No role at all: see nothing.
 */
export function visibleTasksForViewer<T extends TaskLike>(
  tasks: T[],
  ctx: VisibilityFilterContext,
): T[] {
  if (ctx.role === null) return [];
  if (ctx.role !== 'Client') return tasks;
  // Client viewer.
  if (ctx.defaultTaskVisibility === 'client_visible') return tasks;
  return tasks.filter((t) => t.visibility === 'client_visible');
}
