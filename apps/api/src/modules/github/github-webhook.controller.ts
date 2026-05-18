import { createHmac, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus, Inject, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type Redis from 'ioredis';

import { Public } from '../auth/decorators/public.decorator';
import { Env } from '../../config/env';
import { REDIS_CLIENT } from '../redis/redis.module';

import type { GithubEventsService } from './github-events.service';

/** GitHub re-delivers webhooks for up to ~30 days after the initial fire on
 *  ping/network errors. 24h covers the realistic redelivery window plus a
 *  comfortable margin without holding ids in Redis for longer than the
 *  protocol needs. */
const DELIVERY_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

interface WebhookHeaders {
  'x-github-event'?: string;
  'x-github-delivery'?: string;
  'x-hub-signature-256'?: string;
}

@ApiTags('webhooks')
@Controller('webhooks/github')
export class GithubWebhookController {
  private readonly logger = new Logger(GithubWebhookController.name);

  constructor(
    private readonly events: GithubEventsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: WebhookHeaders,
    @Body() body: Record<string, unknown>,
  ): Promise<void> {
    if (!Env.GITHUB_APP_WEBHOOK_SECRET) {
      this.logger.warn('webhook received but no secret configured — rejecting');
      throw new UnauthorizedException('GitHub App not configured');
    }
    const signature = headers['x-hub-signature-256'];
    const event = headers['x-github-event'];
    if (!signature || !event) throw new BadRequestException('Missing GitHub headers');

    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const expected = 'sha256=' + createHmac('sha256', Env.GITHUB_APP_WEBHOOK_SECRET).update(raw).digest('hex');
    if (signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new UnauthorizedException('Bad signature');
    }

    // Replay protection. GitHub stamps every delivery with a unique
    // X-GitHub-Delivery id. We claim it in Redis SETNX-style; if the claim
    // fails the same id has been processed (or is being processed) within
    // the dedupe TTL and we no-op. Returning 204 (the default for this
    // route) keeps GitHub from retrying, and the dispatcher never runs
    // twice for the same delivery — which would otherwise create duplicate
    // task comments, double-fire auto-status transitions, etc.
    const deliveryId = headers['x-github-delivery'];
    if (deliveryId) {
      const claimed = await this.redis.set(
        `gh:delivery:${deliveryId}`,
        '1',
        'EX',
        DELIVERY_DEDUPE_TTL_SECONDS,
        'NX',
      );
      if (claimed !== 'OK') {
        this.logger.log({ deliveryId }, 'replay rejected — delivery already processed');
        return;
      }
    } else {
      // Missing delivery id is unusual but not impossible (test clients,
      // misconfigured proxies). Log and proceed — the signature check
      // already passed, so the request is authenticated; we just can't
      // dedupe it.
      this.logger.warn({ event }, 'webhook missing x-github-delivery — dedupe skipped');
    }

    await this.dispatch(event, body);
  }

  private async dispatch(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const installation = payload['installation'] as { id: number } | undefined;
    if (!installation) return;
    const installationRef = { installationId: installation.id };

    switch (eventType) {
      case 'installation': {
        const action = payload['action'] as string;
        const account = (payload['installation'] as { account?: { login: string; type: string } })?.account;
        const repositories = (payload['repositories'] as { id: number; full_name: string; name: string }[] | undefined) ?? [];
        if (action === 'created' && account) {
          await this.events.onInstallationCreated({
            installationId: installation.id,
            accountLogin: account.login,
            accountType: account.type,
            repositories: repositories.map((r) => ({
              owner: r.full_name.split('/')[0]!,
              name: r.name,
              fullName: r.full_name,
              githubRepoId: r.id,
            })),
          });
        } else if (action === 'suspend') {
          await this.events.onInstallationSuspended(installation.id);
        } else if (action === 'deleted') {
          await this.events.onInstallationDeleted(installation.id);
        }
        return;
      }

      case 'push': {
        const repository = payload['repository'] as { id: number; full_name: string; name: string; owner: { login: string } };
        const branch = ((payload['ref'] as string) ?? '').replace(/^refs\/heads\//, '');
        const commits = (payload['commits'] as { id: string; message: string; author: { name?: string; username?: string } }[] | undefined) ?? [];
        await this.events.onPush({
          installation: installationRef,
          repo: {
            githubRepoId: repository.id,
            fullName: repository.full_name,
            name: repository.name,
            owner: repository.owner.login,
          },
          branch,
          commits: commits.map((c) => ({
            sha: c.id,
            message: c.message,
            ...(c.author?.name ? { authorName: c.author.name } : {}),
            ...(c.author?.username ? { authorLogin: c.author.username } : {}),
          })),
        });
        return;
      }

      case 'pull_request': {
        const action = payload['action'] as 'opened' | 'reopened' | 'closed' | 'ready_for_review' | 'edited' | 'synchronize';
        const repository = payload['repository'] as { id: number; full_name: string; name: string; owner: { login: string } };
        const pr = payload['pull_request'] as {
          number: number;
          title: string;
          body: string | null;
          head: { ref: string };
          draft: boolean;
          merged: boolean;
          state: 'open' | 'closed';
          html_url: string;
          user: { login: string };
        };
        await this.events.onPullRequest({
          installation: installationRef,
          repo: {
            githubRepoId: repository.id,
            fullName: repository.full_name,
            name: repository.name,
            owner: repository.owner.login,
          },
          action,
          pr: {
            number: pr.number,
            title: pr.title,
            body: pr.body,
            branchName: pr.head.ref,
            draft: pr.draft,
            merged: pr.merged,
            state: pr.state,
            url: pr.html_url,
            authorLogin: pr.user.login,
          },
        });
        return;
      }

      default:
        // ping, check_*, deployment_status, etc. — ignored for now
        return;
    }
  }
}
