import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param,
  ParseUUIDPipe, Patch, Post, Put, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayUnique, IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min,
} from 'class-validator';
import { CompanyRole, UserKind } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

import { UsersService } from './users.service';

class ChangeRoleDto {
  // Accept either `role` or the older `companyRole` body shape so older
  // clients keep working while we migrate the web app.
  @IsOptional() @IsEnum(CompanyRole) role?: CompanyRole;
  @IsOptional() @IsEnum(CompanyRole) companyRole?: CompanyRole;
}

class ChangeKindDto {
  @IsEnum(UserKind) kind!: UserKind;
}

class SetTeamsDto {
  @IsUUID('all', { each: true })
  @ArrayUnique()
  teamIds!: string[];
}

class InviteGuestDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() email?: string;
}

class UpdateMyPreferencesDto {
  /**
   * Weekly worklog target in hours. Set to `null` (or pass an explicit body
   * field `weeklyHoursTarget: null`) to clear the target. The service enforces
   * 1..168. Optional in the DTO so a future preferences key can land without
   * forcing every client to send the target.
   */
  @IsOptional() @IsInt() @Min(1) @Max(168) weeklyHoursTarget?: number | null;
  /**
   * Pomodoro mode opt-in (Pass 5 R4-deferred B). The state machine lives on
   * the client (`usePomodoro.ts`); the API only persists the toggle so it
   * survives a fresh login or a different browser session.
   */
  @IsOptional() @IsBoolean() pomodoroEnabled?: boolean;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('kind') kind?: string,
    @Query('archived') archived?: string,
    @Query('q') q?: string,
  ) {
    if (kind && kind !== 'internal' && kind !== 'client' && kind !== 'all') {
      throw new BadRequestException(`Invalid kind: ${kind}`);
    }
    return this.users.listInternal({
      cursor,
      ...(limit ? { limit: Number(limit) } : {}),
      ...(kind ? { kind: kind as 'internal' | 'client' | 'all' } : {}),
      ...(archived === 'true' ? { archived: true } : {}),
      ...(q ? { q } : {}),
    });
  }

  /**
   * Read the authenticated user's preferences. Currently scoped to time-tracking
   * (`weeklyHoursTarget`); add new keys here as they ship. Kept above the
   * generic `:id` route so the literal `me` segment doesn't get UUID-parsed.
   */
  @Get('me/preferences')
  getMyPreferences(@CurrentUser() actor: AuthenticatedUser) {
    return this.users.getMyPreferences(actor);
  }

  /**
   * Patch the authenticated user's preferences. `null` clears a field; an
   * absent key leaves the existing value alone. Mirrors the shape of the
   * GET so the web can pass the result back unchanged.
   */
  @Patch('me/preferences')
  updateMyPreferences(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateMyPreferencesDto,
  ) {
    return this.users.updateMyPreferences(actor, {
      ...(dto.weeklyHoursTarget !== undefined
        ? { weeklyHoursTarget: dto.weeklyHoursTarget }
        : {}),
      ...(dto.pomodoroEnabled !== undefined
        ? { pomodoroEnabled: dto.pomodoroEnabled }
        : {}),
    });
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.getById(id);
  }

  /**
   * Admin-only: create a guest (client) user up-front and email them a
   * magic-link to sign in. Pre-creating the User row lets the Admin grant
   * project access to the guest before they ever sign in for the first time.
   */
  @Post('invite-guest')
  @ApiOperation({ summary: 'Invite an external client / guest by email (Admin only)' })
  inviteGuest(@CurrentUser() actor: AuthenticatedUser, @Body() dto: InviteGuestDto) {
    return this.users.inviteGuest(actor, {
      email: dto.email,
      ...(dto.name ? { name: dto.name } : {}),
    });
  }

  /**
   * Pending project invitations across the workspace — outstanding
   * `project_invite` magic links that haven't been used or expired yet.
   * Powers the Members → Pending Invitations panel.
   */
  @Get('pending-invites')
  @ApiOperation({ summary: 'List pending project invitations (Admin only)' })
  listPendingInvites(@CurrentUser() actor: AuthenticatedUser) {
    return this.users.listPendingInvites(actor);
  }

  @Post('pending-invites/:linkId/resend')
  @ApiOperation({ summary: 'Re-send a pending project invitation (Admin only)' })
  resendPendingInvite(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('linkId', new ParseUUIDPipe()) linkId: string,
  ) {
    return this.users.resendPendingInvite(actor, linkId);
  }

  @Delete('pending-invites/:linkId')
  @ApiOperation({ summary: 'Revoke a pending project invitation (Admin only)' })
  revokePendingInvite(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('linkId', new ParseUUIDPipe()) linkId: string,
  ) {
    return this.users.revokePendingInvite(actor, linkId);
  }

  @Patch(':id/role')
  changeRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    const role = dto.role ?? dto.companyRole;
    if (!role) {
      throw new BadRequestException('role (or companyRole) is required');
    }
    return this.users.changeRole(actor, id, role);
  }

  /**
   * Admin-only: flip a user between internal (member/admin) and client (guest).
   *
   * Demote (internal → client) clears the user's companyRole and wipes their
   * team memberships, because clients can't belong to Teams. Promote
   * (client → internal) sets companyRole to Member by default.
   */
  @Patch(':id/kind')
  @ApiOperation({ summary: 'Convert a user to/from Guest (kind=client) (Admin only)' })
  changeKind(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ChangeKindDto,
  ) {
    return this.users.changeKind(actor, id, dto.kind);
  }

  /**
   * Admin-only: edit display name and/or email. Handy for replacing the
   * placeholder `@jira-imported.local` email Jira-imported users carry.
   */
  @Patch(':id')
  @ApiOperation({ summary: "Update a user's name and/or email (Admin only)" })
  updateProfile(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.users.updateProfile(actor, id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
    });
  }

  @Put(':id/teams')
  setTeams(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetTeamsDto,
  ) {
    return this.users.setTeams(actor, id, dto.teamIds);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  archive(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.archive(actor, id);
  }

  @Post(':id/unarchive')
  unarchive(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.unarchive(actor, id);
  }
}
