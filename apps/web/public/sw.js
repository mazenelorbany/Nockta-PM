/* eslint-disable no-restricted-globals, no-undef */
// =============================================================================
// Nockta Flow service worker
//
// Hand-rolled because we don't want to take a hard dep on workbox-* in the
// monorepo until vite-plugin-pwa is wired up. Mirrors the three Workbox
// strategies we'd otherwise use:
//
//   1. Precache the shell on install: index.html + manifest + logo.
//   2. Cache-first for /assets/* (Vite hashes filenames so cache-first is
//      safe; we cap the cache at 30 days / 60 entries to keep storage sane).
//   3. Network-first for /api/v1/* with a 5s timeout — when offline the
//      stale cached response keeps the UI rendering instead of a hard error.
//
// Future: when we add vite-plugin-pwa, swap the SHELL_ASSETS array for
//   self.__WB_MANIFEST and use workbox-precaching's precacheAndRoute.
// =============================================================================

const SW_VERSION = 'v1';
const SHELL_CACHE = `nockta-shell-${SW_VERSION}`;
const ASSET_CACHE = `nockta-assets-${SW_VERSION}`;
const API_CACHE = `nockta-api-${SW_VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/Nockta%20logo%20icon.avif',
];

const ASSET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ASSET_MAX_ENTRIES = 60;
const API_NETWORK_TIMEOUT_MS = 5000;

// ----- install: precache shell --------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

// ----- activate: nuke old caches ------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => ![SHELL_CACHE, ASSET_CACHE, API_CACHE].includes(k))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ----- fetch: route to the right strategy --------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only — cross-origin requests (Google Fonts, etc.) fall through
  // to the browser's default handling so we don't accidentally cache 3p assets.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/v1/')) {
    event.respondWith(networkFirstWithTimeout(req, API_CACHE, API_NETWORK_TIMEOUT_MS));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstWithRefresh(req, ASSET_CACHE));
    return;
  }

  // Navigation requests fall back to the cached shell when offline so the
  // SPA continues to bootstrap and the React app can render its own
  // offline-aware UI.
  if (req.mode === 'navigate') {
    event.respondWith(navigationHandler(req));
  }
});

// ----- strategies ---------------------------------------------------------------

async function networkFirstWithTimeout(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetchWithTimeout(request, timeoutMs);
    // Only cache successful GET responses; opaque/4xx/5xx don't help us offline.
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone()).catch(() => undefined);
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Last-ditch: return a synthetic offline JSON so the UI gets a structured
    // error rather than a network-failure exception.
    return new Response(
      JSON.stringify({ error: 'offline', message: 'You are offline.' }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    );
  }
}

async function cacheFirstWithRefresh(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    const cachedAt = Number(cached.headers.get('sw-cached-at') || 0);
    if (Date.now() - cachedAt < ASSET_MAX_AGE_MS) {
      return cached;
    }
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cloned = await stampCachedAt(response.clone());
      cache.put(request, cloned).catch(() => undefined);
      void trimCache(cache, ASSET_MAX_ENTRIES);
    }
    return response;
  } catch {
    if (cached) return cached;
    throw new Error('asset offline and not in cache');
  }
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match(request)) || (await cache.match('/index.html'));
    if (cached) return cached;
    return new Response('<h1>Offline</h1><p>Reconnect to load Nockta Flow.</p>', {
      status: 503,
      headers: { 'content-type': 'text/html' },
    });
  }
}

// ----- helpers ------------------------------------------------------------------

function fetchWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), timeoutMs);
    fetch(request).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function stampCachedAt(response) {
  const headers = new Headers(response.headers);
  headers.set('sw-cached-at', String(Date.now()));
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const overflow = keys.length - maxEntries;
  for (let i = 0; i < overflow; i++) {
    await cache.delete(keys[i]);
  }
}

// ----- push notifications -------------------------------------------------------
// Web Push payloads arrive here. Server payload shape:
//   { title, body, icon?, url?, tag? }
// We surface them as system notifications; clicking jumps back into the SPA
// at the payload.url (defaulting to /).
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Nockta Flow', body: event.data.text() };
  }
  const title = payload.title || 'Nockta Flow';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag,
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of all) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) {
            try {
              client.navigate(target);
            } catch {
              /* ignore */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
