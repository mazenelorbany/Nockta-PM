import type { Socket } from 'socket.io-client';

import { API_URL } from './env';
import { useAuth } from './auth-store';

// =============================================================================
// Socket.IO client — lazily loaded.
//
// R9 bundle-shrink: `socket.io-client` ships ~50–70KB gzipped (including
// engine.io-client + polyfills) and was previously eager-imported into the
// shell bundle because `NotificationsBell` and `useNotificationsSurface`
// reach for it at app boot. Switching to `await import('socket.io-client')`
// pushes the whole module into its own chunk that loads in parallel with the
// first authenticated route, off the critical path.
//
// All callers are inside `useEffect` blocks — they already tolerate async
// connection, so the API is exposed as `Promise<Socket>` and the call sites
// `await` it. See `apps/web/src/hooks/usePresence.ts` for the canonical
// "subscribe + cleanup with cancellation" pattern.
// =============================================================================

let socket: Socket | null = null;
let inflight: Promise<Socket> | null = null;

/** Async getter — resolves to a connected Socket. Reuses the cached instance
 *  when available; reconnects automatically if the socket disconnected. */
export async function getSocket(): Promise<Socket> {
  if (socket && socket.connected) return socket;
  if (inflight) return inflight;

  // If we have a stale, disconnected socket, dispose of it before opening a
  // new one — otherwise the old listeners leak and reconnection logic doubles up.
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  inflight = (async (): Promise<Socket> => {
    // Dynamic import — creates a separate chunk that Vite/Rollup splits out
    // of the shell. The first call eats the ~50KB download; subsequent calls
    // hit the module cache and resolve synchronously.
    const { io } = await import('socket.io-client');
    const token = useAuth.getState().tokens?.accessToken;
    const next = io(API_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
    });
    socket = next;
    inflight = null;
    return next;
  })();

  return inflight;
}

export function disconnectSocket(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  inflight = null;
}
