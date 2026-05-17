import { Controller, Delete, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat/binding')
export class ChatBindingController {
  constructor(private readonly prisma: PrismaService, private readonly events: EventEmitter2) {}

  /** Returns the user's binding state and the deep-link they should click to start one. */
  @Get()
  async get(@CurrentUser() actor: AuthenticatedUser) {
    const binding = await this.prisma.chatBinding.findUnique({ where: { userId: actor.id } });
    const deepLink = Env.GOOGLE_CHAT_APP_ID
      ? `https://chat.google.com/u/0/?app=${Env.GOOGLE_CHAT_APP_ID}`
      : null;
    return {
      bound: Boolean(binding),
      connectedAt: binding?.connectedAt ?? null,
      lastSeenAt: binding?.lastSeenAt ?? null,
      instructions:
        'Click the link below to open Google Chat with @NocktaFlow selected, then send any message to complete the connection.',
      deepLink,
    };
  }

  @Delete()
  async disconnect(@CurrentUser() actor: AuthenticatedUser): Promise<void> {
    await this.prisma.chatBinding.deleteMany({ where: { userId: actor.id } });
    this.events.emit('chat.unbound', { userId: actor.id });
  }
}
