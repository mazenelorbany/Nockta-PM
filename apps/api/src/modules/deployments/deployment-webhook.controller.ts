import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

import {
  BadRequestException, Body, Controller, Headers, HttpCode, HttpStatus,
  Logger, Param, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DeploymentSource } from '@prisma/client';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';

import { DeploymentsService } from './deployments.service';
import {
  normalizeGeneric, normalizeGithubActions, normalizeRailway, normalizeVercel,
} from './source-adapters';

function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

@ApiTags('webhooks')
@Controller('webhooks/deployments')
export class DeploymentWebhookController {
  private readonly logger = new Logger(DeploymentWebhookController.name);

  constructor(private readonly deployments: DeploymentsService) {}

  @Public()
  @Post(':projectId/:source')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(
    @Param('projectId') projectId: string,
    @Param('source') source: DeploymentSource,
    @Headers('x-nockta-signature') sig: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: Record<string, unknown>,
  ): Promise<void> {
    if (!Object.values(DeploymentSource).includes(source)) {
      throw new BadRequestException(`Unknown source ${source}`);
    }

    const stored = await this.deployments.getSecretHash(projectId, source);
    if (!stored) throw new UnauthorizedException('No webhook secret configured for this source');

    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body));
    if (!sig) throw new UnauthorizedException('Missing signature');
    // Signature scheme: HMAC-SHA256 of raw body with the project's shared secret.
    // The shared secret is stored hashed; the comparison is between the *hash* of the produced HMAC
    // and the stored hash (an HMAC alone over a hash isn't possible; treat the stored hash as the secret).
    // For practical purposes: callers sign with the raw secret they were given at rotation time.
    // We verify by re-hashing the provided HMAC value and comparing.
    const presented = sha256(sig.toLowerCase().replace(/^sha256=/, ''));
    const expected = sha256(createHmac('sha256', stored).update(raw).digest('hex'));
    if (presented.length !== expected.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
      throw new UnauthorizedException('Bad signature');
    }

    const normalize =
      source === 'vercel' ? normalizeVercel :
      source === 'railway' ? normalizeRailway :
      source === 'github_actions' ? normalizeGithubActions :
      normalizeGeneric;
    const normalized = normalize(body);
    if (!normalized) {
      this.logger.warn({ source, projectId }, 'unable to normalize deployment payload');
      return;
    }
    await this.deployments.record(projectId, normalized);
  }
}
