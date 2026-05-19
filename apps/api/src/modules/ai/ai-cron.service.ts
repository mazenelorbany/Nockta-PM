import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';

import { SchedulerLockService } from '../../common/scheduling/scheduler-lock.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';

import { LlmService } from './llm.service';
import { AI_BLOCKER_QUEUE } from './ai.queues';

@Injectable()
export class AiCronService {
  private readonly logger = new Logger(AiCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly chat: ChatService,
    private readonly lock: SchedulerLockService,
    @InjectQueue(AI_BLOCKER_QUEUE) private readonly blockerQueue: Queue,
  ) {}

  /** Nightly blocker prediction sweep. */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async predictBlockersNightly(): Promise<void> {
    await this.lock.withLock('ai-cron:blockers-nightly', 30 * 60_000, async () => {
      await this.blockerQueue.add('scan', {});
    });
  }

  /** Daily standup for every internal user who has a Chat binding. 9am Mon-Fri. */
  @Cron('0 9 * * 1-5')
  async generateStandups(): Promise<void> {
    await this.lock.withLock('ai-cron:standups', 30 * 60_000, async () => {
      await this.generateStandupsInner();
    });
  }

  private async generateStandupsInner(): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { kind: 'internal', archivedAt: null, chatBinding: { isNot: null } },
      include: { chatBinding: true },
    });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    for (const user of users) {
      try {
        const activity = await this.collectActivity(user.id, yesterday);
        if (!activity.hasAny) continue;
        const summary = await this.llm.generate(
          `Generate a one-paragraph standup for ${user.name} from yesterday's activity:\n\n` +
          `Tasks moved:\n${activity.movedTasks}\n\n` +
          `Comments posted: ${activity.commentCount}\n` +
          `PRs touched: ${activity.prCount}\n` +
          `Blocked tasks: ${activity.blockedTasks}`,
          {
            systemPrompt: 'You are writing a first-person standup. Format: yesterday / today / blockers.',
            maxTokens: 250,
          },
        );
        const card = {
          cardId: `standup-${user.id}-${Date.now()}`,
          card: {
            header: { title: 'YOUR STANDUP' },
            sections: [{ widgets: [{ textParagraph: { text: summary } }] }],
          },
        };
        await this.chat.sendCard(user.chatBinding!.googleChatSpaceId, card);
      } catch (err) {
        this.logger.warn({ err, userId: user.id }, 'standup generation failed');
      }
    }
  }

  private async collectActivity(userId: string, since: Date) {
    const [moved, comments] = await Promise.all([
      this.prisma.event.findMany({
        where: { actorUserId: userId, type: 'TaskStatusChanged', createdAt: { gte: since } },
        take: 20,
      }),
      this.prisma.comment.count({
        where: { authorUserId: userId, createdAt: { gte: since } },
      }),
    ]);
    const movedTasks = moved
      .map((e) => {
        const p = e.payload as Record<string, unknown>;
        return `- ${p['fromStatus']} → ${p['toStatus']}`;
      })
      .join('\n') || '(none)';
    return {
      hasAny: moved.length > 0 || comments > 0,
      movedTasks,
      commentCount: comments,
      prCount: 0, // wired in when GitHub PR events emit user-scoped activity
      blockedTasks: '(none)',
    };
  }

  /** Hourly: re-ping any tasks whose embedding hash drifted (manual edits, etc.). */
  // Currently the embedding worker is already triggered on task.updated events;
  // this cron is reserved for a future re-embed-all maintenance run.
}
