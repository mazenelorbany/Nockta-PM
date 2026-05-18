import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';

import { Env } from '../../config/env';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SessionService } from '../auth/session.service';
import type { AuthenticatedUser, JwtPayload } from '../auth/types';
import type { PermissionsService } from '../permissions/permissions.service';

interface SocketData {
  user?: AuthenticatedUser;
}

/** Minimum spacing between typing.* emits, per user. A noisy client can hammer
 *  keystroke events at 30+ Hz; we throttle the fan-out to one signal every
 *  500ms which is plenty for showing "Alice is typing…" without burning CPU
 *  on every connected socket. The map is intentionally in-process (per gateway
 *  instance) — replicated nodes will each enforce independently, which is fine
 *  because each socket lives on exactly one node. */
export const TYPING_MIN_INTERVAL_MS = 500;

/** Cursor / presence-ping throttle, per (user, task). Clients send a ping every
 *  10s while a task drawer is open. We accept up to one ping every ~3s to
 *  catch the legitimate "user picked up a cursor scrub" case without letting
 *  a buggy client flood. Same in-process map pattern as typing throttling. */
export const PRESENCE_PING_MIN_INTERVAL_MS = 3_000;

@WebSocketGateway({
  cors: { origin: Env.CORS_ORIGINS, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);
  /** Tracks last typing.* emit timestamp per user id, for the 500ms throttle. */
  private readonly lastTypingTs = new Map<string, number>();
  /** Tracks last presence-ping timestamp per (userId, taskId), for the 3s
   *  throttle. Key shape: `${userId}:${taskId}`. */
  private readonly lastPresencePingTs = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly sessions: SessionService,
  ) {}

  /** Returns true if the caller is within the rate-limit window and should be
   *  ignored. Updates the per-user timestamp when allowed through. Exposed for
   *  tests; not part of the gateway's wire surface. */
  private allowTyping(userId: string, now: number = Date.now()): boolean {
    const last = this.lastTypingTs.get(userId) ?? 0;
    if (now - last < TYPING_MIN_INTERVAL_MS) return false;
    this.lastTypingTs.set(userId, now);
    return true;
  }

  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth as { token?: string } | undefined)?.token ??
      this.extractBearer(client.handshake.headers.authorization);
    if (!token) {
      client.disconnect();
      return;
    }
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: Env.JWT_ACCESS_SECRET,
      });
      if (await this.sessions.isJtiRevoked(payload.jti)) {
        client.disconnect();
        return;
      }
      const dbUser = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, kind: true, companyRole: true, archivedAt: true },
      });
      if (!dbUser || dbUser.archivedAt) {
        client.disconnect();
        return;
      }
      const user: AuthenticatedUser = {
        id: dbUser.id,
        email: dbUser.email,
        kind: dbUser.kind,
        companyRole: dbUser.companyRole,
        jti: payload.jti,
      };
      (client.data as SocketData).user = user;
      await client.join(`user:${user.id}`);
    } catch (err) {
      this.logger.warn({ err }, 'socket auth failed');
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    // Re-broadcast presence for every project/task/doc room this socket was in.
    // The Pass I presence sub-room (task:<id>:presence) is included by the
    // task: prefix — it shares the broadcastPresence helper.
    const rooms = [...client.rooms].filter(
      (r) => r.startsWith('project:') || r.startsWith('task:') || r.startsWith('doc:'),
    );
    const user = (client.data as SocketData).user;
    for (const room of rooms) {
      // For presence-specific sub-rooms, also emit a presence.leave so other
      // viewers can drop the avatar immediately. The next broadcastPresence
      // tick will reconcile if our heuristic is wrong.
      if (user && room.endsWith(':presence')) {
        const taskId = room.slice('task:'.length, -':presence'.length);
        this.server.to(room).emit('presence.leave', { userId: user.id, taskId });
      }
      await this.broadcastPresence(room);
    }
  }

  // ---------- room subscriptions ----------

  @SubscribeMessage('project:join')
  async joinProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId: string },
  ): Promise<{ ok: boolean; role?: string }> {
    const user = (client.data as SocketData).user;
    if (!user) return { ok: false };
    const role = await this.permissions.effectiveRole(user, data.projectId);
    if (role === null) return { ok: false };
    const room = `project:${data.projectId}`;
    await client.join(room);
    await this.broadcastPresence(room);
    return { ok: true, role };
  }

  @SubscribeMessage('project:leave')
  async leaveProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId: string },
  ): Promise<void> {
    const room = `project:${data.projectId}`;
    await client.leave(room);
    await this.broadcastPresence(room);
  }

  @SubscribeMessage('task:join')
  async joinTask(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): Promise<{ ok: boolean }> {
    const user = (client.data as SocketData).user;
    if (!user) return { ok: false };
    const task = await this.prisma.task.findUnique({
      where: { id: data.taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) return { ok: false };
    if (!(await this.permissions.canSeeTask(user, task.projectId, task.visibility))) {
      return { ok: false };
    }
    const room = `task:${data.taskId}`;
    await client.join(room);
    await this.broadcastPresence(room);
    return { ok: true };
  }

  @SubscribeMessage('task:leave')
  async leaveTask(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): Promise<void> {
    const room = `task:${data.taskId}`;
    await client.leave(room);
    await this.broadcastPresence(room);
  }

  /**
   * Join a doc room. Used by the Tiptap editor to power the "live collab
   * coming soon" banner — we don't yet exchange CRDT updates, but knowing
   * who's reading the doc is useful enough to wire up now. Permission check
   * mirrors task:join: the doc's parent project must be visible to the user.
   */
  @SubscribeMessage('doc:join')
  async joinDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { docId: string },
  ): Promise<{ ok: boolean }> {
    const user = (client.data as SocketData).user;
    if (!user) return { ok: false };
    const doc = await this.prisma.doc.findUnique({
      where: { id: data.docId },
      select: { projectId: true },
    });
    if (!doc) return { ok: false };
    const role = await this.permissions.effectiveRole(user, doc.projectId);
    if (role === null) return { ok: false };
    const room = `doc:${data.docId}`;
    await client.join(room);
    await this.broadcastPresence(room);
    return { ok: true };
  }

  @SubscribeMessage('doc:leave')
  async leaveDoc(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { docId: string },
  ): Promise<void> {
    const room = `doc:${data.docId}`;
    await client.leave(room);
    await this.broadcastPresence(room);
  }

  /**
   * Join an Import Center run room — admin-only. The room name is
   * `import:<runId>`; admins receive `import.progress` and `import.done`
   * events while the run is live. We intentionally don't broadcast presence
   * here because the room is short-lived and a single admin watching their
   * own run is the only expected client.
   */
  @SubscribeMessage('import:join')
  async joinImport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { runId: string },
  ): Promise<{ ok: boolean }> {
    const user = (client.data as SocketData).user;
    if (!user) return { ok: false };
    if (user.companyRole !== 'Admin') return { ok: false };
    if (!data?.runId) return { ok: false };
    await client.join(`import:${data.runId}`);
    return { ok: true };
  }

  @SubscribeMessage('import:leave')
  async leaveImport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { runId: string },
  ): Promise<void> {
    if (!data?.runId) return;
    await client.leave(`import:${data.runId}`);
  }

  // ---------- presence & typing ----------

  @SubscribeMessage('typing:start')
  typingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): void {
    const user = (client.data as SocketData).user;
    if (!user) return;
    if (!this.allowTyping(user.id)) return;
    client.to(`task:${data.taskId}`).emit('typing.start', { userId: user.id, taskId: data.taskId });
  }

  @SubscribeMessage('typing:stop')
  typingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): void {
    const user = (client.data as SocketData).user;
    if (!user) return;
    // typing.stop is also throttled — a flapping client (start/stop/start) can
    // otherwise still fan out at full speed even with start throttled.
    if (!this.allowTyping(user.id)) return;
    client.to(`task:${data.taskId}`).emit('typing.stop', { userId: user.id, taskId: data.taskId });
  }

  // ---------- Pass I: cursor presence + comment typing (Realtime 8→9) ----

  /**
   * Cursor / presence ping for an open task drawer. Clients send this every
   * 10s while the drawer is open; the gateway re-broadcasts to other viewers
   * of the same task so each client can render "viewing now" avatars with
   * a fresh cursorPosition (used to draw remote cursors over the
   * description / comment composer when we eventually wire it up).
   *
   * The ping carries a `cursorPosition` that's a free-form opaque object —
   * `{ field: 'description' | 'comment'; index: number }` from the current
   * client, but the gateway doesn't inspect it. Throttle is 3s per
   * (user, task) so a client that lost track of its timer can't flood.
   */
  @SubscribeMessage('presence:ping')
  presencePing(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string; cursorPosition?: unknown },
  ): void {
    const user = (client.data as SocketData).user;
    if (!user || !data?.taskId) return;
    const key = `${user.id}:${data.taskId}`;
    const last = this.lastPresencePingTs.get(key) ?? 0;
    const now = Date.now();
    if (now - last < PRESENCE_PING_MIN_INTERVAL_MS) return;
    this.lastPresencePingTs.set(key, now);

    // Broadcast to siblings in the room (NOT echo to the sender). The
    // dedicated `task:<id>:presence` sub-room keeps cursor/heartbeat pings
    // off the high-fan-out `task:<id>` room used for content-update events.
    const room = `task:${data.taskId}:presence`;
    client.to(room).emit('presence.ping', {
      userId: user.id,
      taskId: data.taskId,
      cursorPosition: data.cursorPosition ?? null,
      ts: now,
    });
  }

  /**
   * Join the task's dedicated presence sub-room. Done implicitly when the
   * client first sends a presence ping; we also expose an explicit join so
   * the client can show the viewer list immediately on drawer open without
   * waiting for the first ping. Permission gate piggybacks on the same
   * canSeeTask check used by `task:join`.
   */
  @SubscribeMessage('presence:join')
  async presenceJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): Promise<{ ok: boolean }> {
    const user = (client.data as SocketData).user;
    if (!user || !data?.taskId) return { ok: false };
    const task = await this.prisma.task.findUnique({
      where: { id: data.taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) return { ok: false };
    if (!(await this.permissions.canSeeTask(user, task.projectId, task.visibility))) {
      return { ok: false };
    }
    const room = `task:${data.taskId}:presence`;
    await client.join(room);
    await this.broadcastPresence(room);
    return { ok: true };
  }

  @SubscribeMessage('presence:leave')
  async presenceLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): Promise<void> {
    if (!data?.taskId) return;
    const room = `task:${data.taskId}:presence`;
    const user = (client.data as SocketData).user;
    if (user) {
      // Echo a leave to siblings so they can drop the avatar immediately
      // instead of waiting for the next presence broadcast.
      client.to(room).emit('presence.leave', { userId: user.id, taskId: data.taskId });
    }
    await client.leave(room);
    await this.broadcastPresence(room);
  }

  /**
   * "Alice is typing…" indicator scoped to a task's comment composer. Mirrors
   * the older typing:start/stop pair but lives in its own room so a noisy
   * comments thread doesn't drown out the wider task room's other events.
   *
   * Throttle reuses the 500ms typing window from the existing typing path;
   * a client flapping start/stop can't outpace the same shared budget.
   */
  @SubscribeMessage('comment:typing')
  commentTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string; state: 'start' | 'stop' },
  ): void {
    const user = (client.data as SocketData).user;
    if (!user || !data?.taskId) return;
    if (!this.allowTyping(user.id)) return;
    const room = `comment:${data.taskId}:typing`;
    client.to(room).emit('comment.typing', {
      userId: user.id,
      taskId: data.taskId,
      state: data.state === 'stop' ? 'stop' : 'start',
    });
  }

  /**
   * Explicit join for the typing room. Mirrors presence:join — the client
   * subscribes on drawer open and leaves on close. The room is permission-
   * gated through canSeeTask so a guest who isn't supposed to read the
   * task's comments can't see other people typing in it.
   */
  @SubscribeMessage('comment:typing_join')
  async commentTypingJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): Promise<{ ok: boolean }> {
    const user = (client.data as SocketData).user;
    if (!user || !data?.taskId) return { ok: false };
    const task = await this.prisma.task.findUnique({
      where: { id: data.taskId },
      select: { projectId: true, visibility: true },
    });
    if (!task) return { ok: false };
    if (!(await this.permissions.canSeeTask(user, task.projectId, task.visibility))) {
      return { ok: false };
    }
    await client.join(`comment:${data.taskId}:typing`);
    return { ok: true };
  }

  @SubscribeMessage('comment:typing_leave')
  async commentTypingLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { taskId: string },
  ): Promise<void> {
    if (!data?.taskId) return;
    await client.leave(`comment:${data.taskId}:typing`);
  }

  // ---------- helpers ----------

  async broadcastPresence(room: string): Promise<void> {
    const sockets = await this.server.in(room).fetchSockets();
    const userIds = Array.from(
      new Set(
        sockets
          .map((s) => (s.data as SocketData).user?.id)
          .filter((x): x is string => Boolean(x)),
      ),
    );
    this.server.to(room).emit('presence', { room, userIds });
  }

  private extractBearer(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
    return value;
  }
}
