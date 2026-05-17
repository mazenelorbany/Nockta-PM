import { Global, Module } from '@nestjs/common';
import { WorkspaceContextService } from './workspace-context.service';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceScopeGuard } from './workspace-scope.guard';
import { WorkspaceService } from './workspace.service';

// =============================================================================
// WorkspaceModule
//
// Multi-tenant boundary. Hosts:
//   - WorkspaceContextService — read-mostly cache: userId -> workspaceId.
//   - WorkspaceService        — write surface: assertMember + members CRUD.
//   - WorkspaceScopeGuard     — opt-in guard that asserts the actor belongs
//                                to the workspace addressed by the request.
//
// Marked @Global so feature modules don't have to import this module to
// inject the services (and avoid a circular-import jungle with auth +
// users + prisma). All three providers are exported.
// =============================================================================

@Global()
@Module({
  controllers: [WorkspaceController],
  providers: [WorkspaceContextService, WorkspaceService, WorkspaceScopeGuard],
  exports: [WorkspaceContextService, WorkspaceService, WorkspaceScopeGuard],
})
export class WorkspaceModule {}
