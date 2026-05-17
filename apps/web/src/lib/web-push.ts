// =============================================================================
// Web Push client.
//
// Wraps the browser Notification + PushManager APIs and exposes:
//   - isSupported()          → can we even attempt this?
//   - getPermission()        → current Notification.permission
//   - requestPermission()    → prompt the user
//   - subscribe()            → fetch VAPID key, subscribe via PushManager,
//                              POST the subscription to the server
//   - unsubscribe()          → tear down the subscription + tell the server
//   - getSubscription()      → return the current PushSubscription if any
//
// The server endpoints live under /notifications/web-push/* (see the API's
// WebPushController).
// =============================================================================

import { api } from './api';

interface VapidResponse {
  publicKey: string;
}

interface SubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export function getPermission(): NotificationPermission | 'unsupported' {
  if (!isSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  const result = await Notification.requestPermission();
  return result;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ?? null;
}

export async function getSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Subscribe this browser to web push.
 *
 * Returns the server-acknowledged subscription on success, or throws with a
 * descriptive error so the UI can render an inline toast.
 *
 * Side effects:
 *   1. Asks the SW registration's PushManager to subscribe (using the
 *      server's VAPID public key).
 *   2. Posts the subscription to /notifications/web-push/subscribe so the
 *      server can deliver pushes to it.
 */
export async function subscribe(): Promise<PushSubscription> {
  if (!isSupported()) throw new Error('Push notifications are not supported in this browser.');
  const reg = await getRegistration();
  if (!reg) throw new Error('Service worker is not registered yet. Reload the page and try again.');

  // Already subscribed? Re-POST to server so a server-side wipe re-registers,
  // then short-circuit.
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    await postSubscriptionToServer(existing);
    return existing;
  }

  const { publicKey } = await api.get<VapidResponse>('/notifications/web-push/vapid-public-key');
  if (!publicKey) throw new Error('Server did not return a VAPID public key.');

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // Cast to BufferSource — TS 5+ narrows the Uint8Array generic which
    // PushManager.subscribe doesn't accept directly.
    applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
  });
  await postSubscriptionToServer(sub);
  return sub;
}

export async function unsubscribe(): Promise<void> {
  const reg = await getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try {
    // Server endpoint accepts POST with the endpoint URL in the body —
    // DELETE with a body is awkward through fetch + the SDK doesn't allow
    // it. The server treats this as semantically equivalent to a DELETE.
    await api.post('/notifications/web-push/unsubscribe', { endpoint: sub.endpoint });
  } catch {
    // Best-effort — even if the server call fails we still tear down the
    // browser-side subscription so the user isn't surprised by lingering pushes.
  }
  await sub.unsubscribe();
}

// ----- helpers ------------------------------------------------------------------

async function postSubscriptionToServer(sub: PushSubscription): Promise<void> {
  const payload = serializeSubscription(sub);
  await api.post('/notifications/web-push/subscribe', payload);
}

function serializeSubscription(sub: PushSubscription): SubscribePayload {
  const json = sub.toJSON();
  const keys = (json.keys ?? {}) as { p256dh?: string; auth?: string };
  if (!json.endpoint || !keys.p256dh || !keys.auth) {
    throw new Error('Push subscription is missing required keys.');
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

/**
 * Convert a base64url-encoded VAPID public key into the Uint8Array PushManager
 * expects. Standard WebPush boilerplate — see MDN's example.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
