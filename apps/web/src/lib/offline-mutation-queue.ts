// =============================================================================
// offline-mutation-queue — STUBBED.
//
// The PWA / offline mutation queue was removed (GRILL-SUMMARY.md §10 — Web
// Push + PWA shell). The remaining call sites (e.g. TaskDetailDrawer) used to
// stash mutations into IndexedDB when navigator.onLine was false; the app is
// now an internal tool that never claims to work offline, so `enqueue()` is a
// no-op and `installAutoDrain` returns a teardown that does nothing.
//
// Kept as a module instead of deleted so we don't have to chase down every
// remaining import. The shapes match what the old call sites expected.
// =============================================================================

export interface QueuedMutation {
  method: string;
  url: string;
  body?: unknown;
  meta?: Record<string, unknown>;
}

export interface DrainResult {
  drained: QueuedMutation[];
  conflicts: QueuedMutation[];
}

export async function enqueue(_m: QueuedMutation): Promise<void> {
  // No-op. The drawer's offline branch only fires when navigator.onLine ===
  // false, which the simplified useOnline hook never reports anyway.
}

export function installAutoDrain(
  _executor: (m: QueuedMutation) => Promise<Response>,
  _onResult?: (r: DrainResult) => void,
): () => void {
  return () => undefined;
}
