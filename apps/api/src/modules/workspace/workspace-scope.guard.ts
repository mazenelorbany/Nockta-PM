import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/types';
import { WorkspaceService } from './workspace.service';
import { DEFAULT_WORKSPACE_ID, WorkspaceContextService } from './workspace-context.service';

// =============================================================================
// WorkspaceScopeGuard
//
// Defence-in-depth wrapper for workspace-scoped routes. Runs AFTER
// JwtAuthGuard (so req.user is populated) and resolves the workspaceId
// from one of three sources, in order:
//
//   1. `req.params.workspaceId` — route is `/workspaces/:workspaceId/...`.
//   2. `X-Nockta-Workspace` header — explicit override for cross-workspace
//      tools (admin UI, integrations).
//   3. `req.user.workspaceId` — derived from the JWT, set in the Pass A
//      auth payload extension. (Falls back to WorkspaceContextService for
//      legacy tokens missing the workspaceId claim.)
//
// After resolution the guard calls WorkspaceService.assertMember which
// throws ForbiddenException for non-members. On success the guard attaches
// the membership row to `req.workspace` so handlers can read it via the
// @CurrentWorkspace() decorator without re-querying.
//
// This guard is OPT-IN: routes that need it apply it via `@UseGuards(
// JwtAuthGuard, WorkspaceScopeGuard)`. The bulk of the API still funnels
// through WorkspaceContextService directly (legacy single-tenant shape);
// this guard is the new pattern for cross-tenant-sensitive endpoints.
// =============================================================================

export interface ResolvedWorkspace {
  id: string;
  role: 'Owner' | 'Admin' | 'Member';
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser & { workspaceId?: string };
  workspace?: ResolvedWorkspace;
}

@Injectable()
export class WorkspaceScopeGuard implements CanActivate {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly workspaceCtx: WorkspaceContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = req.user;
    if (!actor) {
      // Caller forgot to apply JwtAuthGuard first; refuse loudly rather
      // than letting the request through unauthenticated.
      throw new UnauthorizedException('WorkspaceScopeGuard requires authentication');
    }

    const workspaceId = await this.resolveWorkspaceId(req, actor);
    if (!workspaceId) {
      throw new ForbiddenException('Workspace context could not be resolved');
    }

    const membership = await this.workspaces.assertMember(workspaceId, actor);
    req.workspace = { id: membership.workspaceId, role: membership.role };
    return true;
  }

  /** Resolve the workspaceId per the precedence rules in the header
   *  doc-comment. Separated so unit tests can drive it directly. */
  private async resolveWorkspaceId(
    req: AuthenticatedRequest,
    actor: AuthenticatedUser & { workspaceId?: string },
  ): Promise<string | null> {
    const paramId = (req.params as Record<string, string> | undefined)?.['workspaceId'];
    if (paramId) return paramId;

    const headerVal = req.headers['x-nockta-workspace'];
    const headerId = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (typeof headerId === 'string' && headerId.length > 0) return headerId;

    if (actor.workspaceId) return actor.workspaceId;

    // Last-resort lookup — JWT predates the workspaceId claim. Hits the
    // cached WorkspaceContextService rather than re-querying directly.
    try {
      return await this.workspaceCtx.resolveForUser(actor.id);
    } catch {
      return DEFAULT_WORKSPACE_ID;
    }
  }
}
