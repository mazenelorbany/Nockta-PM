import { Injectable, Logger } from '@nestjs/common';

import { Env } from '../../config/env';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AiSyncService } from '../ai/ai-sync.service';
import type { AuthenticatedUser } from '../auth/types';
import type { CommentsService } from '../comments/comments.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { TasksService } from '../tasks/tasks.service';

import type { ChatService } from './chat.service';

// =============================================================================
// chat-events.service — inbound bot event handler. Owns the slash-command
// tokenizer + dispatcher. The controller (chat-events.controller) wires raw
// Google Chat envelopes here when the user types `/<cmd> ...`.
//
// Every public surface here returns a Google Chat reply payload (either a
// text reply or a Cards v2 envelope). Errors are surfaced as friendly cards,
// NEVER stack traces — see `errorCard`.
//
// We deliberately do not depend on the outbound dispatcher; this is the
// inbound path. The two share `ChatService` for outbound calls (where used,
// e.g. listing users in /assign) but never co-mutate state.
// =============================================================================

interface BotUser {
  name: string;          // 'users/123...'
  displayName: string;
  email?: string;
}

interface BotMessage {
  text?: string;
  /** Annotations from Google Chat — used to resolve @mentions to user ids. */
  annotations?: Array<{
    type?: string;
    userMention?: { user?: { name?: string; displayName?: string; type?: string } };
  }>;
}

export interface SlashCommandEnvelope {
  user: BotUser;
  message: BotMessage;
}

/** Parsed shape of any `/<cmd> ...` line. Both `taskKey` and `mentions`
 *  are optional because not every command has them. */
export interface ParsedCommand {
  cmd: string;
  /** Project task key like `ENG-42`. Uppercased. */
  taskKey?: string;
  /** New status token for /status — the rest of the line after the key. */
  statusText?: string;
  /** Free text for /comment — everything after the key. */
  text?: string;
  /** `@alice` mentions, lowercased (display-name handles). */
  mentions: string[];
  /** Anything else as positional tokens (debugging only). */
  rest: string[];
}

/** Discriminated reply shape — Google Chat accepts either text or cardsV2. */
export type ChatReply =
  | { text: string }
  | { cardsV2: Array<{ cardId: string; card: unknown }> };

const KNOWN_COMMANDS = [
  'assign',
  'status',
  'comment',
  'my-tasks',
  'standup',
  'sprint',
  'help',
] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

/** Robust enough for our needs: ENG-42 / API-9 / ABC-100 etc. */
const TASK_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

@Injectable()
export class ChatEventsService {
  private readonly logger = new Logger(ChatEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly comments: CommentsService,
    private readonly permissions: PermissionsService,
    private readonly aiSync: AiSyncService,
    private readonly chat: ChatService,
  ) {}

  // ===========================================================================
  // Tokenizer — exported as a pure function so tests can pin it.
  // ===========================================================================

  /**
   * Tokenize a slash-command line. Trims leading bot @mentions Chat prepends
   * to DMs ("@Nockta Flow /assign ENG-42 @alice"). Returns null if the line
   * doesn't start with `/` or the command name is empty.
   */
  static tokenize(rawInput: string): ParsedCommand | null {
    if (!rawInput) return null;
    // Google Chat prepends bot mentions to the message body in rooms. Strip
    // any leading "@Word " tokens until we find the `/`.
    let text = rawInput.trim();
    while (text.startsWith('@')) {
      const sp = text.indexOf(' ');
      if (sp === -1) return null;
      text = text.slice(sp + 1).trim();
    }
    if (!text.startsWith('/')) return null;

    const tokens = text.split(/\s+/);
    const cmdToken = tokens.shift();
    if (!cmdToken || cmdToken === '/') return null;
    const cmd = cmdToken.slice(1).toLowerCase();
    if (!cmd) return null;

    const mentions: string[] = [];
    const rest: string[] = [];
    for (const t of tokens) {
      if (t.startsWith('@')) {
        const handle = t.slice(1).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase();
        if (handle) mentions.push(handle);
      } else {
        rest.push(t);
      }
    }

    // Pull a task key off the front if present.
    let taskKey: string | undefined;
    if (rest.length > 0) {
      const candidate = rest[0]!.toUpperCase();
      if (TASK_KEY_RE.test(candidate)) {
        taskKey = candidate;
        rest.shift();
      }
    }

    // /status uses the next token as status text (rest of line joined).
    // /comment uses the rest joined as body text.
    let statusText: string | undefined;
    let bodyText: string | undefined;
    if (cmd === 'status' && rest.length > 0) {
      statusText = rest.join(' ');
    } else if (cmd === 'comment' && rest.length > 0) {
      bodyText = rest.join(' ');
    }

    return {
      cmd,
      ...(taskKey ? { taskKey } : {}),
      ...(statusText ? { statusText } : {}),
      ...(bodyText ? { text: bodyText } : {}),
      mentions,
      rest,
    };
  }

  // ===========================================================================
  // Dispatcher — routes by command name. Returns a Chat reply payload.
  // ===========================================================================

  /**
   * Top-level entry point. Returns a reply payload OR null if the message
   * isn't a slash command (caller should fall back to the binding handshake).
   */
  async handle(envelope: SlashCommandEnvelope): Promise<ChatReply | null> {
    const parsed = ChatEventsService.tokenize(envelope.message.text ?? '');
    if (!parsed) return null;

    // Resolve the Chat user to a Nockta user via ChatBinding. Every command
    // (except /help) requires a bound caller.
    const actor = parsed.cmd === 'help'
      ? null
      : await this.resolveActor(envelope.user.name);

    if (parsed.cmd !== 'help' && !actor) {
      return errorCard(
        'Not connected',
        "You're not connected to Nockta Flow. Send any message to the bot first to bind your account.",
      );
    }

    try {
      switch (parsed.cmd as KnownCommand) {
        case 'help':
          return this.handleHelp();
        case 'assign':
          return this.handleAssign(actor!, parsed, envelope);
        case 'status':
          return this.handleStatus(actor!, parsed);
        case 'comment':
          return this.handleComment(actor!, parsed);
        case 'my-tasks':
          return this.handleMyTasks(actor!);
        case 'standup':
          return this.handleStandup(actor!);
        case 'sprint':
          return this.handleSprint(actor!);
        default:
          return errorCard(
            'Unknown command',
            `\`/${parsed.cmd}\` isn't a command I know. Try \`/help\`.`,
          );
      }
    } catch (err) {
      // Defence-in-depth — every handler is supposed to return its own error
      // card. This catches anything missed so the user never sees a 500.
      const message = (err as { message?: string }).message ?? 'Action failed';
      this.logger.warn({ err, cmd: parsed.cmd }, 'slash command failed');
      return errorCard('Error', message);
    }
  }

  // ===========================================================================
  // Handlers
  // ===========================================================================

  private handleHelp(): ChatReply {
    return {
      cardsV2: [
        {
          cardId: 'help',
          card: {
            header: { title: 'Nockta Flow — slash commands' },
            sections: [
              {
                widgets: HELP_LINES.map((line) => ({
                  decoratedText: {
                    topLabel: line.cmd,
                    text: line.usage,
                    wrapText: true,
                  },
                })),
              },
            ],
          },
        },
      ],
    };
  }

  private async handleAssign(
    actor: AuthenticatedUser,
    parsed: ParsedCommand,
    envelope: SlashCommandEnvelope,
  ): Promise<ChatReply> {
    if (!parsed.taskKey) {
      return errorCard(
        'Usage',
        '`/assign <task-key> @user` — e.g. `/assign ENG-42 @alice`.',
      );
    }
    if (parsed.mentions.length === 0 && (envelope.message.annotations ?? []).length === 0) {
      return errorCard('Usage', 'Mention a user with `@name`.');
    }

    const task = await this.lookupTaskByKey(parsed.taskKey);
    if (!task) return errorCard('Not found', `No task with key \`${parsed.taskKey}\`.`);
    if (!(await this.canActOnTask(actor, task.projectId))) {
      return errorCard('No access', `You don't have access to project \`${task.projectKey}\`.`);
    }

    // Resolve the target. Preference order:
    //   1) Chat user annotations (most reliable — the Chat client resolves
    //      mentions to `users/<id>` which ChatBinding indexes).
    //   2) The `@handle` text — match against User.name (case-insensitive) on
    //      internal users only.
    const target = await this.resolveMentionTarget(envelope.message, parsed.mentions);
    if (!target) {
      return errorCard(
        'User not bound',
        'I couldn\'t find that user. They need to send the Nockta Flow bot a message first to bind their account.',
      );
    }

    await this.tasks.update(actor, task.id, { assigneeUserId: target.id });
    return {
      text: `Assigned **${parsed.taskKey}** to ${target.name}.`,
    };
  }

  private async handleStatus(
    actor: AuthenticatedUser,
    parsed: ParsedCommand,
  ): Promise<ChatReply> {
    if (!parsed.taskKey || !parsed.statusText) {
      return errorCard(
        'Usage',
        '`/status <task-key> <new-status>` — e.g. `/status ENG-42 In Review`.',
      );
    }
    const task = await this.lookupTaskByKey(parsed.taskKey);
    if (!task) return errorCard('Not found', `No task with key \`${parsed.taskKey}\`.`);
    if (!(await this.canActOnTask(actor, task.projectId))) {
      return errorCard('No access', `You don't have access to project \`${task.projectKey}\`.`);
    }
    try {
      await this.tasks.changeStatus(actor, task.id, parsed.statusText, 'user');
    } catch (err) {
      // tasks.changeStatus throws BadRequest on invalid status — surface a
      // friendly hint instead of "400 Bad Request".
      const message = (err as { message?: string }).message ?? 'Bad status';
      return errorCard('Invalid status', message);
    }
    return { text: `Set **${parsed.taskKey}** → ${parsed.statusText}.` };
  }

  private async handleComment(
    actor: AuthenticatedUser,
    parsed: ParsedCommand,
  ): Promise<ChatReply> {
    if (!parsed.taskKey || !parsed.text) {
      return errorCard(
        'Usage',
        '`/comment <task-key> <text>` — e.g. `/comment ENG-42 ping the design team`.',
      );
    }
    const task = await this.lookupTaskByKey(parsed.taskKey);
    if (!task) return errorCard('Not found', `No task with key \`${parsed.taskKey}\`.`);
    if (!(await this.canActOnTask(actor, task.projectId))) {
      return errorCard('No access', `You don't have access to project \`${task.projectKey}\`.`);
    }
    await this.comments.create(actor, task.id, parsed.text);
    return { text: `Comment posted on **${parsed.taskKey}**.` };
  }

  private async handleMyTasks(actor: AuthenticatedUser): Promise<ChatReply> {
    const tasks = await this.prisma.task.findMany({
      where: {
        assigneeUserId: actor.id,
        status: { notIn: ['Done', 'Approved'] },
      },
      select: {
        id: true,
        keyNumber: true,
        title: true,
        status: true,
        priority: true,
        isBlocked: true,
        dueDate: true,
        project: { select: { key: true } },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 15,
    });

    if (tasks.length === 0) {
      return { text: 'No open tasks assigned to you. Inbox zero territory.' };
    }

    return {
      cardsV2: [
        {
          cardId: `my-tasks-${actor.id}`,
          card: {
            header: { title: 'YOUR OPEN TASKS', subtitle: `${tasks.length} item${tasks.length === 1 ? '' : 's'}` },
            sections: [
              {
                widgets: tasks.flatMap((t) => {
                  const key = `${t.project.key}-${t.keyNumber}`;
                  return [
                    {
                      decoratedText: {
                        topLabel: `${key} · ${t.priority}${t.isBlocked ? ' · blocked' : ''}`,
                        text: t.title,
                        wrapText: true,
                        bottomLabel: t.dueDate
                          ? `due ${new Date(t.dueDate).toLocaleDateString()}`
                          : t.status,
                      },
                    },
                    {
                      buttonList: {
                        buttons: [
                          { text: 'Open', onClick: { openLink: { url: taskUrl(t.id) } } },
                          {
                            text: 'Reassign',
                            onClick: {
                              action: {
                                function: 'task.reassign_dialog',
                                parameters: [{ key: 'taskId', value: t.id }],
                              },
                            },
                          },
                          {
                            text: 'Reply',
                            onClick: {
                              action: {
                                function: 'task.reply_dialog',
                                parameters: [{ key: 'taskId', value: t.id }],
                              },
                            },
                          },
                        ],
                      },
                    },
                  ];
                }),
              },
            ],
          },
        },
      ],
    };
  }

  private async handleStandup(actor: AuthenticatedUser): Promise<ChatReply> {
    const { markdown } = await this.aiSync.generateStandup(actor, actor.id);
    return {
      cardsV2: [
        {
          cardId: `standup-${actor.id}`,
          card: {
            header: { title: 'YOUR STANDUP' },
            sections: [{ widgets: [{ textParagraph: { text: markdown } }] }],
          },
        },
      ],
    };
  }

  private async handleSprint(actor: AuthenticatedUser): Promise<ChatReply> {
    // "Most-recently-touched project" — the project where the user last
    // authored a task or comment. Fall back to any project they have access
    // to if the activity table is dry.
    const project = await this.findRecentProjectFor(actor.id);
    if (!project) {
      return errorCard(
        'No active project',
        "Couldn't find a recent project for you. Open a task or post a comment first.",
      );
    }
    const sprint = await this.prisma.sprint.findFirst({
      where: { projectId: project.id, state: 'active' },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        tasks: { select: { status: true, isBlocked: true } },
      },
    });
    if (!sprint) {
      return errorCard(
        'No active sprint',
        `Project **${project.key}** has no active sprint right now.`,
      );
    }
    const total = sprint.tasks.length;
    const done = sprint.tasks.filter((t) => t.status === 'Done' || t.status === 'Approved').length;
    const blocked = sprint.tasks.filter((t) => t.isBlocked).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    return {
      cardsV2: [
        {
          cardId: `sprint-${sprint.id}`,
          card: {
            header: {
              title: 'ACTIVE SPRINT',
              subtitle: `${project.key} · ${sprint.name}`,
            },
            sections: [
              {
                widgets: [
                  { decoratedText: { topLabel: 'Progress', text: `${pct}% (${done}/${total} done)` } },
                  { decoratedText: { topLabel: 'Blocked', text: `${blocked}` } },
                  ...(sprint.endDate
                    ? [{
                        decoratedText: {
                          topLabel: 'Ends',
                          text: new Date(sprint.endDate).toLocaleDateString(),
                        },
                      }]
                    : []),
                ],
              },
            ],
          },
        },
      ],
    };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Resolve the bound Chat user → synthetic AuthenticatedUser. */
  private async resolveActor(googleChatUserId: string): Promise<AuthenticatedUser | null> {
    const binding = await this.prisma.chatBinding.findFirst({
      where: { googleChatUserId },
      include: { user: true },
    });
    if (!binding) return null;
    return {
      id: binding.userId,
      email: binding.user.email,
      kind: binding.user.kind,
      companyRole: binding.user.companyRole,
      jti: 'chat-slash', // synthetic; not used for revocation
    };
  }

  /**
   * Look up a task by its display key `<PROJECT>-<NUMBER>`. Returns null if
   * the key doesn't parse or no task matches.
   */
  private async lookupTaskByKey(
    key: string,
  ): Promise<{ id: string; projectId: string; projectKey: string } | null> {
    const m = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(key);
    if (!m) return null;
    const projectKey = m[1]!;
    const keyNumber = Number(m[2]!);
    const project = await this.prisma.project.findUnique({
      where: { key: projectKey },
      select: { id: true, key: true },
    });
    if (!project) return null;
    const task = await this.prisma.task.findFirst({
      where: { projectId: project.id, keyNumber },
      select: { id: true },
    });
    if (!task) return null;
    return { id: task.id, projectId: project.id, projectKey: project.key };
  }

  /** Project-permission gate. Contributor or better. */
  private async canActOnTask(actor: AuthenticatedUser, projectId: string): Promise<boolean> {
    try {
      await this.permissions.assertAtLeast(actor, projectId, 'Contributor');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a mention to a Nockta user. Two paths:
   *  - Chat annotation (`userMention.user.name` → ChatBinding.googleChatUserId)
   *  - `@handle` text → User.name fuzzy match (internal users only)
   *
   * Returns null when nothing matches OR when the target isn't bound — the
   * caller surfaces that as a friendly error card.
   */
  private async resolveMentionTarget(
    message: BotMessage,
    handles: string[],
  ): Promise<{ id: string; name: string } | null> {
    const annotations = message.annotations ?? [];
    for (const a of annotations) {
      const resourceName = a.userMention?.user?.name;
      if (!resourceName) continue;
      const binding = await this.prisma.chatBinding.findFirst({
        where: { googleChatUserId: resourceName },
        include: { user: { select: { id: true, name: true } } },
      });
      if (binding) return { id: binding.user.id, name: binding.user.name };
    }
    for (const handle of handles) {
      const user = await this.prisma.user.findFirst({
        where: {
          kind: 'internal',
          archivedAt: null,
          // Case-insensitive contains on the display name — `@alice` finds
          // "Alice Smith" or "alice". We restrict to internal users so a
          // client can't be assigned a task via Chat.
          name: { contains: handle, mode: 'insensitive' },
        },
        select: { id: true, name: true, chatBinding: { select: { userId: true } } },
      });
      // Require a binding so the assigned user can actually receive the DM
      // we'll fire on assignment. Without this rule, a typo'd handle could
      // resolve to a real user who never opted into the integration.
      if (user?.chatBinding) return { id: user.id, name: user.name };
    }
    return null;
  }

  /**
   * Find the project the user has most-recently touched: by event timeline
   * first (TaskStatusChanged / CommentAdded), then by any project they have
   * access to as a fallback.
   */
  private async findRecentProjectFor(
    userId: string,
  ): Promise<{ id: string; key: string } | null> {
    const event = await this.prisma.event.findFirst({
      where: { actorUserId: userId, projectId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { projectId: true },
    });
    if (event?.projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: event.projectId },
        select: { id: true, key: true },
      });
      if (project) return project;
    }
    // Fallback: any project where the user has access.
    const grant = await this.prisma.projectAccess.findFirst({
      where: { userId },
      select: { project: { select: { id: true, key: true } } },
    });
    return grant?.project ?? null;
  }
}

// =============================================================================
// Friendly error card builder. Tests assert on the shape (cardsV2[0].card.header).
// =============================================================================

export function errorCard(title: string, body: string): ChatReply {
  return {
    cardsV2: [
      {
        cardId: 'error',
        card: {
          header: { title: title.toUpperCase() },
          sections: [
            {
              widgets: [{ textParagraph: { text: body } }],
            },
          ],
        },
      },
    ],
  };
}

function taskUrl(taskId: string): string {
  // Env imported at module top so vitest's loader resolves it cleanly. The
  // earlier dynamic-require workaround for a circular-import wart no longer
  // applies (Env is a plain const object, not a class with mutual deps).
  return `${Env.APP_URL_INTERNAL}/tasks/${taskId}`;
}

const HELP_LINES: { cmd: string; usage: string }[] = [
  { cmd: '/assign', usage: '/assign <task-key> @user — reassign a task (e.g. /assign ENG-42 @alice)' },
  { cmd: '/status', usage: '/status <task-key> <new-status> — transition a task (e.g. /status ENG-42 In Review)' },
  { cmd: '/comment', usage: '/comment <task-key> <text> — post a comment as yourself' },
  { cmd: '/my-tasks', usage: 'List your open assigned tasks with quick-action buttons' },
  { cmd: '/standup', usage: 'Your personal yesterday / today / blockers card' },
  { cmd: '/sprint', usage: 'Active sprint summary for your most recently touched project' },
  { cmd: '/help', usage: 'Show this list' },
];
