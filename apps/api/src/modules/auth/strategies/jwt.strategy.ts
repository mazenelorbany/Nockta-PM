import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { SessionService } from '../session.service';
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
      select: { id: true, email: true, kind: true, companyRole: true, archivedAt: true },
    });
    if (!user || user.archivedAt) {
      throw new UnauthorizedException('User not found or archived');
    }
    // Best-effort heartbeat: update User.lastSeenAt for the Members tab
    // "Last Activity" column. Throttled to ~5 min via a conditional
    // updateMany so we're not stamping the row on every single request —
    // a chatty SPA can hit 30+ endpoints per minute. Fire-and-forget so
    // a transient DB blip can't block authentication.
    void this.touchLastSeen(user.id);
    return {
      id: user.id,
      email: user.email,
      kind: user.kind,
      companyRole: user.companyRole,
      jti: payload.jti,
    };
  }

  private async touchLastSeen(userId: string): Promise<void> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    await this.prisma.user
      .updateMany({
        where: { id: userId, lastSeenAt: { lt: fiveMinutesAgo } },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => {
        /* don't blow up auth over a heartbeat write */
      });
  }
}
