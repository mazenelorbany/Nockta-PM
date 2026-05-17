import { Controller, ForbiddenException, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { ClientService } from './client.service';

// =============================================================================
// /client/* — endpoints that power the client portal dashboard. Mounted under
// a dedicated controller so the URL space is obvious from the route ("this is
// portal-only data") and so internal users never accidentally call it.
// =============================================================================

@ApiTags('client')
@ApiBearerAuth()
@Controller('client')
export class ClientController {
  constructor(private readonly client: ClientService) {}

  /**
   * Recent activity feed for the home dashboard. Mixes three event sources:
   *   - team comments on tasks the client can see
   *   - status changes on tasks they reported
   *   - deployments on their projects
   * Result is filtered for guest visibility (no internal events) and sorted
   * by recency, capped at `limit` items.
   */
  @Get('activity')
  activity(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    this.assertClient(actor);
    return this.client.activity(actor, { limit: Math.min(50, Math.max(1, limit ?? 10)) });
  }

  /**
   * Open bugs the client filed: tasks where `reportedByClient=true` and the
   * status is not Done/Approved, scoped to projects they have access to.
   */
  @Get('my-bugs')
  myBugs(@CurrentUser() actor: AuthenticatedUser) {
    this.assertClient(actor);
    return this.client.myBugs(actor);
  }

  /**
   * Guard rail — these endpoints exist exclusively for the guest portal.
   * Internal users have richer equivalents elsewhere (activity timeline,
   * task lists), so returning their data here would just be redundant.
   */
  private assertClient(actor: AuthenticatedUser): void {
    if (actor.kind !== 'client') {
      throw new ForbiddenException('Client portal endpoints are guest-only');
    }
  }
}
