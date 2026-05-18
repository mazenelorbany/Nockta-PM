import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtService } from '@nestjs/jwt';

import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SessionService } from '../auth/session.service';
import type { AuthenticatedUser } from '../auth/types';

import { RealtimeGateway, TYPING_MIN_INTERVAL_MS } from './realtime.gateway';

// realtime.gateway — auth handshake, room-join permission gate, the 500ms
// per-user typing throttle, and presence-on-disconnect. Built with a hand-
// rolled "fake socket" (data bag, join/leave/disconnect spies, chainable to())
// — we never spin up a real socket.io server.

interface RoomEmitter { emit: ReturnType<typeof vi.fn> }

interface FakeSocket {
  data: { user?: AuthenticatedUser };
  rooms: Set<string>;
  handshake: { auth: { token?: string }; headers: { authorization?: string } };
  disconnect: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  to: ReturnType<typeof vi.fn>;
  toEmitter: RoomEmitter;
}

function makeSocket(opts: { token?: string; authorization?: string } = {}): FakeSocket {
  const toEmitter: RoomEmitter = { emit: vi.fn() };
  const socket: FakeSocket = {
    data: {},
    rooms: new Set<string>(),
    handshake: {
      auth: opts.token !== undefined ? { token: opts.token } : {},
      headers: opts.authorization !== undefined ? { authorization: opts.authorization } : {},
    },
    disconnect: vi.fn(),
    join: vi.fn(async (room: string) => { socket.rooms.add(room); }),
    leave: vi.fn(async (room: string) => { socket.rooms.delete(room); }),
    to: vi.fn(() => toEmitter),
    toEmitter,
  };
  return socket;
}

interface Mocks {
  prisma: PrismaService;
  jwt: { verifyAsync: ReturnType<typeof vi.fn> };
  permissions: { effectiveRole: ReturnType<typeof vi.fn>; canSeeTask: ReturnType<typeof vi.fn> };
  sessions: { isJtiRevoked: ReturnType<typeof vi.fn> };
  server: { in: ReturnType<typeof vi.fn>; to: ReturnType<typeof vi.fn>; presence: RoomEmitter };
}

function build(): { gateway: RealtimeGateway; mocks: Mocks } {
  const prisma = makePrismaMock();
  const jwt = { verifyAsync: vi.fn() };
  const permissions = { effectiveRole: vi.fn(), canSeeTask: vi.fn() };
  const sessions = { isJtiRevoked: vi.fn().mockResolvedValue(false) };
  const gateway = new RealtimeGateway(
    jwt as unknown as JwtService,
    prisma,
    permissions as unknown as PermissionsService,
    sessions as unknown as SessionService,
  );
  const presence: RoomEmitter = { emit: vi.fn() };
  const server = {
    in: vi.fn(() => ({ fetchSockets: async () => [] })),
    to: vi.fn(() => presence),
    presence,
  };
  gateway.server = server as unknown as RealtimeGateway['server'];
  return { gateway, mocks: { prisma, jwt, permissions, sessions, server } };
}

const VALID_PAYLOAD = {
  sub: 'u-1', jti: 'jti-1', email: 'a@nockta.com',
  kind: 'internal' as const, role: 'Member' as const,
};

function authedSocket(userId = 'u-1'): FakeSocket {
  const s = makeSocket();
  s.data.user = { id: userId, email: 'a@nockta.com', kind: 'internal', companyRole: 'Member' } as AuthenticatedUser;
  return s;
}

describe('RealtimeGateway.handleConnection', () => {
  let mocks: Mocks;
  let gateway: RealtimeGateway;

  beforeEach(() => {
    ({ gateway, mocks } = build());
  });

  it('disconnects when no token is presented', async () => {
    const socket = makeSocket();
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.data.user).toBeUndefined();
  });

  it('attaches the user and joins user:<id> on a valid JWT', async () => {
    const socket = makeSocket({ token: 'good.jwt' });
    mocks.jwt.verifyAsync.mockResolvedValueOnce(VALID_PAYLOAD);
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-1', email: 'a@nockta.com', kind: 'internal', companyRole: 'Member', archivedAt: null,
    } as never);

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data.user?.id).toBe('u-1');
    expect(socket.join).toHaveBeenCalledWith('user:u-1');
  });

  it('disconnects when JWT verify throws (invalid signature, expired, etc.)', async () => {
    const socket = makeSocket({ token: 'bad.jwt' });
    mocks.jwt.verifyAsync.mockRejectedValueOnce(new Error('jwt malformed'));
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects when the jti has been revoked', async () => {
    const socket = makeSocket({ token: 'good.jwt' });
    mocks.jwt.verifyAsync.mockResolvedValueOnce(VALID_PAYLOAD);
    mocks.sessions.isJtiRevoked.mockResolvedValueOnce(true);
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects when the user has been archived since the JWT was issued', async () => {
    const socket = makeSocket({ token: 'good.jwt' });
    mocks.jwt.verifyAsync.mockResolvedValueOnce(VALID_PAYLOAD);
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-1', email: 'a@nockta.com', kind: 'internal', companyRole: 'Member',
      archivedAt: new Date('2024-01-01'),
    } as never);
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });
});

describe('RealtimeGateway.joinTask — permission gate', () => {
  let mocks: Mocks;
  let gateway: RealtimeGateway;

  beforeEach(() => {
    ({ gateway, mocks } = build());
  });

  it('refuses to join without an attached user', async () => {
    const socket = makeSocket();
    const res = await gateway.joinTask(socket as never, { taskId: 't-1' });
    expect(res.ok).toBe(false);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('refuses to join when the task does not exist', async () => {
    const socket = authedSocket();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce(null);
    const res = await gateway.joinTask(socket as never, { taskId: 't-missing' });
    expect(res.ok).toBe(false);
    expect(mocks.permissions.canSeeTask).not.toHaveBeenCalled();
  });

  it('consults permissions.canSeeTask before joining and refuses on false', async () => {
    const socket = authedSocket();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1', visibility: 'internal',
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(false);

    const res = await gateway.joinTask(socket as never, { taskId: 't-1' });

    expect(res.ok).toBe(false);
    expect(mocks.permissions.canSeeTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-1' }), 'p1', 'internal',
    );
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('joins the task room when canSeeTask returns true', async () => {
    const socket = authedSocket();
    vi.mocked(mocks.prisma.task.findUnique).mockResolvedValueOnce({
      projectId: 'p1', visibility: 'client_visible',
    } as never);
    mocks.permissions.canSeeTask.mockResolvedValueOnce(true);

    const res = await gateway.joinTask(socket as never, { taskId: 't-1' });

    expect(res.ok).toBe(true);
    expect(socket.join).toHaveBeenCalledWith('task:t-1');
  });
});

describe('RealtimeGateway typing rate-limit (500ms per user)', () => {
  let gateway: RealtimeGateway;

  beforeEach(() => {
    ({ gateway } = build());
  });

  it('lets the first typing.start through and emits to the task room', () => {
    const socket = authedSocket();
    gateway.typingStart(socket as never, { taskId: 't-1' });
    expect(socket.to).toHaveBeenCalledWith('task:t-1');
    expect(socket.toEmitter.emit).toHaveBeenCalledWith(
      'typing.start', expect.objectContaining({ userId: 'u-1', taskId: 't-1' }),
    );
  });

  it('drops a second typing event within the 500ms window', () => {
    const socket = authedSocket();
    gateway.typingStart(socket as never, { taskId: 't-1' });
    socket.toEmitter.emit.mockClear();
    gateway.typingStart(socket as never, { taskId: 't-1' });
    expect(socket.toEmitter.emit).not.toHaveBeenCalled();
  });

  it('lets a subsequent event through once the 500ms window has passed', () => {
    const socket = authedSocket();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      gateway.typingStart(socket as never, { taskId: 't-1' });
      socket.toEmitter.emit.mockClear();
      vi.setSystemTime(new Date(Date.now() + TYPING_MIN_INTERVAL_MS + 1));
      gateway.typingStart(socket as never, { taskId: 't-1' });
      expect(socket.toEmitter.emit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles per user — user-B unaffected by user-A spamming', () => {
    const socketA = authedSocket('user-a');
    const socketB = authedSocket('user-b');
    gateway.typingStart(socketA as never, { taskId: 't-1' });
    gateway.typingStart(socketA as never, { taskId: 't-1' }); // dropped
    gateway.typingStart(socketB as never, { taskId: 't-1' });
    expect(socketA.toEmitter.emit).toHaveBeenCalledTimes(1);
    expect(socketB.toEmitter.emit).toHaveBeenCalledTimes(1);
  });

  it('also throttles typing.stop (so start/stop flapping cannot bypass it)', () => {
    const socket = authedSocket();
    gateway.typingStart(socket as never, { taskId: 't-1' });
    gateway.typingStop(socket as never, { taskId: 't-1' });
    expect(socket.toEmitter.emit).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Pass I (Realtime 8 → 9). Cursor presence + comment typing.
//
// The gateway forwards `presence:ping` to a `task:<id>:presence` sub-room so
// the high-fan-out content room isn't drowned in heartbeat events. The 3s
// throttle per (user, task) is the only rate-limit defence — a buggy client
// pings every 100ms? We still only broadcast once every 3s.
// =============================================================================

describe('RealtimeGateway.presencePing — broadcast + throttle', () => {
  let gateway: RealtimeGateway;

  beforeEach(() => {
    ({ gateway } = build());
  });

  it('rebroadcasts the ping to the task:<id>:presence sub-room', () => {
    const socket = authedSocket();
    gateway.presencePing(socket as never, {
      taskId: 't-1',
      cursorPosition: { field: 'description', index: 42 },
    });
    expect(socket.to).toHaveBeenCalledWith('task:t-1:presence');
    expect(socket.toEmitter.emit).toHaveBeenCalledWith(
      'presence.ping',
      expect.objectContaining({
        userId: 'u-1',
        taskId: 't-1',
        cursorPosition: { field: 'description', index: 42 },
      }),
    );
  });

  it('drops a second ping within the 3s throttle window', () => {
    const socket = authedSocket();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      gateway.presencePing(socket as never, { taskId: 't-1' });
      socket.toEmitter.emit.mockClear();
      vi.setSystemTime(new Date(Date.now() + 1000));
      gateway.presencePing(socket as never, { taskId: 't-1' });
      expect(socket.toEmitter.emit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT throttle across different tasks for the same user', () => {
    const socket = authedSocket();
    gateway.presencePing(socket as never, { taskId: 't-1' });
    gateway.presencePing(socket as never, { taskId: 't-2' });
    expect(socket.toEmitter.emit).toHaveBeenCalledTimes(2);
  });
});

describe('RealtimeGateway.commentTyping — comment composer indicator', () => {
  let gateway: RealtimeGateway;

  beforeEach(() => {
    ({ gateway } = build());
  });

  it('emits comment.typing to the dedicated typing sub-room', () => {
    const socket = authedSocket();
    gateway.commentTyping(socket as never, { taskId: 't-1', state: 'start' });
    expect(socket.to).toHaveBeenCalledWith('comment:t-1:typing');
    expect(socket.toEmitter.emit).toHaveBeenCalledWith(
      'comment.typing',
      expect.objectContaining({ userId: 'u-1', taskId: 't-1', state: 'start' }),
    );
  });

  it('coerces unknown state values to "start"', () => {
    const socket = authedSocket();
    gateway.commentTyping(socket as never, { taskId: 't-1', state: 'gibberish' as never });
    expect(socket.toEmitter.emit).toHaveBeenCalledWith(
      'comment.typing',
      expect.objectContaining({ state: 'start' }),
    );
  });
});

describe('RealtimeGateway.handleDisconnect', () => {
  let gateway: RealtimeGateway;

  beforeEach(() => {
    ({ gateway } = build());
  });

  it('re-broadcasts presence for every project / task room the socket was in', async () => {
    const socket = makeSocket();
    socket.rooms.add('user:u-1'); // ignored — only project:/task: count
    socket.rooms.add('project:p1');
    socket.rooms.add('task:t-1');
    const presenceServer = gateway.server as unknown as {
      to: ReturnType<typeof vi.fn>; presence: RoomEmitter;
    };

    await gateway.handleDisconnect(socket as never);

    expect(presenceServer.to).toHaveBeenCalledWith('project:p1');
    expect(presenceServer.to).toHaveBeenCalledWith('task:t-1');
    expect(presenceServer.presence.emit).toHaveBeenCalledWith(
      'presence', expect.objectContaining({ room: 'project:p1' }),
    );
    expect(presenceServer.presence.emit).toHaveBeenCalledWith(
      'presence', expect.objectContaining({ room: 'task:t-1' }),
    );
  });
});
