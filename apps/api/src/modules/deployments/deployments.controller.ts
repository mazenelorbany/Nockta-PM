import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { DeploymentSource } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { DeploymentsService } from './deployments.service';

@ApiTags('deployments')
@ApiBearerAuth()
@Controller()
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @Get('projects/:projectId/deployments')
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.deployments.listForProject(actor, projectId, limit ?? 30);
  }

  @Get('deployments/:id')
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.deployments.get(actor, id);
  }

  @Post('projects/:projectId/deployments/secrets/:source')
  rotateSecret(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Param('source') source: DeploymentSource,
  ) {
    return this.deployments.rotateSecret(actor, projectId, source);
  }
}
