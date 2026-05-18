import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { SessionService } from '../session.service';
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
    return {
      id: user.id,
      email: user.email,
      kind: user.kind,
      companyRole: user.companyRole,
      jti: payload.jti,
    };
  }
}
