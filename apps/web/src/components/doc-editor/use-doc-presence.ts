import { useEffect, useState } from 'react';

import { useAuth } from '../../lib/auth-store';
import { getSocket } from '../../lib/socket';

// =============================================================================
// Presence hook — minimal Socket.IO presence subscription scoped to a doc room.
// =============================================================================

export function useDocPresence(docId: string | undefined): { otherUserCount: number } {
  const [userIds, setUserIds] = useState<string[]>([]);
  const { user: me } = useAuth();

  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const room = `doc:${docId}`;
    const onPresence = (payload: { room: string; userIds: string[] }): void => {
      if (payload.room === room) setUserIds(payload.userIds);
    };
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      socket.emit('doc:join', { docId });
      socket.on('presence', onPresence);
      cleanup = () => {
        socket.emit('doc:leave', { docId });
        socket.off('presence', onPresence);
      };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [docId]);

  const others = userIds.filter((id) => id !== me?.id);
  return { otherUserCount: others.length };
}
