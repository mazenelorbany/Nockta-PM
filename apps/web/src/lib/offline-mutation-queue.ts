// =============================================================================
// offline-mutation-queue — STUBBED.
//
// The PWA / offline mutation queue was removed (GRILL-SUMMARY.md §10 — Web
// Push + PWA shell). The app is now an internal tool that never claims to
// work offline, so `enqueue()` is a no-op kept only so the remaining call
// site in useOfflineMutations doesn't have to be ripped out.
// =============================================================================

interface QueuedMutation {
  method: string;
  url: string;
  body?: unknown;
  meta?: Record<string, unknown>;
}

export async function enqueue(_m: QueuedMutation): Promise<void> {
  // No-op.
}
