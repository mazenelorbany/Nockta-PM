import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean, IsIn, IsNumber, IsObject, IsOptional, Max, Min,
} from 'class-validator';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireCompanyRoles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/types';

import {
  WorkspaceAiSettingsService} from './workspace-ai-settings.service';
import {
  type ModelPreference,
  type PriorityWeights,
} from './workspace-ai-settings.service';

// =============================================================================
// /workspace/ai-settings — read open to authenticated users (the UI needs the
// values to render the AI settings tab); update gated to Admin via
// RequireCompanyRoles + the service-level guard (defence-in-depth).
// =============================================================================

class UpdateAiSettingsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1)
  dupThreshold?: number;

  @IsOptional() @IsObject()
  priorityWeights?: PriorityWeights;

  @IsOptional() @IsBoolean()
  autoSuggestEnabled?: boolean;

  @IsOptional() @IsIn(['auto', 'ollama', 'anthropic'])
  modelPreference?: ModelPreference;
}

@ApiTags('workspace-ai-settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('workspace/ai-settings')
export class WorkspaceAiSettingsController {
  constructor(private readonly settings: WorkspaceAiSettingsService) {}

  @Get()
  async get(@CurrentUser() actor: AuthenticatedUser) {
    // Authenticated read — every user can see the workspace knobs. The UI
    // gates the edit form on the user's companyRole locally; the service
    // guards the write path regardless.
    const row = await this.settings.get(actor.id);
    return row;
  }

  @Patch()
  @RequireCompanyRoles('Admin')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() patch: UpdateAiSettingsDto,
  ) {
    return this.settings.update(actor, patch);
  }
}
