import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { buildCardForNotification } from './card-builders';
import { ChatService } from './chat.service';

/**
 * Consumes `chat.dispatch_required` events emitted by the notifications worker
 * and delivers a Google Chat card to the recipient's bound DM space.
 *
 * Also handles per-project Chat-space broadcasts for specific event types.
 */
@Injectable()
export class ChatDispatcherService implements OnModuleInit {
  private readonly logger = new Logger(ChatDispatcherService.name);

  private static readonly SPACE_BROADCAST_TYPES = new Set([
    'sprint.started',
    'sprint.completed',
    'deploy.succeeded',
    'deploy.failed',
    'deploy.rolled_back',
    'deploy.production_release',
    'client.reported_bug',
  ]);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  onModuleInit(): void {
    this.emitter.on('chat.dispatch_required', (payload) => {
      void this.deliverDM(payload as Parameters<typeof buildCardForNotification>[0]);
    });
    this.emitter.onAny((event, payload) => {
      const name = Array.isArray(event) ? event.join('.') : (event as string);
      if (!ChatDispatcherService.SPACE_BROADCAST_TYPES.has(name)) return;
      void this.broadcastToProjectSpace(name, payload as Record<string, unknown>);
    });
  }

  private async deliverDM(payload: Parameters<typeof buildCardForNotification>[0]): Promise<void> {
    const binding = await this.prisma.chatBinding.findUnique({
      where: { userId: payload.recipientUserId },
    });
    if (!binding) return;
    const card = buildCardForNotification(payload);
    try {
      await this.chat.sendCard(binding.googleChatSpaceId, card);
    } catch (err) {
      this.logger.warn({ err, userId: payload.recipientUserId }, 'Chat DM delivery failed — clearing stale binding if needed');
      // If the space is gone (404), clear the binding.
      const message = String((err as Error)?.message ?? '');
      if (/Not Found|404/.test(message)) {
        await this.prisma.chatBinding.delete({ where: { userId: payload.recipientUserId } }).catch(() => undefined);
      }
    }
  }

  private async broadcastToProjectSpace(eventName: string, payload: Record<string, unknown>): Promise<void> {
    const projectId = payload['projectId'] as string | undefined;
    if (!projectId) return;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { chatSpaceId: true, chatBroadcastEvents: true },
    });
    if (!project?.chatSpaceId) return;
    if (!project.chatBroadcastEvents.includes(eventName)) return;

    const card = buildCardForNotification({
      recipientUserId: 'broadcast',
      type: this.mapEventNameToType(eventName),
      payload,
      taskId: (payload['taskId'] as string | undefined) ?? null,
      projectId,
    });
    try {
      await this.chat.sendCard(project.chatSpaceId, card);
    } catch (err) {
      this.logger.warn({ err, projectId }, 'Chat space broadcast failed');
    }
  }

  private mapEventNameToType(eventName: string): string {
    const map: Record<string, string> = {
      'sprint.started': 'SprintStarted',
      'sprint.completed': 'SprintCompleted',
      'deploy.succeeded': 'DeploymentSucceeded',
      'deploy.failed': 'DeploymentFailed',
      'deploy.rolled_back': 'DeploymentFailed',
      'deploy.production_release': 'DeploymentSucceeded',
      'client.reported_bug': 'ClientReportedBug',
    };
    return map[eventName] ?? eventName;
  }
}
