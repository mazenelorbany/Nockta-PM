import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { SessionService } from '../session.service';
import { DEFAULT_WORKSPACE_ID } from '../../workspace/workspace-context.service';
import type { AuthenticatedUser, JwtPayload } from '../types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: Env.JWT_ACCESS_SECRET,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Fast revocation check (if SessionService is tracking jti revocations in Redis).
    if (await this.sessions.isJtiRevoked(payload.jti)) {
      throw new UnauthorizedException('Token revoked');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, kind: true, companyRole: true, archivedAt: true, workspaceId: true },
    });
    if (!user || user.archivedAt) {
      throw new UnauthorizedException('User not found or archived');
    }
    // Workspace resolution preference order:
    //   1. JWT `workspaceId` claim — present on tokens minted after Pass A.
    //   2. User.workspaceId column — present on every row after migration 0009.
    //   3. DEFAULT_WORKSPACE_ID — safety net for legacy paths.
    // We deliberately don't hit WorkspaceContextService here to avoid a
    // hard dependency from auth -> workspace; the JWT + the column are
    // both authoritative enough for guard-time use.
    const workspaceId = payload.workspaceId ?? user.workspaceId ?? DEFAULT_WORKSPACE_ID;
    return {
      id: user.id,
      email: user.email,
      kind: user.kind,
      companyRole: user.companyRole,
      jti: payload.jti,
      workspaceId,
    };
  }
}
