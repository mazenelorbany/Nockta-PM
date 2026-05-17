import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { cn } from '@nockta/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import { getSocket } from '../lib/socket';
import { AvatarCircle } from './task-bits';

// =============================================================================
// PresenceAvatars — listens to the `presence` Socket.IO event the gateway
// broadcasts for every room (project:* / task:*) and renders a stack of avatars
// for the users currently viewing this room.
// =============================================================================

interface PresenceUser {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
}

interface UserListResponse {
  items: PresenceUser[];
  nextCursor: string | null;
}

export function PresenceAvatars({
  room,
  size = 24,
  max = 5,
}: {
  /** e.g. "project:abc-uuid" or "task:abc-uuid" */
  room: string;
  size?: number;
  max?: number;
}): JSX.Element | null {
  const [userIds, setUserIds] = useState<string[]>([]);
  const { user: me } = useAuth();

  // We need user names/avatars to render. Pull the user list (cached, used by
  // many other surfaces) and look up by id.
  const usersQuery = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => api.get<UserListResponse>('/users?limit=100'),
  });
  const usersById = new Map((usersQuery.data?.items ?? []).map((u) => [u.id, u]));

  useEffect(() => {
    const socket = getSocket();
    const onPresence = (payload: { room: string; userIds: string[] }): void => {
      if (payload.room === room) {
        setUserIds(payload.userIds);
      }
    };
    socket.on('presence', onPresence);
    return () => {
      socket.off('presence', onPresence);
    };
  }, [room]);

  // Exclude self from the rendered list — we don't need to see our own avatar
  // in the "currently viewing" pill.
  const others = userIds.filter((id) => id !== me?.id);
  if (others.length === 0) return null;

  const visible = others.slice(0, max);
  const extra = others.length - visible.length;

  return (
    <div className="inline-flex items-center" title={`${others.length} other viewer${others.length === 1 ? '' : 's'}`}>
      <div className="flex -space-x-1.5">
        {visible.map((id) => {
          const u = usersById.get(id) ?? { id };
          return (
            <span
              key={id}
              className="ring-2 ring-card rounded-full"
              style={{ width: size, height: size }}
            >
              <AvatarCircle user={u} size={size} />
            </span>
          );
        })}
        {extra > 0 && (
          <span
            className={cn(
              'inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-card font-medium',
            )}
            style={{ width: size, height: size, fontSize: size * 0.4 }}
          >
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}
