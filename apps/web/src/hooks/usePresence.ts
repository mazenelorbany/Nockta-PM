import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth-store';
import { getSocket } from '../lib/socket';

// =============================================================================
// usePresence — Pass I (Realtime 8 → 9). "Viewing now" + remote cursor stub.
//
// Joins the task's dedicated `task:<id>:presence` sub-room on mount, pings
// every 10 seconds while open, and emits a leave on unmount. Returns:
//
//   activeUserIds   — every user currently in the room (excluding self).
//                     Sourced from the existing `presence` broadcast the
//                     gateway already emits when room membership changes.
//   cursorByUser    — opaque cursor objects keyed by userId. The gateway's
//                     `presence.ping` echo carries a free-form
//                     `cursorPosition` field; we store it verbatim so the
//                     consumer can render remote cursors. Empty object if no
//                     pings have arrived yet.
//   sendPing        — manual ping (e.g. when the user moves their cursor in
//                     the description textarea). Auto-pings every 10s
//                     regardless; this is the immediate-flush escape hatch.
//
// The 10s ping cadence intentionally matches the gateway-side 3s throttle
// budget — the gateway will accept us every 10s without complaint, and a
// short user gesture can fire an immediate ping on top of the timer.
// =============================================================================

export interface PresenceCursor {
  field?: 'description' | 'comment' | string;
  index?: number;
  [key: string]: unknown;
}

const PING_INTERVAL_MS = 10_000;

export function usePresence(taskId: string | null | undefined): {
  activeUserIds: string[];
  cursorByUser: Record<string, PresenceCursor>;
  sendPing: (cursor?: PresenceCursor) => void;
} {
  const { user: me } = useAuth();
  const [activeUserIds, setActiveUserIds] = useState<string[]>([]);
  const [cursorByUser, setCursorByUser] = useState<Record<string, PresenceCursor>>({});
  // Keep the latest cursor in a ref so the interval can read it without
  // re-creating the timer every render.
  const lastCursorRef = useRef<PresenceCursor | undefined>(undefined);

  useEffect(() => {
    if (!taskId) return undefined;
    const socket = getSocket();
    const presenceRoom = `task:${taskId}:presence`;

    // Listeners — both attached BEFORE we emit join so we never miss the
    // first broadcast.
    function onPresence(payload: { room: string; userIds: string[] }): void {
      if (payload.room !== presenceRoom) return;
      setActiveUserIds(payload.userIds.filter((id) => id !== me?.id));
    }
    function onPing(payload: { userId: string; taskId: string; cursorPosition: PresenceCursor | null }): void {
      if (payload.taskId !== taskId) return;
      if (payload.userId === me?.id) return; // never echo self
      setCursorByUser((prev) => ({
        ...prev,
        [payload.userId]: payload.cursorPosition ?? {},
      }));
    }
    function onLeave(payload: { userId: string; taskId: string }): void {
      if (payload.taskId !== taskId) return;
      setActiveUserIds((prev) => prev.filter((id) => id !== payload.userId));
      setCursorByUser((prev) => {
        if (!(payload.userId in prev)) return prev;
        const next = { ...prev };
        delete next[payload.userId];
        return next;
      });
    }
    socket.on('presence', onPresence);
    socket.on('presence.ping', onPing);
    socket.on('presence.leave', onLeave);

    // Join the presence sub-room. The gateway responds with an initial
    // `presence` broadcast carrying the current viewer set.
    socket.emit('presence:join', { taskId });

    // Auto-ping every 10s. We send the last-known cursor as a courtesy so a
    // user who hasn't moved still shows up as "active" in the viewer list.
    const interval = setInterval(() => {
      socket.emit('presence:ping', {
        taskId,
        cursorPosition: lastCursorRef.current ?? null,
      });
    }, PING_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      socket.emit('presence:leave', { taskId });
      socket.off('presence', onPresence);
      socket.off('presence.ping', onPing);
      socket.off('presence.leave', onLeave);
      setActiveUserIds([]);
      setCursorByUser({});
    };
  }, [taskId, me?.id]);

  const sendPing = (cursor?: PresenceCursor): void => {
    if (!taskId) return;
    lastCursorRef.current = cursor;
    getSocket().emit('presence:ping', { taskId, cursorPosition: cursor ?? null });
  };

  return { activeUserIds, cursorByUser, sendPing };
}

// =============================================================================
// useCommentTyping — "Alice is typing…" indicator for the comment composer.
// Joins the dedicated typing sub-room and exposes the set of currently-typing
// userIds. Returns a `notifyTyping` callback the composer can fire on every
// keystroke (the gateway throttles per user, so we don't have to debounce
// client-side aggressively).
// =============================================================================

export function useCommentTyping(taskId: string | null | undefined): {
  typingUserIds: string[];
  notifyTyping: (state: 'start' | 'stop') => void;
} {
  const { user: me } = useAuth();
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  // Drop a typing user after 5s of silence — the gateway throttles emits to
  // every 500ms so the lack of a ping for 5s means they stopped (or left).
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!taskId) return undefined;
    const socket = getSocket();

    function onTyping(payload: { userId: string; taskId: string; state: 'start' | 'stop' }): void {
      if (payload.taskId !== taskId) return;
      if (payload.userId === me?.id) return;

      // Clear any existing auto-clear timer for this user.
      const existing = timeoutsRef.current.get(payload.userId);
      if (existing) clearTimeout(existing);

      if (payload.state === 'stop') {
        setTypingUserIds((prev) => prev.filter((id) => id !== payload.userId));
        timeoutsRef.current.delete(payload.userId);
        return;
      }

      setTypingUserIds((prev) => (prev.includes(payload.userId) ? prev : [...prev, payload.userId]));
      const timer = setTimeout(() => {
        setTypingUserIds((prev) => prev.filter((id) => id !== payload.userId));
        timeoutsRef.current.delete(payload.userId);
      }, 5_000);
      timeoutsRef.current.set(payload.userId, timer);
    }

    socket.on('comment.typing', onTyping);
    socket.emit('comment:typing_join', { taskId });

    return () => {
      socket.off('comment.typing', onTyping);
      socket.emit('comment:typing_leave', { taskId });
      for (const t of timeoutsRef.current.values()) clearTimeout(t);
      timeoutsRef.current.clear();
      setTypingUserIds([]);
    };
  }, [taskId, me?.id]);

  function notifyTyping(state: 'start' | 'stop'): void {
    if (!taskId) return;
    getSocket().emit('comment:typing', { taskId, state });
  }

  return { typingUserIds, notifyTyping };
}
