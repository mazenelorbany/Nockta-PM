import { randomBytes } from 'crypto';

import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { REDIS_CLIENT } from '../redis/redis.module';
import type { PrismaService } from '../../prisma/prisma.service';
import { Env } from '../../config/env';

/**
 * In-product GitHub App install flow.
 *
 * Without this, a second GitHub installation requires an admin to manually edit
 * environment variables and redeploy. With this controller, an authenticated
 * user can click "Connect GitHub" inside the app and walk through the standard
 * GitHub App install handshake.
 *
 * Flow:
 *   1. Frontend calls POST /api/v1/github/install/begin (bearer-token authed).
 *      We mint a short-lived `state` nonce, store it in Redis with a 10-min
 *      TTL, and return `{ url }` — a GitHub install URL with the nonce baked
 *      in. The frontend then `window.location.href = url` to navigate.
 *   2. User completes the install on GitHub. GitHub redirects to the App's
 *      configured setup URL: GET /api/v1/github/install/callback
 *      with `installation_id`, `setup_action`, and our `state` echoed back.
 *      This endpoint is unauthenticated — GitHub can't carry a bearer token.
 *      Security comes from the single-use Redis-resident state nonce.
 *   3. We verify the state matches the value we stored, sanity-check the
 *      installation exists in our DB (the webhook controller writes the row
 *      on `installation.created`), then redirect the user back to the
 *      integrations page with `?installed=1`.
 *
 * State is stored server-side (Redis) rather than in a cookie because the API
 * runs as a pure bearer-token service — no cookie-parser, no CSRF surface.
 * The state nonce is single-use: it is `DEL`-ed on first read.
 *
 * The actual `GithubInstallation` row is written by the webhook controller
 * when GitHub dispatches `installation.created`. We rely on GitHub to fire
 * that webhook before the redirect (it does, in practice); the integrations
 * page polls `GET /github/installations` after the redirect to confirm.
 */
@ApiTags('GitHub Integration')
@Controller('github')
export class GithubInstallController {
  private readonly logger = new Logger(GithubInstallController.name);
  private static readonly STATE_KEY_PREFIX = 'gh:install:state:';
  private static readonly STATE_TTL_SECONDS = 600;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Kick off the install flow. Returns the GitHub install URL with a fresh
   * state nonce baked into it. The frontend navigates the browser there.
   *
   * Why a JSON endpoint instead of a server-side redirect? The API is pure
   * bearer-token; top-level browser navigations don't carry the Authorization
   * header. The frontend has to issue an XHR (authed), receive the URL, and
   * then perform `window.location.href = url`.
   */
  @Post('install/begin')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mint a GitHub App install URL with a state nonce' })
  async begin(
    @Req() req: Request & { user?: { id: string } },
  ): Promise<{ url: string }> {
    if (!Env.GITHUB_APP_SLUG) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'GitHub App not configured',
          status: HttpStatus.SERVICE_UNAVAILABLE,
          detail:
            'GITHUB_APP_SLUG is not set on the API. An operator must configure ' +
            'the App credentials before the install flow becomes available.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const state = randomBytes(24).toString('hex');
    const userId = req.user?.id ?? 'anonymous';
    await this.redis.set(
      `${GithubInstallController.STATE_KEY_PREFIX}${state}`,
      userId,
      'EX',
      GithubInstallController.STATE_TTL_SECONDS,
    );
    const url = new URL(`https://github.com/apps/${Env.GITHUB_APP_SLUG}/installations/new`);
    url.searchParams.set('state', state);
    return { url: url.toString() };
  }

  /**
   * GitHub redirects here after the user completes the install. The state
   * nonce is consumed in a single round trip (Redis DEL), then we bounce
   * back to the web app with a success flag the integrations page renders.
   */
  @Get('install/callback')
  async installCallback(
    @Query('installation_id') installationIdRaw: string,
    @Query('setup_action') setupAction: string,
    @Query('state') state: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const target = new URL('/settings/integrations', Env.APP_URL_INTERNAL);

    if (!state) {
      target.searchParams.set('installed', '0');
      target.searchParams.set('error', 'missing_state');
      res.redirect(302, target.toString());
      return;
    }
    const stateKey = `${GithubInstallController.STATE_KEY_PREFIX}${state}`;
    // GETDEL is atomic — the nonce can only be consumed once.
    const storedUserId = await this.redis.getdel(stateKey);
    if (!storedUserId) {
      this.logger.warn('GitHub install callback rejected: state not found or expired');
      target.searchParams.set('installed', '0');
      target.searchParams.set('error', 'state_mismatch');
      res.redirect(302, target.toString());
      return;
    }

    if (setupAction !== 'install' && setupAction !== 'update') {
      // Cancelled or skipped — surface the cancellation cleanly.
      target.searchParams.set('installed', '0');
      res.redirect(302, target.toString());
      return;
    }

    const installationId = Number(installationIdRaw);
    if (!Number.isFinite(installationId) || installationId <= 0) {
      target.searchParams.set('installed', '0');
      target.searchParams.set('error', 'bad_installation_id');
      res.redirect(302, target.toString());
      return;
    }

    // Best-effort: did the webhook arrive yet? If yes we can include the
    // account login in the redirect. If not, the page will poll for it.
    const row = await this.prisma.githubInstallation.findUnique({
      where: { installationId: BigInt(installationId) },
      select: { id: true, accountLogin: true },
    });

    target.searchParams.set('installed', '1');
    target.searchParams.set('installation_id', String(installationId));
    if (row?.accountLogin) {
      target.searchParams.set('account', row.accountLogin);
    }
    this.logger.log(
      `GitHub install completed: installationId=${installationId} ` +
      `account=${row?.accountLogin ?? '(pending webhook)'} initiator=${storedUserId}`,
    );
    res.redirect(302, target.toString());
  }

  /**
   * List installations known to the workspace. The integrations page polls
   * this after a successful redirect to confirm the webhook row landed.
   */
  @Get('installations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List GitHub installations connected to this workspace' })
  async listInstallations(): Promise<
    Array<{
      id: string;
      installationId: string;
      accountLogin: string;
      accountType: string;
      suspendedAt: string | null;
      reposCount: number;
    }>
  > {
    const rows = await this.prisma.githubInstallation.findMany({
      include: { _count: { select: { repos: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      installationId: String(r.installationId),
      accountLogin: r.accountLogin,
      accountType: r.accountType,
      suspendedAt: r.suspendedAt ? r.suspendedAt.toISOString() : null,
      reposCount: r._count.repos,
    }));
  }
}
