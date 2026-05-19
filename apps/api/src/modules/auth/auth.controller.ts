import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import type { Request, Response } from 'express';

import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

import { AuditLogService } from './audit-log.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import type { MagicLinkRequestDto } from './dto/magic-link-request.dto';
import type { MagicLinkVerifyDto } from './dto/magic-link-verify.dto';
import type { RefreshDto } from './dto/refresh.dto';
import { SessionsService } from './sessions.service';
import type { GoogleProfile } from './strategies/google.strategy';
import type { AuthenticatedUser, TokenPair } from './types';

class RevokeOthersDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export type DevPersona =
  | 'admin'
  | 'engineering'
  | 'design'
  | 'guest'
  | 'guest-contributor'
  | 'guest-viewer'
  | 'guest-client';

class DevLoginDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  /**
   * Quick-login persona. When supplied, the server upserts the canonical
   * user for that persona (and seeds team membership where relevant) and
   * ignores `email`. Used by the LoginPage's dev-mode role picker.
   * `guest` is an alias for `guest-client` (kept for legacy bookmarks).
   */
  @IsOptional()
  @IsIn(['admin', 'engineering', 'design', 'guest', 'guest-contributor', 'guest-viewer', 'guest-client'])
  persona?: DevPersona;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditLogService,
  ) {}

  // ---------- Dev-only convenience ----------

  /**
   * DEV-ONLY: upsert an @nockta.com Admin and mint a token pair. Disabled when
   * NODE_ENV === 'production'. Used by the web app's "Sign in as admin (dev)"
   * button so the UI is usable without real Google OAuth credentials. The
   * service-layer guard (devLoginByEmail) re-checks NODE_ENV defensively.
   */
  @Public()
  @Throttle({ auth: { ttl: 60_000, limit: 5 } })
  @Post('dev-login')
  @ApiOperation({ summary: 'Dev-only: upsert an @nockta.com Admin and issue tokens.' })
  async devLogin(@Body() body: DevLoginDto, @Req() req: Request): Promise<TokenPair> {
    if (body.persona) {
      return this.auth.devLoginAsPersona(body.persona, req.ip);
    }
    const email = body.email ?? `admin@${Env.GOOGLE_OAUTH_ALLOWED_DOMAIN}`;
    return this.auth.devLoginByEmail(email, req.ip);
  }

  // ---------- Google OAuth (internal users) ----------

  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Begin Google OAuth flow. Redirects to Google consent.' })
  startGoogle(): void {
    // Passport handles the redirect; this handler is never reached.
  }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({
    summary: 'OAuth callback. Issues tokens, redirects to the internal app with token fragment.',
  })
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const profile = req.user as GoogleProfile;
    const ip = req.ip;
    const outcome = await this.auth.loginWithGoogle(profile, ip);
    // Use URL fragment so tokens don't end up in server logs / referer headers.
    const url = new URL('/auth/callback', Env.APP_URL_INTERNAL);
    url.hash = new URLSearchParams({
      access_token: outcome.accessToken,
      refresh_token: outcome.refreshToken,
      access_expires_at: outcome.accessTokenExpiresAt,
      refresh_expires_at: outcome.refreshTokenExpiresAt,
    }).toString();
    res.redirect(url.toString());
  }

  // ---------- Magic-link (clients) ----------

  @Public()
  @Throttle({ auth: { ttl: 60_000, limit: 3 } })
  @Post('magic-link/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a magic-link email (clients only).' })
  async magicLinkRequest(@Body() dto: MagicLinkRequestDto, @Req() req: Request): Promise<{ ok: true }> {
    await this.auth.requestMagicLink(dto.email, req.ip);
    return { ok: true };
  }

  @Public()
  @Post('magic-link/verify')
  @ApiOperation({ summary: 'Verify a magic-link token and issue tokens.' })
  async magicLinkVerify(@Body() dto: MagicLinkVerifyDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.verifyMagicLink(dto.email, dto.token, req.ip);
  }

  // ---------- Refresh / logout ----------

  @Public()
  @Throttle({ auth: { ttl: 60_000, limit: 30 } })
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate the refresh token. Detects reuse.' })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken, req.ip, req.headers['user-agent']);
  }

  @Post('logout')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current access token JTI and (optionally) refresh token.' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: Partial<RefreshDto>,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.logout(user.jti, dto.refreshToken, user.id, req.ip);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user.' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    // Never expose the access-token JTI — it's a server-side revocation handle,
    // not user-facing identity. Also fetch `name` + `avatarUrl` so the frontend
    // sidebar can render a real display name.
    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        name: true,
        avatarUrl: true,
      },
    });
    return {
      id: user.id,
      email: user.email,
      kind: user.kind,
      companyRole: user.companyRole,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    };
  }

  // ---------- Sessions ----------

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active refresh-token sessions for the current user.' })
  async listSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('currentRefreshToken') currentRefreshToken?: string,
  ) {
    return this.sessions.list(user.id, currentRefreshToken ?? null);
  }

  @Post('sessions/:id/revoke')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a specific session.' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.sessions.revoke(user.id, id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('sessions/revoke-others')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke every session except the one belonging to the caller.' })
  async revokeOtherSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RevokeOthersDto,
    @Req() req: Request,
  ) {
    return this.sessions.revokeOthers(user.id, dto.refreshToken ?? null, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // ---------- Audit log ----------

  @Get('audit-log')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Recent login/MFA/session events for the current user.' })
  async auditLog(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number(limit) : 50;
    return this.audit.listForUser(user.id, Number.isFinite(n) ? n : 50);
  }
}
