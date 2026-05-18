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

import type {
  OutboundWebhooksService} from './outbound-webhooks.service';
import {
  type WebhookInput,
} from './outbound-webhooks.service';

// =============================================================================
// /outbound-webhooks
//
// Authorisation: internal users only; Admins for writes, Members for reads.
// (Enforced inside the service via assertAccess.)
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
  ) {}

  @Get()
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.svc.list(actor);
  }

  @Post()
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.svc.create(actor, dto as WebhookInput);
  }

  @Get(':id')
  async get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.get(actor, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.svc.update(actor, id, dto as Partial<WebhookInput>);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.remove(actor, id);
  }

  @Post(':id/test')
  async test(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.testFire(actor, id);
  }

  @Post(':id/redeliver/:deliveryId')
  async redeliver(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('deliveryId', new ParseUUIDPipe()) deliveryId: string,
  ) {
    return this.svc.redeliver(actor, id, deliveryId);
  }

  @Get(':id/deliveries')
  async deliveries(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.listDeliveries(actor, id);
  }
}
