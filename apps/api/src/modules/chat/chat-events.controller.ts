import {
  BadRequestException, Body, Controller, Headers, Logger, Post, UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OAuth2Client } from 'google-auth-library';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { CommentsService } from '../comments/comments.service';
import { TasksService } from '../tasks/tasks.service';
import { ChatEventsService } from './chat-events.service';
import { ChatService } from './chat.service';

const googleClient = new OAuth2Client();

interface ChatEventPayload {
  type: 'MESSAGE' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'CARD_CLICKED';
  space: { name: string; type?: 'ROOM' | 'DM' };
  user: { name: string; displayName: string; email?: string };
  message?: {
    text?: string;
    annotations?: Array<{
      type?: string;
      userMention?: { user?: { name?: string; displayName?: string; type?: string } };
    }>;
  };
  action?: { actionMethodName: string; parameters: { key: string; value: string }[] };
}

@ApiTags('webhooks')
@Controller('webhooks/chat')
export class ChatEventsController {
  private readonly logger = new Logger(ChatEventsController.name);

  constructor(
    private readonly chat: ChatService,
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly comments: CommentsService,
    private readonly events: EventEmitter2,
    private readonly slash: ChatEventsService,
  ) {}

  @Public()
  @Post()
  async receive(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: ChatEventPayload,
  ): Promise<unknown> {
    await this.verifyBearer(authHeader);
    switch (body.type) {
      case 'ADDED_TO_SPACE':
        return this.handleBindingHandshake(body);
      case 'MESSAGE': {
        // Try the slash-command path first; if the message wasn't a slash
        // command the service returns null and we fall through to the
        // legacy binding-handshake reply.
        const slashReply = await this.slash.handle({
          user: body.user,
          message: body.message ?? {},
        });
        if (slashReply) return slashReply;
        return this.handleBindingHandshake(body);
      }
      case 'CARD_CLICKED':
        return this.handleCardAction(body);
      case 'REMOVED_FROM_SPACE':
        return this.handleRemoved(body);
      default:
        return {};
    }
  }

  private async verifyBearer(authHeader: string | undefined): Promise<void> {
    if (!Env.GOOGLE_CHAT_INTERACTION_TOKEN_AUDIENCE) {
      // No audience configured — refuse to accept callbacks until configured.
      throw new UnauthorizedException('Chat interactions audience not configured');
    }
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedException();
    const token = authHeader.slice('Bearer '.length);
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: Env.GOOGLE_CHAT_INTERACTION_TOKEN_AUDIENCE,
      });
      const payload = ticket.getPayload();
      if (payload?.iss !== 'chat@system.gserviceaccount.com') {
        throw new UnauthorizedException('Bad issuer');
      }
    } catch {
      throw new UnauthorizedException('Invalid Chat token');
    }
  }

  /** Binding: any message to the bot links the sender's @nockta.com email to their Nockta user. */
  private async handleBindingHandshake(body: ChatEventPayload): Promise<unknown> {
    const email = body.user.email ?? (await this.chat.lookupUser(body.user.name)).email;
    if (!email) {
      return this.textReply("I couldn't read your Google account email. Make sure you're signed in to Google Chat with your @nockta.com account.");
    }
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.kind !== 'internal') {
      return this.textReply(`No internal Nockta Flow user found for ${email}.`);
    }
    await this.prisma.chatBinding.upsert({
      where: { userId: user.id },
      update: {
        googleChatUserId: body.user.name,
        googleChatSpaceId: body.space.name,
        lastSeenAt: new Date(),
      },
      create: {
        userId: user.id,
        googleChatUserId: body.user.name,
        googleChatSpaceId: body.space.name,
      },
    });
    this.events.emit('chat.bound', { userId: user.id });
    return this.textReply(`✅ You're connected, ${user.name}. You'll receive task notifications here.`);
  }

  private async handleRemoved(body: ChatEventPayload): Promise<unknown> {
    await this.prisma.chatBinding.deleteMany({
      where: { googleChatUserId: body.user.name },
    });
    this.events.emit('chat.unbound', { googleChatUserId: body.user.name });
    return {};
  }

  /** Process a button click on a Card v2 message. */
  private async handleCardAction(body: ChatEventPayload): Promise<unknown> {
    const action = body.action;
    if (!action) throw new BadRequestException('No action in CARD_CLICKED');
    const params = Object.fromEntries(action.parameters.map((p) => [p.key, p.value]));

    const binding = await this.prisma.chatBinding.findFirst({
      where: { googleChatUserId: body.user.name },
      include: { user: true },
    });
    if (!binding) {
      return this.textReply("You're not connected to Nockta Flow. Send any message to the bot first.");
    }
    const actor = {
      id: binding.userId,
      email: binding.user.email,
      kind: binding.user.kind,
      companyRole: binding.user.companyRole,
      jti: 'chat-action', // synthetic JTI; not used for revocation
    };

    try {
      switch (action.actionMethodName) {
        case 'task.accept':
        case 'task.self_assign':
          await this.tasks.update(actor, params['taskId']!, { assigneeUserId: actor.id });
          return this.textReply('✅ Assigned to you.');
        case 'task.mark_done':
          await this.tasks.changeStatus(actor, params['taskId']!, 'Done', 'user');
          return this.textReply('✅ Marked Done.');
        case 'task.unblock':
          await this.tasks.setBlocked(actor, params['taskId']!, false);
          return this.textReply('✅ Unblocked.');
        case 'task.acknowledge':
          // Acknowledge = move to In Progress
          await this.tasks.changeStatus(actor, params['taskId']!, 'In Progress', 'user');
          return this.textReply('✅ Acknowledged. Status set to In Progress.');
        case 'task.reassign_dialog':
          return this.openReassignDialog(params['taskId']!);
        case 'task.reassign_submit':
          await this.tasks.update(actor, params['taskId']!, {
            assigneeUserId: params['assigneeUserId'] || null,
          });
          return this.closeDialogWithText('✅ Reassigned.');
        case 'task.reply_dialog':
          return this.openReplyDialog(params['taskId']!);
        case 'task.reply_submit':
          await this.comments.create(
            actor,
            params['taskId']!,
            params['body'] ?? '',
          );
          return this.closeDialogWithText('✅ Reply posted.');
        default:
          return this.textReply(`Unknown action: ${action.actionMethodName}`);
      }
    } catch (err) {
      const message = (err as { message?: string }).message ?? 'Action failed';
      return this.textReply(`❌ ${message}`);
    }
  }

  // ---------------- Dialog builders ----------------

  private async openReassignDialog(taskId: string): Promise<unknown> {
    // Build a dropdown of internal teammates (excluding archived). Capped to
    // 100 — beyond that the user should use the web app's full picker.
    const users = await this.prisma.user.findMany({
      where: { kind: 'internal', archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
      take: 100,
    });

    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          dialog: {
            body: {
              sections: [
                {
                  widgets: [
                    {
                      selectionInput: {
                        name: 'assigneeUserId',
                        label: 'Assignee',
                        type: 'DROPDOWN',
                        items: [
                          { text: '— Unassigned —', value: '' },
                          ...users.map((u) => ({ text: `${u.name} (${u.email})`, value: u.id })),
                        ],
                      },
                    },
                    {
                      buttonList: {
                        buttons: [
                          {
                            text: 'Reassign',
                            onClick: {
                              action: {
                                function: 'task.reassign_submit',
                                parameters: [{ key: 'taskId', value: taskId }],
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };
  }

  private openReplyDialog(taskId: string): unknown {
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          dialog: {
            body: {
              sections: [
                {
                  widgets: [
                    {
                      textInput: {
                        name: 'body',
                        label: 'Reply',
                        type: 'MULTIPLE_LINE',
                        hintText: 'Markdown supported. Mentions and #TASK-KEYs autolink.',
                      },
                    },
                    {
                      buttonList: {
                        buttons: [
                          {
                            text: 'Post reply',
                            onClick: {
                              action: {
                                function: 'task.reply_submit',
                                parameters: [{ key: 'taskId', value: taskId }],
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };
  }

  private closeDialogWithText(text: string): unknown {
    // Closes the open dialog and posts a confirmation back to the user.
    return {
      actionResponse: {
        type: 'DIALOG',
        dialogAction: {
          actionStatus: { statusCode: 'OK', userFacingMessage: text },
        },
      },
    };
  }

  private textReply(text: string): { text: string } {
    return { text };
  }
}
