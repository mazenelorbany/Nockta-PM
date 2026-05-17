import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';
import { WebPushService } from './web-push.service';

class SubscribeKeysDto {
  @IsString()
  p256dh!: string;

  @IsString()
  auth!: string;
}

class SubscribeDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => SubscribeKeysDto)
  keys!: SubscribeKeysDto;

  @IsOptional()
  @IsString()
  label?: string;
}

class UnsubscribeDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  endpoint!: string;
}

// =============================================================================
// /notifications/web-push — VAPID key handout + subscribe / unsubscribe.
//
// The /vapid-public-key endpoint requires auth (no anon enumeration of the
// workspace VAPID identity). The subscribe/unsubscribe handlers attribute
// the row to the calling user via the JWT — there is NO userId in the body.
// =============================================================================

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications/web-push')
export class WebPushController {
  constructor(private readonly webPush: WebPushService) {}

  @Get('vapid-public-key')
  vapidPublicKey(): { publicKey: string | null; configured: boolean } {
    return {
      publicKey: this.webPush.getPublicKey(),
      configured: this.webPush.isConfigured(),
    };
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.CREATED)
  async subscribe(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: SubscribeDto,
  ): Promise<{ id: string }> {
    return this.webPush.subscribe(actor.id, {
      endpoint: dto.endpoint,
      keys: { p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      ...(dto.label ? { label: dto.label } : {}),
    });
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UnsubscribeDto,
  ): Promise<void> {
    await this.webPush.unsubscribe(actor.id, dto.endpoint);
  }
}
