import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AiSyncService } from '../ai/ai-sync.service';
import type { CommentsService } from '../comments/comments.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { TasksService } from '../tasks/tasks.service';
import { ChatEventsService, errorCard, type ChatReply } from './chat-events.service';
import type { ChatService } from './chat.service';

// chat-events.service — slash commands dispatched by the inbound Chat webhook.
// We pin: (1) tokenizer correctness, (2) dispatch routing, (3) friendly error
// cards on bad input, (4) the permission gate. Outbound side-effects on Tasks
// / Comments / AI are mocked — we assert the call shape, not the downstream
// behavior (those services have their own suites).

function makeMocks() {
  const prisma = makePrismaMock();
  const tasks = { update: vi.fn(), changeStatus: vi.fn() };
  const comments = { create: vi.fn() };
  const permissions = { assertAtLeast: vi.fn().mockResolvedValue('Contributor') };
  const aiSync = { generateStandup: vi.fn().mockResolvedValue({ markdown: '# standup', raw: {} }) };
  const chat = { sendCard: vi.fn() };
  const service = new ChatEventsService(
    prisma,
    tasks as unknown as TasksService,
    comments as unknown as CommentsService,
    permissions as unknown as PermissionsService,
    aiSync as unknown as AiSyncService,
    chat as unknown as ChatService,
  );
  return { service, prisma, tasks, comments, permissions, aiSync, chat };
}

function bindCaller(prisma: PrismaService) {
  // Stub: chatBinding.findFirst returns a bound internal user — this is the
  // baseline state of the world for every authenticated slash command.
  vi.mocked(prisma.chatBinding.findFirst).mockResolvedValueOnce({
    userId: 'u-caller',
    googleChatUserId: 'users/caller',
    googleChatSpaceId: 'spaces/abc',
    user: {
      id: 'u-caller', email: 'caller@nockta.com', name: 'Caller',
      kind: 'internal', companyRole: 'Member',
    },
  } as never);
}

function stubTaskLookup(prisma: PrismaService, opts: { project?: 'ENG' | null; task?: 't-1' | null } = {}) {
  const projectKey = opts.project === undefined ? 'ENG' : opts.project;
  if (projectKey === null) {
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce(null);
    return;
  }
  vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({
    id: 'p-eng', key: projectKey,
  } as never);
  if (opts.task === null) {
    vi.mocked(prisma.task.findFirst).mockResolvedValueOnce(null);
    return;
  }
  vi.mocked(prisma.task.findFirst).mockResolvedValueOnce({ id: opts.task ?? 't-1' } as never);
}

// =============================================================================
// Tokenizer
// =============================================================================

describe('ChatEventsService.tokenize', () => {
  it('parses /assign ENG-42 @alice → cmd, taskKey, mentions', () => {
    const parsed = ChatEventsService.tokenize('/assign ENG-42 @alice');
    expect(parsed).toEqual({
      cmd: 'assign',
      taskKey: 'ENG-42',
      mentions: ['alice'],
      rest: [],
    });
  });

  it('lower-cases the cmd name but uppercases the task key', () => {
    const parsed = ChatEventsService.tokenize('/Assign eng-42 @Alice');
    expect(parsed?.cmd).toBe('assign');
    expect(parsed?.taskKey).toBe('ENG-42');
    // Mention handle is lowercased so resolution is case-insensitive.
    expect(parsed?.mentions).toEqual(['alice']);
  });

  it('strips leading bot @mention in room messages', () => {
    const parsed = ChatEventsService.tokenize('@NocktaFlow /help');
    expect(parsed?.cmd).toBe('help');
  });

  it('captures /status status text', () => {
    const parsed = ChatEventsService.tokenize('/status ENG-7 In Review');
    expect(parsed).toMatchObject({
      cmd: 'status',
      taskKey: 'ENG-7',
      statusText: 'In Review',
    });
  });

  it('captures /comment body text', () => {
    const parsed = ChatEventsService.tokenize('/comment ENG-9 needs a UX review');
    expect(parsed).toMatchObject({
      cmd: 'comment',
      taskKey: 'ENG-9',
      text: 'needs a UX review',
    });
  });

  it('returns null for non-slash lines', () => {
    expect(ChatEventsService.tokenize('hello bot')).toBeNull();
    expect(ChatEventsService.tokenize('')).toBeNull();
  });

  it('returns null for bare slash with no command name', () => {
    expect(ChatEventsService.tokenize('/')).toBeNull();
  });
});

// =============================================================================
// Dispatch routing — each command name maps to the right handler.
// =============================================================================

describe('ChatEventsService.handle — dispatch routing', () => {
  it('/help routes without requiring a binding', async () => {
    const { service, prisma } = makeMocks();
    const reply = await service.handle({
      user: { name: 'users/whoever', displayName: 'Stranger' },
      message: { text: '/help' },
    });
    expect('cardsV2' in reply!).toBe(true);
    if (!('cardsV2' in reply!)) throw new Error('expected card');
    const card = reply.cardsV2[0]!.card as { header: { title: string } };
    expect(card.header.title).toMatch(/slash commands/i);
    // No binding lookup needed for help.
    expect(vi.mocked(prisma.chatBinding.findFirst)).not.toHaveBeenCalled();
  });

  it('/assign routes to TasksService.update with the resolved user', async () => {
    const { service, prisma, tasks } = makeMocks();
    bindCaller(prisma);
    stubTaskLookup(prisma);
    // resolveMentionTarget → findFirst for the @alice handle on User.
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      id: 'u-alice', name: 'Alice', chatBinding: { userId: 'u-alice' },
    } as never);

    await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/assign ENG-42 @alice' },
    });

    expect(tasks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-caller' }),
      't-1',
      { assigneeUserId: 'u-alice' },
    );
  });

  it('/status routes to TasksService.changeStatus', async () => {
    const { service, prisma, tasks } = makeMocks();
    bindCaller(prisma);
    stubTaskLookup(prisma);
    await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/status ENG-42 In Review' },
    });
    expect(tasks.changeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-caller' }),
      't-1',
      'In Review',
      'user',
    );
  });

  it('/comment routes to CommentsService.create', async () => {
    const { service, prisma, comments } = makeMocks();
    bindCaller(prisma);
    stubTaskLookup(prisma);
    await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/comment ENG-42 ship it' },
    });
    expect(comments.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-caller' }),
      't-1',
      'ship it',
    );
  });

  it('/standup routes to AiSyncService.generateStandup', async () => {
    const { service, prisma, aiSync } = makeMocks();
    bindCaller(prisma);
    await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/standup' },
    });
    expect(aiSync.generateStandup).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-caller' }),
      'u-caller',
    );
  });

  it('/my-tasks queries Prisma for the caller\'s open tasks', async () => {
    const { service, prisma } = makeMocks();
    bindCaller(prisma);
    vi.mocked(prisma.task.findMany).mockResolvedValueOnce([
      {
        id: 't-1', keyNumber: 42, title: 'wire it up', status: 'In Progress',
        priority: 'High', isBlocked: false, dueDate: null,
        project: { key: 'ENG' },
      },
    ] as never);
    const reply = await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/my-tasks' },
    });
    const findManyArgs = vi.mocked(prisma.task.findMany).mock.calls[0]?.[0];
    expect(findManyArgs?.where).toMatchObject({
      assigneeUserId: 'u-caller',
      status: { notIn: ['Done', 'Approved'] },
    });
    expect('cardsV2' in reply!).toBe(true);
  });
});

// =============================================================================
// Error card shape for malformed input.
// =============================================================================

describe('ChatEventsService.handle — friendly errors', () => {
  it('errorCard helper returns a Cards v2 envelope with header + body', () => {
    const card = errorCard('Bad thing', 'Detail here');
    expect(card).toMatchObject({
      cardsV2: [
        {
          cardId: 'error',
          card: {
            header: { title: 'BAD THING' },
            sections: [
              {
                widgets: [{ textParagraph: { text: 'Detail here' } }],
              },
            ],
          },
        },
      ],
    });
  });

  it('/assign without a task key returns a usage card', async () => {
    const { service, prisma } = makeMocks();
    bindCaller(prisma);
    const reply = await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/assign' },
    });
    expect(headerTitle(reply)).toMatch(/usage/i);
  });

  it('/assign with an unparseable key returns "not found"', async () => {
    const { service, prisma } = makeMocks();
    bindCaller(prisma);
    // The cmd parses (it's a valid /assign line), so the dispatcher tries to
    // look the key up — we stub the project lookup to null.
    stubTaskLookup(prisma, { project: null });
    const reply = await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/assign ZZZ-1 @alice' },
    });
    expect(headerTitle(reply)).toMatch(/not found/i);
  });

  it('/assign to a user with no Chat binding returns "user not bound"', async () => {
    const { service, prisma } = makeMocks();
    bindCaller(prisma);
    stubTaskLookup(prisma);
    // findFirst for @alice returns a user WITHOUT a chatBinding.
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      id: 'u-alice', name: 'Alice', chatBinding: null,
    } as never);
    const reply = await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/assign ENG-42 @alice' },
    });
    expect(headerTitle(reply)).toMatch(/not bound/i);
  });

  it('/status with an invalid status surfaces the TaskService error in a friendly card', async () => {
    const { service, prisma, tasks } = makeMocks();
    bindCaller(prisma);
    stubTaskLookup(prisma);
    tasks.changeStatus.mockRejectedValueOnce(
      new Error('Status Banana not valid for workflow preset engineering'),
    );
    const reply = await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/status ENG-42 Banana' },
    });
    expect(headerTitle(reply)).toMatch(/invalid status/i);
  });

  it('unbound caller invoking any non-help command gets the bind-first card', async () => {
    const { service, prisma } = makeMocks();
    vi.mocked(prisma.chatBinding.findFirst).mockResolvedValueOnce(null as never);
    const reply = await service.handle({
      user: { name: 'users/stranger', displayName: 'Stranger' },
      message: { text: '/my-tasks' },
    });
    expect(headerTitle(reply)).toMatch(/not connected/i);
  });

  it('non-slash lines return null so the controller falls through to binding-handshake', async () => {
    const { service } = makeMocks();
    const reply = await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: 'hi' },
    });
    expect(reply).toBeNull();
  });
});

// =============================================================================
// Permission gate — caller without access to the project gets a friendly card.
// =============================================================================

describe('ChatEventsService.handle — permission gate', () => {
  it('returns "no access" card when permissions.assertAtLeast throws', async () => {
    const { service, prisma, permissions, tasks } = makeMocks();
    bindCaller(prisma);
    stubTaskLookup(prisma);
    // Mention resolution path also runs.
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce({
      id: 'u-alice', name: 'Alice', chatBinding: { userId: 'u-alice' },
    } as never);
    permissions.assertAtLeast.mockRejectedValueOnce(new Error('Requires project role Contributor'));

    const reply = await service.handle({
      user: { name: 'users/caller', displayName: 'Caller' },
      message: { text: '/assign ENG-42 @alice' },
    });
    expect(headerTitle(reply)).toMatch(/no access/i);
    // And we DO NOT touch the underlying task — the gate fires before the
    // write side-effect.
    expect(tasks.update).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Helpers
// =============================================================================

function headerTitle(reply: ChatReply | null): string {
  if (!reply || !('cardsV2' in reply)) return '';
  const card = reply.cardsV2[0]?.card as { header?: { title?: string } } | undefined;
  return card?.header?.title ?? '';
}
