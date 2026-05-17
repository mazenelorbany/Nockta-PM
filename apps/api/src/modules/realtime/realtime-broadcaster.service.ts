import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Listens on the in-process event bus and broadcasts to the relevant Socket.IO rooms.
 * Same source of truth as the events table writer — both are fed by EventEmitter2.
 */
@Injectable()
export class RealtimeBroadcasterService implements OnModuleInit {
  private readonly logger = new Logger(RealtimeBroadcasterService.name);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly gateway: RealtimeGateway,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.emitter.onAny((event, payload) => {
      const name = Array.isArray(event) ? event.join('.') : (event as string);
      void this.handle(name, payload as Record<string, unknown>);
    });
  }

  private async handle(eventName: string, payload: Record<string, unknown>): Promise<void> {
    try {
      switch (eventName) {
        case 'task.created': {
          const projectId = payload['projectId'] as string | undefined;
          if (projectId) this.gateway.server.to(`project:${projectId}`).emit('task.created', payload);
          break;
        }
        case 'task.updated':
        case 'task.status_changed':
        case 'task.blocked':
        case 'task.unblocked':
        case 'task.deleted': {
          const taskId = payload['taskId'] as string | undefined;
          if (!taskId) break;
          let projectId = payload['projectId'] as string | undefined;
          if (!projectId) {
            const task = await this.prisma.task.findUnique({
              where: { id: taskId },
              select: { projectId: true },
            });
            projectId = task?.projectId;
          }
          if (projectId) this.gateway.server.to(`project:${projectId}`).emit(eventName, payload);
          this.gateway.server.to(`task:${taskId}`).emit(eventName, payload);
          break;
        }
        case 'comment.added':
        case 'comment.edited':
        case 'comment.deleted': {
          const taskId = payload['taskId'] as string | undefined;
          if (taskId) this.gateway.server.to(`task:${taskId}`).emit(eventName, payload);
          break;
        }
        case 'sprint.created':
        case 'sprint.started':
        case 'sprint.completed':
        case 'sprint.deleted': {
          const projectId = payload['projectId'] as string | undefined;
          if (projectId) this.gateway.server.to(`project:${projectId}`).emit(eventName, payload);
          break;
        }
        case 'notification.created': {
          const recipientUserId = payload['recipientUserId'] as string | undefined;
          if (recipientUserId) {
            this.gateway.server.to(`user:${recipientUserId}`).emit('notification.created', payload);
          }
          break;
        }
        case 'deploy.succeeded':
        case 'deploy.failed':
        case 'deploy.started':
        case 'deploy.rolled_back':
        case 'deploy.production_release': {
          const projectId = payload['projectId'] as string | undefined;
          if (projectId) this.gateway.server.to(`project:${projectId}`).emit(eventName, payload);
          break;
        }
        default:
          // Many events have no realtime side (auth, GitHub install lifecycle, etc.) — ignore.
          break;
      }
    } catch (err) {
      this.logger.error({ err, eventName }, 'realtime broadcast failed');
    }
  }
}
