import { io, type Socket } from 'socket.io-client';
import { API_URL } from './env';
import { useAuth } from './auth-store';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket && socket.connected) return socket;
  // If we have a stale, disconnected socket, dispose of it before opening a new
  // one — otherwise the old listeners leak and reconnection logic doubles up.
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  const token = useAuth.getState().tokens?.accessToken;
  socket = io(API_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
  });
  return socket;
}

export function disconnectSocket(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}
