// =============================================================================
// Offline mutation queue.
//
// When the browser is offline (navigator.onLine === false), inline edits in
// the TaskDetailDrawer enqueue themselves here instead of going to the
// network. On `online` we drain the queue oldest-first; 409 (version
// mismatch) bubbles to the caller as a conflict so the UI can prompt a
// refresh.
//
// Storage: we use a thin IndexedDB wrapper rather than idb-keyval to avoid
// the workspace dep. The wrapper exposes get/put/delete/all so the test
// suite can substitute an in-memory implementation without faking the full
// IndexedDB API surface.
// =============================================================================

export interface QueuedMutation {
  /** Unique id — auto-generated if not supplied. */
  id: string;
  /** HTTP method, e.g. 'PATCH'. */
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Absolute path including /api/v1 prefix, e.g. '/api/v1/tasks/:id'. */
  url: string;
  /** Optional JSON body. */
  body?: unknown;
  /** Optional metadata for the UI: which task this targets, etc. */
  meta?: { taskId?: string; label?: string };
  /** epoch ms when enqueued. */
  enqueuedAt: number;
}

/**
 * The low-level driver. The default uses IndexedDB; tests inject an
 * in-memory map to avoid pulling in fake-indexeddb.
 */
export interface QueueDriver {
  all(): Promise<QueuedMutation[]>;
  put(m: QueuedMutation): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'nockta-offline';
const DB_VERSION = 1;
const STORE_NAME = 'mutations';

function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE_NAME, mode);
        const store = t.objectStore(STORE_NAME);
        let result!: T;
        fn(store).then((r) => {
          result = r;
        });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const idbDriver: QueueDriver = {
  async all() {
    if (!isIdbAvailable()) return [];
    return tx('readonly', (store) =>
      new Promise<QueuedMutation[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const rows = (req.result as QueuedMutation[]).slice();
          rows.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
          resolve(rows);
        };
        req.onerror = () => reject(req.error);
      }),
    );
  },
  async put(m: QueuedMutation) {
    if (!isIdbAvailable()) return;
    await tx('readwrite', (store) =>
      new Promise<void>((resolve, reject) => {
        const req = store.put(m);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
    );
  },
  async delete(id: string) {
    if (!isIdbAvailable()) return;
    await tx('readwrite', (store) =>
      new Promise<void>((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
    );
  },
  async clear() {
    if (!isIdbAvailable()) return;
    await tx('readwrite', (store) =>
      new Promise<void>((resolve, reject) => {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }),
    );
  },
};

/**
 * In-memory queue driver — used in tests, and as a fallback when IDB is
 * unavailable (e.g. SSR, private mode in some browsers).
 */
export function createMemoryDriver(): QueueDriver {
  const map = new Map<string, QueuedMutation>();
  return {
    async all() {
      return Array.from(map.values()).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    },
    async put(m) {
      map.set(m.id, m);
    },
    async delete(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}

let driver: QueueDriver = isIdbAvailable() ? idbDriver : createMemoryDriver();

/** Override the driver — used by tests; do not call from app code. */
export function __setDriverForTests(d: QueueDriver): void {
  driver = d;
}

let idCounter = 0;

function makeId(): string {
  // Crypto.randomUUID where available; otherwise a monotonic fallback so
  // ordering remains stable even under fake timers.
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
  idCounter += 1;
  return `q-${Date.now()}-${idCounter}`;
}

/**
 * Enqueue a mutation for later replay. Returns the resolved row (with `id`
 * and `enqueuedAt` filled in) so callers can show a "queued for sync" toast
 * that references it.
 */
export async function enqueue(input: Omit<QueuedMutation, 'id' | 'enqueuedAt'> & {
  id?: string;
  enqueuedAt?: number;
}): Promise<QueuedMutation> {
  // Conditional spread on `meta` so we don't assign `undefined` under
  // tsconfig's exactOptionalPropertyTypes.
  const row: QueuedMutation = {
    id: input.id ?? makeId(),
    method: input.method,
    url: input.url,
    body: input.body,
    enqueuedAt: input.enqueuedAt ?? Date.now(),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
  await driver.put(row);
  return row;
}

/** Return queued items oldest-first. */
export async function list(): Promise<QueuedMutation[]> {
  return driver.all();
}

/** Drop everything — used by Settings → debug or by integration tests. */
export async function clear(): Promise<void> {
  await driver.clear();
}

export interface DrainResult {
  /** Mutations that succeeded and were removed from the queue. */
  drained: QueuedMutation[];
  /** Mutations that hit a 409 (version mismatch) — left in the queue. */
  conflicts: QueuedMutation[];
  /** Mutations that hit a transient/network error — left in the queue. */
  failed: QueuedMutation[];
}

/**
 * Drain the queue. Each row is replayed via the supplied `executor`; rows
 * that succeed (any 2xx) are removed, rows that hit a 409 are reported as
 * conflicts (the queue keeps them so the user can decide; the UI typically
 * shows a "refresh and retry" toast), and rows that fail with a transient
 * error stay queued for the next online event.
 *
 * Stops draining on the first transient failure so we don't hammer a flaky
 * connection with the rest of the queue.
 */
export async function drain(
  executor: (m: QueuedMutation) => Promise<Response>,
): Promise<DrainResult> {
  const all = await driver.all();
  const result: DrainResult = { drained: [], conflicts: [], failed: [] };
  for (const m of all) {
    try {
      const res = await executor(m);
      if (res.status === 409) {
        result.conflicts.push(m);
        continue;
      }
      if (res.ok) {
        await driver.delete(m.id);
        result.drained.push(m);
        continue;
      }
      // 4xx other than 409 — the request is malformed; drop it from the
      // queue to avoid blocking the rest of the drain. Caller logs.
      if (res.status >= 400 && res.status < 500) {
        await driver.delete(m.id);
        result.failed.push(m);
        continue;
      }
      // 5xx — keep the mutation and stop draining; retry next time online
      // fires.
      result.failed.push(m);
      break;
    } catch {
      // Network error mid-drain. Keep the rest queued and abort.
      result.failed.push(m);
      break;
    }
  }
  return result;
}

/**
 * Wire up the auto-drain. Returns a teardown function. The executor closure
 * is supplied by the caller so tests can inject a stub and the React layer
 * can route the replay through its real api client (with auth headers).
 */
export function installAutoDrain(
  executor: (m: QueuedMutation) => Promise<Response>,
  onResult?: (r: DrainResult) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let inFlight = false;
  const handler = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await drain(executor);
      onResult?.(r);
    } finally {
      inFlight = false;
    }
  };
  window.addEventListener('online', handler);
  return () => window.removeEventListener('online', handler);
}
