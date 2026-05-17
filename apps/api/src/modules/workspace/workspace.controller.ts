import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types';
import {
  WORKSPACE_ROLES,
  type WorkspaceRole,
  WorkspaceService,
} from './workspace.service';

// =============================================================================
// /workspace — current workspace + membership management.
//
// Path shape:
//   GET    /workspace/current          — what's my current workspace + role
//   GET    /workspace/members          — list members of my current workspace
//   POST   /workspace/members          — add a member (Admin/Owner)
//   PATCH  /workspace/members/:userId  — change a member's role
//   DELETE /workspace/members/:userId  — remove a member
//
// The workspaceId is derived server-side from the actor (via
// WorkspaceService.getCurrent) rather than being a path/query parameter.
// This keeps the legacy single-tenant client unchanged — there's nothing
// new for it to send — and forecloses the "client picks the workspaceId"
// attack vector.
// =============================================================================

class AddMemberDto {
  @IsUUID('all') userId!: string;
  @IsString() @IsIn([...WORKSPACE_ROLES]) role!: WorkspaceRole;
}

class UpdateRoleDto {
  @IsString() @IsIn([...WORKSPACE_ROLES]) role!: WorkspaceRole;
}

@ApiTags('workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly workspaces: WorkspaceService) {}

  @Get('current')
  @ApiOperation({
    summary: 'Return the authenticated user\'s current workspace + their role.',
  })
  async current(@CurrentUser() actor: AuthenticatedUser) {
    return this.workspaces.getCurrent(actor);
  }

  @Get('members')
  @ApiOperation({ summary: 'List members of the authenticated user\'s workspace.' })
  async listMembers(@CurrentUser() actor: AuthenticatedUser) {
    const ws = await this.workspaces.getCurrent(actor);
    return this.workspaces.listMembers(ws.id, actor);
  }

  @Post('members')
  @ApiOperation({ summary: 'Add a member to the workspace (Admin/Owner only).' })
  async addMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: AddMemberDto,
  ) {
    const ws = await this.workspaces.getCurrent(actor);
    return this.workspaces.addMember(ws.id, actor, {
      userId: dto.userId,
      role: dto.role,
    });
  }

  @Patch('members/:userId')
  @ApiOperation({ summary: 'Change a member\'s role (Admin/Owner only).' })
  async updateRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: UpdateRoleDto,
  ) {
    const ws = await this.workspaces.getCurrent(actor);
    return this.workspaces.updateRole(ws.id, actor, {
      userId,
      role: dto.role,
    });
  }

  @Delete('members/:userId')
  @ApiOperation({ summary: 'Remove a member from the workspace (Admin/Owner only).' })
  async removeMember(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
  ) {
    const ws = await this.workspaces.getCurrent(actor);
    return this.workspaces.removeMember(ws.id, actor, userId);
  }
}
