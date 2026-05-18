import { useRef, type RefObject } from 'react';

// =============================================================================
// usePullToRefresh — STUBBED.
//
// The PWA pull-to-refresh affordance was removed (GRILL-SUMMARY.md §10 —
// internal-tool scope is desktop browser + in-app + Chat). Returning a no-op
// hook keeps the existing call sites (ProjectBoard, ProjectBacklog,
// ProjectDocs) compiling without us having to touch every page in lockstep.
//
// The hook returns a ref the consumer attaches to its scroll container; the
// state object satisfies what `<PullIndicator>` expected so nothing renders
// when there's no pull gesture.
// =============================================================================

export interface PullState {
  ref: RefObject<HTMLDivElement>;
  pulling: boolean;
  refreshing: boolean;
  progress: number;
}

export interface UsePullToRefreshOptions {
  onRefresh?: () => void | Promise<void>;
}

export function usePullToRefresh(_opts: UsePullToRefreshOptions = {}): PullState {
  const ref = useRef<HTMLDivElement>(null);
  return { ref, pulling: false, refreshing: false, progress: 0 };
}

export function PullIndicator(_props: { state: PullState }): JSX.Element | null {
  return null;
}
