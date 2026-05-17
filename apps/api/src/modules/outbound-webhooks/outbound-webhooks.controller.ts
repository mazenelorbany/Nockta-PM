import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { WorkspaceContextService } from '../workspace/workspace-context.service';
import {
  OutboundWebhooksService,
  type WebhookInput,
} from './outbound-webhooks.service';

// =============================================================================
// /outbound-webhooks
//
// Workspace-level webhook subscriptions. The workspace is derived from the
// authenticated user's JWT (via WorkspaceContextService) rather than being
// supplied as a URL path parameter. This is the multi-tenant boundary:
// User A in workspace W1 simply cannot construct a URL that addresses
// workspace W2 — the API never trusts a client-supplied workspaceId.
//
// Authorisation: internal users only; Admins for writes, Members for reads.
// (Enforced inside the service via assertWorkspaceAccess.)
// =============================================================================

class CreateWebhookDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @MinLength(1) @MaxLength(2048) url!: string;
  @IsString() @MinLength(16) @MaxLength(256) secret!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) eventTypes!: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateWebhookDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2048) url?: string;
  @IsOptional() @IsString() @MinLength(16) @MaxLength(256) secret?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) eventTypes?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@ApiTags('outbound-webhooks')
@ApiBearerAuth()
@Controller('outbound-webhooks')
export class OutboundWebhooksController {
  constructor(
    private readonly svc: OutboundWebhooksService,
    private readonly workspaceCtx: WorkspaceContextService,
  ) {}

  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.list(actor, wsId);
  }

  @Post()
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateWebhookDto,
  ) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.create(actor, wsId, dto as WebhookInput);
  }

  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.get(actor, wsId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.update(actor, wsId, id, dto as Partial<WebhookInput>);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.remove(actor, wsId, id);
  }

  @Post(':id/test')
  async test(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.testFire(actor, wsId, id);
  }

  @Post(':id/redeliver/:deliveryId')
  async redeliver(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
  ) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.redeliver(actor, wsId, id, deliveryId);
  }

  @Get(':id/deliveries')
  async deliveries(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    // Prefer the workspaceId baked into the JWT (Round 6 Pass A); fall
    // back to a fresh lookup for legacy tokens that predate the claim.
    const wsId = actor.workspaceId ?? (await this.workspaceCtx.resolveForUser(actor.id));
    return this.svc.listDeliveries(actor, wsId, id);
  }
}
