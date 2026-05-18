import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { api } from './api';
import { getSocket } from './socket';

interface NotificationCreated {
  notificationId: string;
  type: string;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
}

/**
 * Singleton notification surface: tab-title pulse + browser toast.
 *
 * Mount this once at the app shell. It owns the `unread-count` poll and a
 * socket listener for fresh notifications, then:
 *   1. Prefixes document.title with `(N)` while there are unread items so the
 *      browser tab badge updates even when the user is on another tab.
 *   2. Fires a Web Notifications API toast (subject to permission) every time
 *      `notification.created` arrives. Suppressed when the tab is in the
 *      foreground — the in-app bell is enough there.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SCOPE DECISION — why this isn't "Web Push" (VAPID + service worker).
 *
 * The spec (§10) lists three notification channels: in-app, Google Chat DM,
 * and email (the last removed in §10). True Web Push — the kind that wakes
 * a service worker and shows a system toast EVEN WHEN THE TAB IS CLOSED —
 * is deliberately NOT in the channel list. Building it would require:
 *
 *   - VAPID keypair generation + private-key storage on the API
 *   - PushSubscription DB model + subscribe/unsubscribe endpoints
 *   - A `web-push` server SDK to publish to subscription endpoints
 *   - A service worker on the frontend to receive + render pushes
 *   - Per-browser endpoint quirks (Mozilla, Google, Apple all differ)
 *
 * The lighter alternative implemented here — the Web Notifications API
 * driven by an open socket — covers the realistic use case ("I switched
 * tabs to read Slack, ping me when the build breaks"). It does NOT cover
 * "ping me an hour after I close my laptop" — but we don't promise that
 * anywhere in the product. Revisit if the requirement changes.
 * ──────────────────────────────────────────────────────────────────────────
 */
export function useNotificationsSurface(): void {
  const queryClient = useQueryClient();

  const unreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
  });
  const unread = unreadQuery.data?.count ?? 0;

  // ---- Document title pulse ----
  const originalTitleRef = useRef<string>('');
  useEffect(() => {
    // Capture the original title once on mount. The first useEffect run reads
    // whatever was set by index.html or react-helmet earlier; subsequent runs
    // restore that string so we don't accumulate "(3) (5) Nockta" prefixes.
    if (!originalTitleRef.current) {
      originalTitleRef.current = document.title.replace(/^\(\d+\)\s*/, '');
    }
    const base = originalTitleRef.current || 'Nockta Flow';
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${base}` : base;
  }, [unread]);

  // Always restore the clean title when this hook unmounts (e.g. on logout
  // navigating to /login which doesn't render the shell).
  useEffect(() => {
    return () => {
      const base = originalTitleRef.current || 'Nockta Flow';
      document.title = base;
    };
  }, []);

  // ---- Socket-driven invalidation + browser push ----
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    function onCreated(ev: NotificationCreated): void {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });

      // Only fire a desktop toast if the user explicitly opted in AND the tab
      // is hidden. Showing a system toast while the bell is one click away
      // feels redundant; we only surface them when the user has switched away.
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        document.visibilityState !== 'visible' &&
        localStorage.getItem('nockta.browser-push') === 'on'
      ) {
        try {
          const n = new Notification('Nockta Flow', {
            body: prettyType(ev.type),
            tag: ev.notificationId, // de-dupe burst events to one toast
            icon: '/favicon.svg',
            data: ev,
          });
          n.onclick = () => {
            window.focus();
            if (ev.relatedTaskId && ev.relatedProjectId) {
              window.location.href = `/projects/${ev.relatedProjectId}/board?task=${ev.relatedTaskId}`;
            } else {
              window.location.href = '/inbox';
            }
            n.close();
          };
        } catch {
          // Some browsers throw on construct in private mode — ignore.
        }
      }
    }
    void (async () => {
      const socket = await getSocket();
      if (cancelled) return;
      socket.on('notification.created', onCreated);
      cleanup = () => { socket.off('notification.created', onCreated); };
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [queryClient]);
}

function prettyType(t: string): string {
  return t.replace(/([A-Z])/g, ' $1').replace(/^_/, '').trim().toLowerCase();
}

/**
 * Convenience for the settings UI: prompts the user for browser-notifications
 * permission and remembers the opt-in flag in localStorage. The flag is
 * separate from `Notification.permission` so a user can mute the in-app
 * preference without having to revoke browser permission too.
 */
export async function enableBrowserNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') {
    localStorage.setItem('nockta.browser-push', 'on');
    return 'granted';
  }
  if (Notification.permission === 'denied') return 'denied';
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    localStorage.setItem('nockta.browser-push', 'on');
  }
  return result;
}

export function disableBrowserNotifications(): void {
  localStorage.setItem('nockta.browser-push', 'off');
}

export function browserNotificationsEnabled(): boolean {
  if (typeof Notification === 'undefined') return false;
  return Notification.permission === 'granted' &&
    localStorage.getItem('nockta.browser-push') === 'on';
}
