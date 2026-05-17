import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CompanyRole, UserKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate, normalizeLimit } from '../../common/pagination/cursor-pagination';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/types';
import { Env } from '../../config/env';

type KindFilter = UserKind | 'all';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly auth: AuthService,
  ) {}

  /**
   * Admin-only: create a `kind='client'` user row up-front and email them a
   * magic-link to sign in. Two reasons to pre-create instead of letting the
   * magic-link verify path do it lazily:
   *
   *   1. The user shows up in the workspace user picker immediately, so an
   *      Admin can grant project access to the guest BEFORE they've signed in
   *      for the first time. Without this step, the guest would have to log
   *      in once before they appear in any UI.
   *   2. We can attach a display name now (from the email's local part, or
   *      one the Admin types in) instead of falling back to whatever the
   *      auth verify path infers.
   *
   * Rejects company-domain emails — those should sign in via Google OAuth
   * as internal users, not via the guest path.
   */
  async inviteGuest(
    actor: AuthenticatedUser,
    input: { email: string; name?: string },
  ): Promise<{
    id: string;
    email: string;
    name: string;
    kind: 'client';
    invitedAt: string;
    alreadyExisted: boolean;
  }> {
    if (actor.companyRole !== 'Admin') {
      throw new ForbiddenException('Admin only');
    }
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Invalid email');
    }
    const domain = email.split('@')[1];
    if (domain === Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
      throw new BadRequestException(
        `Invite-guest is for external clients. ${email} is on the company domain — ` +
          `they sign in via Google OAuth automatically.`,
      );
    }
    const name = (input.name?.trim() || email.split('@')[0] || 'Guest').slice(0, 120);

    // Upsert — if the email already exists we keep the existing row but still
    // re-send the magic link so the Admin can re-invite a guest who lost
    // theirs. Internal users with the same email are an edge case (the domain
    // check above blocks the common path); upsert refuses to switch their
    // kind, so they stay internal.
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, kind: true, name: true },
    });
    if (existing && existing.kind === 'internal') {
      throw new BadRequestException(
        `${email} is already an internal user; can't also invite as guest.`,
      );
    }
    const user = await this.prisma.user.upsert({
      where: { email },
      update: {}, // don't clobber any state the guest set during a previous session
      create: {
        email,
        name,
        kind: 'client',
        companyRole: null,
        // Single-tenant deployments live on the seeded 'default' workspace
        // (migration 0009). Multi-tenant onboarding will pick the actor's
        // active workspace from a future WorkspaceContextService.
        workspaceId: 'default',
      },
    });

    if (!existing) {
      this.events.emit('user.guest_invited', { userId: user.id, actorUserId: actor.id, email });
    }

    // Fire the magic-link email. This creates a MagicLink row + dispatches
    // via MailService; the link lands on apps/web's /auth/magic page and
    // signs them in.
    await this.auth.requestMagicLink(email);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      kind: 'client',
      invitedAt: new Date().toISOString(),
      alreadyExisted: Boolean(existing),
    };
  }

  async listInternal(params: {
    cursor?: string;
    limit?: number;
    kind?: KindFilter;
    archived?: boolean;
    q?: string;
  }) {
    const limit = normalizeLimit(params.limit);
    const kindFilter = params.kind ?? 'internal';
    const where = {
      ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
      ...(params.archived ? { archivedAt: { not: null } } : { archivedAt: null }),
      ...(params.q
        ? {
            OR: [
              { email: { contains: params.q, mode: 'insensitive' as const } },
              { name: { contains: params.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const users = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        kind: true,
        companyRole: true,
        archivedAt: true,
        createdAt: true,
        // Team chips on each row so the admin sees membership at a glance —
        // small payload (slug + name only) and bounded by the workspace team
        // count which is in the tens, not thousands.
        teamMemberships: {
          select: {
            team: { select: { id: true, slug: true, name: true } },
          },
        },
      },
    });
    const flattened = users.map((u) => ({
      ...u,
      teams: u.teamMemberships.map((m) => m.team),
      teamMemberships: undefined,
    }));
    return paginate(flattened, limit, (u) => u.id);
  }

  async getById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, name: true, avatarUrl: true,
        kind: true, companyRole: true, archivedAt: true, createdAt: true,
        teamMemberships: {
          include: {
            team: { select: { id: true, slug: true, name: true, description: true } },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    // Project access view: which projects can this user actually see, and at
    // which role? For Admins this is "every project, as Manager-equivalent";
    // for everyone else it's the union of direct grants, team grants, and
    // public-project Viewer access.
    const projects = await this.resolveProjectAccess(user.id, user.kind, user.companyRole);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      kind: user.kind,
      companyRole: user.companyRole,
      archivedAt: user.archivedAt,
      createdAt: user.createdAt,
      teams: user.teamMemberships.map((m) => m.team),
      projects,
    };
  }

  async changeRole(actor: AuthenticatedUser, userId: string, role: CompanyRole) {
    if (actor.companyRole !== 'Admin') throw new ForbiddenException('Admin only');
    // Promoting a guest to Admin/Member implicitly flips their kind back to
    // internal. Without this, the role would be set but `kind` would still be
    // 'client', leaving them on the client portal — a confusing half-state.
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, kind: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');

    const willPromoteFromClient = target.kind === 'client';
    if (willPromoteFromClient) {
      const domain = target.email.split('@')[1];
      // Internal users sign in via Google OAuth on the company domain. We don't
      // strictly enforce that on the schema, but we surface a warning-as-error
      // when promoting a guest whose email isn't on the company domain — the
      // Admin almost always wants to fix the email first.
      if (Env.GOOGLE_OAUTH_ALLOWED_DOMAIN && domain !== Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
        throw new BadRequestException(
          `${target.email} is not on the company domain (${Env.GOOGLE_OAUTH_ALLOWED_DOMAIN}). ` +
            `Update the user's email first, then promote them.`,
        );
      }
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        companyRole: role,
        ...(willPromoteFromClient ? { kind: 'internal' as const } : {}),
      },
    });
    this.events.emit('user.role_changed', {
      userId,
      role,
      actorUserId: actor.id,
      kindFlipped: willPromoteFromClient,
    });
    return { id: user.id, companyRole: user.companyRole, kind: user.kind };
  }

  /**
   * Flip a user between internal and client (guest). Used by the Admin
   * Members panel to demote a teammate to a guest or promote a guest back.
   *
   * Demote (internal → client):
   *   - Refuses if the user's email is on the company OAuth domain — clients
   *     belong on external addresses. Admin should change the email first.
   *   - Clears `companyRole` (clients never carry Admin/Member).
   *   - Wipes team memberships (clients are excluded from Teams by spec §4).
   *
   * Promote (client → internal):
   *   - Sets `companyRole` to `Member` by default; Admin can bump to Admin
   *     afterward via the standard role control.
   */
  async changeKind(
    actor: AuthenticatedUser,
    userId: string,
    kind: UserKind,
  ): Promise<{ id: string; kind: UserKind; companyRole: CompanyRole | null }> {
    if (actor.companyRole !== 'Admin') throw new ForbiddenException('Admin only');
    if (actor.id === userId) {
      throw new ForbiddenException("Can't change your own kind");
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, kind: true, companyRole: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.kind === kind) {
      return { id: user.id, kind: user.kind, companyRole: user.companyRole };
    }

    if (kind === 'client') {
      // Block demotion of company-domain accounts — those are SSO users and
      // shouldn't masquerade as external guests.
      const domain = user.email.split('@')[1];
      if (Env.GOOGLE_OAUTH_ALLOWED_DOMAIN && domain === Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
        throw new BadRequestException(
          `${user.email} is on the company domain — it must stay internal. ` +
            `Change the email to an external address before converting to Guest.`,
        );
      }
      // Demote in a transaction so we don't end up with a client who still
      // belongs to a Team (which the rest of the codebase assumes is impossible).
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.teamMember.deleteMany({ where: { userId } });
        return tx.user.update({
          where: { id: userId },
          data: { kind: 'client', companyRole: null },
          select: { id: true, kind: true, companyRole: true },
        });
      });
      this.events.emit('user.kind_changed', { userId, kind: 'client', actorUserId: actor.id });
      return updated;
    }

    // Promote client → internal. Default to Member; Admin can promote further.
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { kind: 'internal', companyRole: 'Member' },
      select: { id: true, kind: true, companyRole: true },
    });
    this.events.emit('user.kind_changed', { userId, kind: 'internal', actorUserId: actor.id });
    return updated;
  }

  /**
   * Admin-only: rename a user and/or fix their email. Mostly used to clean up
   * Jira-imported placeholder rows (where email was generated as
   * `<jiraAccountId>@jira-imported.local` because Jira didn't return a real
   * one). Both fields are optional — pass whichever you want to change.
   *
   * Rules:
   *   - Email must be RFC-ish and unique workspace-wide.
   *   - Internal users keep an internal email (anything on the company
   *     domain is fine; cross-domain reassignment is allowed because the
   *     person may have moved off the placeholder onto a real corporate
   *     address that isn't on the @nockta.com domain).
   *   - Client (guest) users must NOT receive a company-domain email — that
   *     would conflict with the Google-OAuth-only invariant for internals.
   */
  async updateProfile(
    actor: AuthenticatedUser,
    userId: string,
    input: { name?: string; email?: string },
  ): Promise<{ id: string; name: string; email: string }> {
    if (actor.companyRole !== 'Admin') throw new ForbiddenException('Admin only');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, kind: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const data: { name?: string; email?: string } = {};

    if (typeof input.name === 'string') {
      const next = input.name.trim();
      if (next.length === 0) throw new BadRequestException('Name cannot be empty');
      if (next.length > 120) throw new BadRequestException('Name too long (max 120)');
      if (next !== user.name) data.name = next;
    }

    if (typeof input.email === 'string') {
      const next = input.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
        throw new BadRequestException('Invalid email');
      }
      if (next !== user.email.toLowerCase()) {
        const domain = next.split('@')[1];
        if (user.kind === 'client' && domain === Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
          throw new BadRequestException(
            `Clients can't use the company-domain email ${next}. Promote the user to internal first.`,
          );
        }
        const collision = await this.prisma.user.findUnique({
          where: { email: next },
          select: { id: true },
        });
        if (collision && collision.id !== userId) {
          throw new BadRequestException(`Email ${next} is already in use`);
        }
        data.email = next;
      }
    }

    if (Object.keys(data).length === 0) {
      return { id: user.id, name: user.name, email: user.email };
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true },
    });
    this.events.emit('user.profile_updated', {
      userId,
      actorUserId: actor.id,
      changes: data,
    });
    return updated;
  }

  /**
   * Replace a user's team membership set in one call. The web's user-detail
   * panel uses this rather than chaining add/remove because it lets the admin
   * stage changes and commit them atomically.
   */
  async setTeams(actor: AuthenticatedUser, userId: string, teamIds: string[]) {
    if (actor.companyRole !== 'Admin') throw new ForbiddenException('Admin only');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, kind: true } });
    if (!user) throw new NotFoundException('User not found');
    // Clients are never granted via Teams (spec §4). Reject defensively.
    if (user.kind === 'client' && teamIds.length > 0) {
      throw new ForbiddenException('Clients cannot belong to Teams');
    }
    const unique = Array.from(new Set(teamIds));
    if (unique.length > 0) {
      const found = await this.prisma.team.findMany({
        where: { id: { in: unique } },
        select: { id: true },
      });
      if (found.length !== unique.length) {
        throw new NotFoundException('One or more teams not found');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.teamMember.deleteMany({ where: { userId } });
      if (unique.length > 0) {
        await tx.teamMember.createMany({
          data: unique.map((teamId) => ({ teamId, userId })),
          skipDuplicates: true,
        });
      }
    });
    this.events.emit('user.teams_changed', { userId, teamIds: unique, actorUserId: actor.id });
    return { id: userId, teamIds: unique };
  }

  /**
   * Per-user preferences scoped to "me". Today only the weekly worklog target
   * (used by the personal dashboard's streak widget) lives here. Splitting
   * this from `updateProfile` (which is Admin-only) keeps the auth model
   * obvious — the user owns their own preferences.
   *
   * `weeklyHoursTarget`:
   *   - `null` clears the target entirely (the streak widget hides itself).
   *   - 1..168 inclusive — clamped at the schema layer; the service guards the
   *     upper bound against typos like 1000.
   */
  async updateMyPreferences(
    actor: AuthenticatedUser,
    input: { weeklyHoursTarget?: number | null; pomodoroEnabled?: boolean },
  ): Promise<{ id: string; weeklyHoursTarget: number | null; pomodoroEnabled: boolean }> {
    const data: { weeklyHoursTarget?: number | null; pomodoroEnabled?: boolean } = {};
    if (input.weeklyHoursTarget !== undefined) {
      if (input.weeklyHoursTarget === null) {
        data.weeklyHoursTarget = null;
      } else {
        const n = Math.trunc(input.weeklyHoursTarget);
        if (!Number.isFinite(n) || n < 1 || n > 168) {
          throw new BadRequestException('weeklyHoursTarget must be between 1 and 168');
        }
        data.weeklyHoursTarget = n;
      }
    }
    if (input.pomodoroEnabled !== undefined) {
      data.pomodoroEnabled = Boolean(input.pomodoroEnabled);
    }
    const updated = await this.prisma.user.update({
      where: { id: actor.id },
      data,
      select: { id: true, weeklyHoursTarget: true, pomodoroEnabled: true },
    });
    return updated;
  }

  /**
   * Read "me"-scoped preferences. Returns `weeklyHoursTarget` so the personal
   * dashboard knows whether to render the streak widget plus `pomodoroEnabled`
   * which the ActiveTimerChip reads to decide whether to overlay the pomodoro
   * phase. Kept narrow so we can add more keys here without auditing every
   * call site.
   */
  async getMyPreferences(
    actor: AuthenticatedUser,
  ): Promise<{ weeklyHoursTarget: number | null; pomodoroEnabled: boolean }> {
    const row = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { weeklyHoursTarget: true, pomodoroEnabled: true },
    });
    return {
      weeklyHoursTarget: row?.weeklyHoursTarget ?? null,
      pomodoroEnabled: row?.pomodoroEnabled ?? false,
    };
  }

  async archive(actor: AuthenticatedUser, userId: string) {
    if (actor.companyRole !== 'Admin') throw new ForbiddenException('Admin only');
    if (actor.id === userId) throw new ForbiddenException('Cannot archive yourself');
    await this.prisma.user.update({ where: { id: userId }, data: { archivedAt: new Date() } });
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.events.emit('user.archived', { userId, actorUserId: actor.id });
  }

  async unarchive(actor: AuthenticatedUser, userId: string) {
    if (actor.companyRole !== 'Admin') throw new ForbiddenException('Admin only');
    await this.prisma.user.update({ where: { id: userId }, data: { archivedAt: null } });
    this.events.emit('user.unarchived', { userId, actorUserId: actor.id });
  }

  // ---------------- helpers ----------------

  private async resolveProjectAccess(
    userId: string,
    kind: UserKind,
    companyRole: CompanyRole | null,
  ) {
    if (kind === 'internal' && companyRole === 'Admin') {
      const all = await this.prisma.project.findMany({
        where: { archivedAt: null },
        select: { id: true, key: true, name: true, visibility: true },
        orderBy: { key: 'asc' },
      });
      return all.map((p) => ({ ...p, role: 'Manager' as const, source: 'admin' as const }));
    }
    const teamIds = (
      await this.prisma.teamMember.findMany({
        where: { userId },
        select: { teamId: true },
      })
    ).map((m) => m.teamId);

    const accessibleProjects = await this.prisma.project.findMany({
      where: {
        archivedAt: null,
        OR: [
          { accessGrants: { some: { subjectKind: 'user', userId } } },
          ...(teamIds.length > 0
            ? [{ accessGrants: { some: { subjectKind: 'team' as const, teamId: { in: teamIds } } } }]
            : []),
          ...(kind === 'internal' ? [{ visibility: 'public' as const }] : []),
        ],
      },
      select: {
        id: true,
        key: true,
        name: true,
        visibility: true,
        accessGrants: {
          where: {
            OR: [
              { subjectKind: 'user', userId },
              ...(teamIds.length > 0
                ? [{ subjectKind: 'team' as const, teamId: { in: teamIds } }]
                : []),
            ],
          },
          select: { id: true, role: true, subjectKind: true, teamId: true },
        },
      },
      orderBy: { key: 'asc' },
    });
    // Higher number wins. For clients we seed `best` with Client rather than
    // Viewer (was a long-standing display bug: a client with a Client grant
    // would render as "Viewer via public"). For internals on a public project
    // with no explicit grant, Viewer/public is the correct default.
    const rankOrder = { Manager: 4, Contributor: 3, Viewer: 2, Client: 1 } as const;
    return accessibleProjects.map((p) => {
      let best: {
        role: keyof typeof rankOrder;
        source: 'user' | 'team' | 'public';
        grantId: string | null;
      } = kind === 'client'
        ? { role: 'Client', source: 'user', grantId: null }
        : { role: 'Viewer', source: 'public', grantId: null };
      for (const g of p.accessGrants) {
        const rank = rankOrder[g.role];
        if (rank > rankOrder[best.role]) {
          best = {
            role: g.role,
            source: g.subjectKind === 'team' ? 'team' : 'user',
            grantId: g.subjectKind === 'team' ? null : g.id,
          };
        } else if (
          rank === rankOrder[best.role] &&
          g.subjectKind === 'user' &&
          best.grantId === null
        ) {
          // Same role but direct user grant — prefer it so the UI can revoke.
          best = { role: g.role, source: 'user', grantId: g.id };
        }
      }
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        visibility: p.visibility,
        role: best.role,
        source: best.source,
        grantId: best.grantId,
      };
    });
  }
}
