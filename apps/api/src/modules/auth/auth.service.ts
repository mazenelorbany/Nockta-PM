import { randomBytes, createHash } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ulid } from 'ulid';

import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

import { AuditLogService } from './audit-log.service';
import { MailService } from './mail.service';
import { SessionService } from './session.service';
import type { GoogleProfile } from './strategies/google.strategy';
import type { JwtPayload, TokenPair } from './types';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly sessions: SessionService,
    private readonly events: EventEmitter2,
    private readonly audit: AuditLogService,
  ) {}

  /// Issue tokens for a user by id. Used by token-rotation callers and any
  /// future re-entry path that's already established the user identity.
  async issueTokensForUser(
    userId: string,
    ip?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, kind: true, companyRole: true, archivedAt: true },
    });
    if (user.archivedAt) throw new UnauthorizedException('User is archived');
    return this.issueTokens({
      sub: user.id,
      email: user.email,
      kind: user.kind,
      role: user.companyRole,
      ...(ip ? { ip } : {}),
      ...(userAgent ? { userAgent } : {}),
    });
  }

  // ---------- Internal users — Google OAuth ----------

  async loginWithGoogle(profile: GoogleProfile, ip?: string): Promise<TokenPair> {
    const user = await this.prisma.user.upsert({
      where: { email: profile.email },
      update: {
        name: profile.name,
        ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
        googleId: profile.id,
      },
      create: {
        email: profile.email,
        name: profile.name,
        kind: 'internal',
        companyRole: 'Member',     // first user is upgraded to Admin via seed/migration
        googleId: profile.id,
        ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      },
    });
    if (user.archivedAt) {
      throw new UnauthorizedException('User is archived');
    }

    this.events.emit('user.login', { userId: user.id, ip, method: 'google' });
    await this.audit.record({
      userId: user.id,
      action: 'login.google',
      ip: ip ?? null,
    });
    return this.issueTokens({
      sub: user.id,
      email: user.email,
      kind: user.kind,
      role: user.companyRole,
      ip,
    });
  }

  // ---------- Clients — magic links ----------

  async requestMagicLink(email: string, ip?: string): Promise<void> {
    // Reject Nockta-domain addresses — those use Google OAuth, not magic-link.
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain === Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
      throw new BadRequestException(
        `Internal accounts must sign in via Google. Email ${email} is on the company domain.`,
      );
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + Env.MAGIC_LINK_TTL_SECONDS * 1000);

    // Existence is recorded regardless of whether the user already exists — the
    // sign-up vs login distinction is decided at verification time.
    const exists = await this.prisma.user.findUnique({ where: { email } });
    await this.prisma.magicLink.create({
      data: {
        email,
        tokenHash,
        intent: exists ? 'client_login' : 'client_signup',
        expiresAt,
        ...(ip ? { ip } : {}),
      },
    });

    const url = `${Env.MAGIC_LINK_BASE_URL}?token=${rawToken}&email=${encodeURIComponent(email)}`;
    await this.mail.send({
      to: email,
      subject: 'Your Nockta Flow sign-in link',
      text: `Sign in to Nockta Flow:\n\n${url}\n\nThis link expires in ${Math.round(Env.MAGIC_LINK_TTL_SECONDS / 60)} minutes.`,
    });
    this.events.emit('auth.magic_link_sent', { email, ip });
  }

  /**
   * Send a project-scoped invitation. Different from `requestMagicLink` on
   * three axes:
   *   - Intent is recorded as `project_invite` so verifyMagicLink can route
   *     the post-accept landing page to the project board instead of the
   *     generic dashboard.
   *   - TTL is `PROJECT_INVITE_TTL_SECONDS` (default 7 days). Invitations
   *     sit in inboxes; a 15-minute sign-in TTL would force the admin to
   *     re-send most of them.
   *   - Email subject + body name the project and inviter, which gives the
   *     recipient enough context to trust the link.
   */
  async sendProjectInvite(args: {
    email: string;
    projectId: string;
    projectName: string;
    inviterUserId: string;
    inviterName: string;
    role: string;
    ip?: string;
  }): Promise<void> {
    const email = args.email.toLowerCase();
    const domain = email.split('@')[1];
    if (domain === Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
      throw new BadRequestException(
        `Project invitations are for external collaborators. ${email} is on the company domain — ` +
          `they sign in via Google OAuth and don't need an invitation link.`,
      );
    }

    // Invalidate any prior outstanding invite for the same (email, project) —
    // re-inviting should produce exactly one valid link, not stack them.
    await this.prisma.magicLink.updateMany({
      where: {
        email,
        projectId: args.projectId,
        intent: 'project_invite',
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { expiresAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + Env.PROJECT_INVITE_TTL_SECONDS * 1000);

    await this.prisma.magicLink.create({
      data: {
        email,
        tokenHash,
        intent: 'project_invite',
        expiresAt,
        projectId: args.projectId,
        invitedByUserId: args.inviterUserId,
        ...(args.ip ? { ip: args.ip } : {}),
      },
    });

    const url = `${Env.MAGIC_LINK_BASE_URL}?token=${rawToken}&email=${encodeURIComponent(email)}`;
    const days = Math.round(Env.PROJECT_INVITE_TTL_SECONDS / 86_400);
    await this.mail.send({
      to: email,
      subject: `${args.inviterName} invited you to collaborate on ${args.projectName}`,
      text:
        `Hi,\n\n` +
        `${args.inviterName} has invited you to collaborate on the ${args.projectName} ` +
        `project in Nockta Flow as a ${args.role}.\n\n` +
        `Click the link below to accept and sign in:\n\n${url}\n\n` +
        `The invitation expires in ${days} day${days === 1 ? '' : 's'}. If you weren't ` +
        `expecting this email you can safely ignore it.`,
    });
    this.events.emit('auth.magic_link_sent', { email, ip: args.ip });
  }

  async verifyMagicLink(
    email: string,
    rawToken: string,
    ip?: string,
  ): Promise<TokenPair & { redirectPath?: string }> {
    const tokenHash = sha256(rawToken);
    const link = await this.prisma.magicLink.findUnique({ where: { tokenHash } });

    if (!link || link.email.toLowerCase() !== email.toLowerCase()) {
      throw new UnauthorizedException('Invalid or expired link');
    }
    if (link.usedAt) {
      throw new UnauthorizedException('Link already used');
    }
    if (link.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Link expired');
    }

    // Atomically: mark the link as used + upsert the user. If two concurrent
    // verify calls hit the same link, only one updateMany succeeds — the
    // other gets count=0 and we fail closed. This prevents a link from
    // being "consumed" twice and avoids the window where the link is
    // marked used but the user upsert fails (leaking a consumed link
    // with no recoverable session).
    const result = await this.prisma.$transaction(async (tx) => {
      const used = await tx.magicLink.updateMany({
        where: { id: link.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (used.count === 0) {
        throw new UnauthorizedException('Link already used');
      }
      const upserted = await tx.user.upsert({
        where: { email },
        update: {},
        create: {
          email,
          name: email.split('@')[0] ?? 'Client',
          kind: 'client',
          companyRole: null,
        },
      });
      return upserted;
    });
    const user = result;
    if (user.archivedAt) throw new UnauthorizedException('User is archived');

    this.events.emit('user.login', { userId: user.id, ip, method: 'magic_link' });
    await this.audit.record({
      userId: user.id,
      action: 'login.magic_link',
      ip: ip ?? null,
    });

    const tokens = await this.issueTokens({
      sub: user.id,
      email: user.email,
      kind: user.kind,
      role: user.companyRole,
      ip,
    });

    // Project-scoped invitation? Hand back a deep link so the SPA can drop
    // the recipient onto the project board they were invited to instead of
    // the generic dashboard. Verified against the live link only — a stale
    // / spoofed projectId could otherwise route the user to a project they
    // don't actually have access to, but the magic-link verify already
    // ensures (a) the link was issued by us and (b) the project_invite
    // path's ProjectAccess grant happens at invite-send time.
    if (link.intent === 'project_invite' && link.projectId) {
      return { ...tokens, redirectPath: `/projects/${link.projectId}/board` };
    }
    return tokens;
  }

  // ---------- Token rotation ----------

  async refresh(rawRefreshToken: string, ip?: string, userAgent?: string): Promise<TokenPair> {
    const tokenHash = sha256(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');
    if (stored.revokedAt) throw new UnauthorizedException('Refresh token revoked');
    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Reuse detection: this token has already been rotated. Treat as compromised.
    if (stored.rotatedToId) {
      this.logger.warn(
        { userId: stored.userId, tokenId: stored.id },
        'Refresh token reuse detected — revoking all tokens for user',
      );
      await this.revokeAllRefreshTokens(stored.userId);
      this.events.emit('auth.refresh_reuse', { userId: stored.userId, ip });
      await this.audit.record({
        userId: stored.userId,
        action: 'token.refresh_reuse',
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });
      throw new UnauthorizedException('Refresh token reuse detected — please sign in again');
    }

    if (stored.user.archivedAt) {
      throw new UnauthorizedException('User is archived');
    }

    // Atomically rotate: mark the old token as rotated FIRST with a
    // conditional updateMany (only rotates if not already rotated). If
    // the row count is 0, a concurrent refresh got there first — fail
    // closed and treat this as reuse. Without this, two concurrent
    // refreshes can both pass the `if (stored.rotatedToId)` check above
    // and both succeed, doubling the user's access tokens.
    //
    // We mint the new token AFTER the conditional update so a failed
    // rotation doesn't leak an orphan refreshToken row.
    const rotated = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, rotatedToId: null, revokedAt: null },
      data: { revokedAt: new Date() }, // placeholder; rotatedToId set below
    });
    if (rotated.count === 0) {
      // Another concurrent refresh already consumed this token. Treat as
      // reuse for safety — revoke everything and force re-login.
      this.logger.warn(
        { userId: stored.userId, tokenId: stored.id },
        'Refresh token concurrent-rotation lost — revoking all tokens for user',
      );
      await this.revokeAllRefreshTokens(stored.userId);
      this.events.emit('auth.refresh_reuse', { userId: stored.userId, ip });
      throw new UnauthorizedException('Refresh token reuse detected — please sign in again');
    }

    const pair = await this.issueTokens({
      sub: stored.user.id,
      email: stored.user.email,
      kind: stored.user.kind,
      role: stored.user.companyRole,
      ip,
      userAgent,
    });

    // Now back-fill rotatedToId on the consumed row so future reuse
    // detection (the `if (stored.rotatedToId)` branch above) keeps
    // working — revokedAt alone wouldn't trigger the reuse alarm.
    const newStored = await this.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256(pair.refreshToken) },
    });
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { rotatedToId: newStored.id },
    });

    return pair;
  }

  async logout(jti: string, refreshTokenRaw?: string, userId?: string, ip?: string): Promise<void> {
    await this.sessions.revokeJti(jti);
    if (refreshTokenRaw) {
      await this.prisma.refreshToken
        .update({
          where: { tokenHash: sha256(refreshTokenRaw) },
          data: { revokedAt: new Date() },
        })
        .catch(() => undefined); // ignore not-found
    }
    if (userId) {
      await this.audit.record({
        userId,
        action: 'logout',
        ip: ip ?? null,
      });
    }
  }

  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Dev-auth gate. ALL three dev-login paths funnel through this single
   * check so a future refactor can't accidentally skip the gate on one
   * code path. The only knob is `Env.DEV_AUTH_ENABLED`, which defaults
   * to `false` and is loud at every boot when flipped on (see the
   * banner in apps/api/src/main.ts).
   *
   * Why not also block on `NODE_ENV === 'production'`? Because the
   * production deploy sometimes needs dev-login briefly — to confirm
   * the api + web are wired together before Google OAuth credentials
   * are pasted. The boot-time warning + the explicit env-var-flip
   * combine to make dev-auth-in-prod a deliberate, very visible action,
   * not an accidental drift.
   */
  private assertDevAuthAllowed(): void {
    if (!Env.DEV_AUTH_ENABLED) {
      throw new UnauthorizedException(
        'Dev login is disabled. Set DEV_AUTH_ENABLED=true to enable.',
      );
    }
  }

  /** DEV-ONLY: issue a token pair for an existing user by id. */
  async devLoginFor(userId: string): Promise<TokenPair> {
    this.assertDevAuthAllowed();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.issueTokens({
      sub: user.id,
      email: user.email,
      kind: user.kind,
      role: user.companyRole,
    });
  }

  /** DEV-ONLY: upsert an internal Admin user by email and mint a token pair.
   *  Used by the "Sign in as admin (dev only)" button on the web LoginPage when
   *  Google OAuth isn't configured. */
  async devLoginByEmail(email: string, ip?: string): Promise<TokenPair> {
    this.assertDevAuthAllowed();
    const normalized = email.toLowerCase();
    const domain = normalized.split('@')[1];
    if (domain !== Env.GOOGLE_OAUTH_ALLOWED_DOMAIN) {
      throw new BadRequestException(
        `Dev login requires an @${Env.GOOGLE_OAUTH_ALLOWED_DOMAIN} email`,
      );
    }
    const user = await this.prisma.user.upsert({
      where: { email: normalized },
      update: {},
      create: {
        email: normalized,
        name: normalized.split('@')[0] ?? 'Admin',
        kind: 'internal',
        companyRole: 'Admin',
      },
    });
    if (user.archivedAt) throw new UnauthorizedException('User is archived');
    this.events.emit('user.login', { userId: user.id, ip, method: 'dev_login' });
    await this.audit.record({ userId: user.id, action: 'login.dev', ip: ip ?? null });
    return this.issueTokens({
      sub: user.id,
      email: user.email,
      kind: user.kind,
      role: user.companyRole,
      ip,
    });
  }

  /**
   * DEV-ONLY: upsert one of the canonical demo personas (admin, engineering
   * member, design member, external guest) and issue tokens. Used by the
   * LoginPage role picker so a dev can flip between roles in one click
   * without setting up Google OAuth or magic-link delivery.
   */
  async devLoginAsPersona(
    persona:
      | 'admin'
      | 'engineering'
      | 'design'
      | 'guest'
      | 'guest-contributor'
      | 'guest-viewer'
      | 'guest-client',
    ip?: string,
  ): Promise<TokenPair> {
    this.assertDevAuthAllowed();
    const domain = Env.GOOGLE_OAUTH_ALLOWED_DOMAIN;
    // Legacy `guest` is kept as an alias for `guest-client` so any saved
    // bookmarks / shortcuts keep working. The split lets us test the three
    // distinct external-user experiences end-to-end: a Contributor guest can
    // create real tasks, a Viewer guest is read-only on the same surfaces,
    // a Client guest is the bug-only "file a report" role.
    const personaKey = persona === 'guest' ? 'guest-client' : persona;
    const specs = {
      admin: {
        email: `admin@${domain}`,
        name: 'Dev Admin',
        kind: 'internal' as const,
        companyRole: 'Admin' as const,
        teamSlug: null,
        teamName: null,
        guestRole: null as null | 'Contributor' | 'Viewer' | 'Client',
      },
      engineering: {
        email: `engineer@${domain}`,
        name: 'Dev Engineer',
        kind: 'internal' as const,
        companyRole: 'Member' as const,
        teamSlug: 'engineering',
        teamName: 'Engineering',
        guestRole: null as null | 'Contributor' | 'Viewer' | 'Client',
      },
      design: {
        email: `designer@${domain}`,
        name: 'Dev Designer',
        kind: 'internal' as const,
        companyRole: 'Member' as const,
        teamSlug: 'design',
        teamName: 'Design',
        guestRole: null as null | 'Contributor' | 'Viewer' | 'Client',
      },
      'guest-contributor': {
        email: 'guest-contributor@external.test',
        name: 'Dev Guest (Contributor)',
        kind: 'client' as const,
        companyRole: null,
        teamSlug: null,
        teamName: null,
        guestRole: 'Contributor' as const,
      },
      'guest-viewer': {
        email: 'guest-viewer@external.test',
        name: 'Dev Guest (Viewer)',
        kind: 'client' as const,
        companyRole: null,
        teamSlug: null,
        teamName: null,
        guestRole: 'Viewer' as const,
      },
      'guest-client': {
        // Original guest — bug-only "file a report" client. Kept distinct
        // from the contributor / viewer flavours so the Client role
        // restrictions (Bug type, client_visible visibility) stay testable.
        email: 'guest@external.test',
        name: 'Dev Guest (Client)',
        kind: 'client' as const,
        companyRole: null,
        teamSlug: null,
        teamName: null,
        guestRole: 'Client' as const,
      },
    } as const;
    const spec = specs[personaKey];

    const user = await this.prisma.user.upsert({
      where: { email: spec.email },
      update: {},
      create: {
        email: spec.email,
        name: spec.name,
        kind: spec.kind,
        companyRole: spec.companyRole,
      },
    });
    if (user.archivedAt) throw new UnauthorizedException('User is archived');

    // For internal team personas, make sure the team exists and the user is
    // a member. Idempotent so repeated logins are cheap.
    if (spec.teamSlug && spec.teamName) {
      const team = await this.prisma.team.upsert({
        where: { slug: spec.teamSlug },
        update: {},
        create: {
          slug: spec.teamSlug,
          name: spec.teamName,
          createdById: user.id,
        },
      });
      await this.prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: team.id, userId: user.id } },
        update: {},
        create: { teamId: team.id, userId: user.id },
      });
    }

    // DEV-ONLY: for every guest persona, auto-grant the chosen project role
    // across every non-archived project AND flip every task's visibility to
    // `client_visible`. Without this the dev guest is locked out: clients
    // only see projects they've been explicitly invited to (ProjectAccess)
    // and only see tasks marked `client_visible`. Both operations are
    // idempotent so repeat logins are cheap. Role granted matches the
    // persona: Contributor for edit testing, Viewer for read-only, Client
    // for the legacy bug-only flow.
    if (spec.kind === 'client' && spec.guestRole) {
      const projects = await this.prisma.project.findMany({
        where: { archivedAt: null },
        select: { id: true },
      });
      if (projects.length > 0) {
        await this.prisma.projectAccess.createMany({
          data: projects.map((p) => ({
            projectId: p.id,
            userId: user.id,
            subjectKind: 'user' as const,
            role: spec.guestRole,
            grantedById: user.id,
          })),
          skipDuplicates: true,
        });
        await this.prisma.task.updateMany({
          where: { projectId: { in: projects.map((p) => p.id) }, visibility: 'internal' },
          data: { visibility: 'client_visible' },
        });
      }
    }

    this.events.emit('user.login', { userId: user.id, ip, method: 'dev_login', persona });
    await this.audit.record({
      userId: user.id,
      action: 'login.dev',
      ip: ip ?? null,
      metadata: { persona },
    });
    return this.issueTokens({
      sub: user.id,
      email: user.email,
      kind: user.kind,
      role: user.companyRole,
      ip,
    });
  }

  // ---------- Token issuance ----------

  private async issueTokens(input: {
    sub: string;
    email: string;
    kind: 'internal' | 'client';
    role: 'Admin' | 'Member' | null;
    ip?: string;
    userAgent?: string;
  }): Promise<TokenPair> {
    const jti = ulid();
    const payload: JwtPayload = {
      sub: input.sub,
      email: input.email,
      kind: input.kind,
      role: input.role,
      jti,
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: Env.JWT_ACCESS_SECRET,
      expiresIn: Env.JWT_ACCESS_TTL_SECONDS,
    });
    const accessTokenExpiresAt = new Date(
      Date.now() + Env.JWT_ACCESS_TTL_SECONDS * 1000,
    ).toISOString();

    const refreshRaw = randomBytes(48).toString('base64url');
    const refreshHash = sha256(refreshRaw);
    const refreshTokenExpiresAt = new Date(
      Date.now() + Env.JWT_REFRESH_TTL_SECONDS * 1000,
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: input.sub,
        tokenHash: refreshHash,
        expiresAt: refreshTokenExpiresAt,
        ...(input.ip ? { ip: input.ip } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      },
    });

    return {
      accessToken,
      refreshToken: refreshRaw,
      accessTokenExpiresAt,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    };
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
