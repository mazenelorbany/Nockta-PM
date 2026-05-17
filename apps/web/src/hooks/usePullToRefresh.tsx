import { useEffect, useRef, useState } from 'react';

// =============================================================================
// usePullToRefresh
//
// Touch-driven pull-to-refresh for mobile views. Attach the returned `ref`
// to the SCROLLABLE container (the one with overflow-y-auto). When the user
// pulls down past the threshold while the container is already at the top,
// we trigger the `onRefresh` callback and animate the indicator back up.
//
// Implementation notes:
//   - Only active when the container's scrollTop is 0 at touchstart. This
//     means we never fight native scroll inside the page.
//   - "Rubber-band" feel: the offset we expose follows touchmove with a
//     damping factor so the indicator slows as the user pulls further.
//   - Threshold is 60px by default (rev'd against iOS Safari's intrinsic
//     bounce so the trigger doesn't fight overscroll).
//   - The hook is a no-op on non-touch devices (no listeners installed) so
//     desktop users never accidentally trigger a refresh.
// =============================================================================

export interface PullToRefreshOptions {
  /** Called when the user releases past the threshold. May return a Promise. */
  onRefresh: () => void | Promise<unknown>;
  /** Pixels of pull required to trigger refresh. Default 60. */
  threshold?: number;
  /** Disable the hook entirely (e.g. when offline). */
  disabled?: boolean;
}

export interface PullToRefreshState {
  /** Attach this to your scrollable container. */
  ref: React.RefObject<HTMLDivElement>;
  /** Current pull offset in px (post-damping). 0 when idle. */
  pull: number;
  /** True while onRefresh is in flight. */
  refreshing: boolean;
  /** True when pull >= threshold so the indicator can show "release to refresh". */
  armed: boolean;
}

export function usePullToRefresh(opts: PullToRefreshOptions): PullToRefreshState {
  const threshold = opts.threshold ?? 60;
  const ref = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Mutable bag so the touch handlers don't re-bind every render.
  const state = useRef<{
    startY: number;
    active: boolean;
    armed: boolean;
  }>({ startY: 0, active: false, armed: false });

  useEffect(() => {
    if (opts.disabled) return;
    const el = ref.current;
    if (!el) return;
    // Bail on non-touch devices — no need to install listeners that will never fire.
    if (typeof window === 'undefined' || !('ontouchstart' in window)) return;

    function onTouchStart(e: TouchEvent): void {
      if (refreshing) return;
      if (el!.scrollTop > 0) return;
      const t = e.touches[0];
      if (!t) return;
      state.current.startY = t.clientY;
      state.current.active = true;
      state.current.armed = false;
    }

    function onTouchMove(e: TouchEvent): void {
      if (!state.current.active) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - state.current.startY;
      if (dy <= 0) {
        setPull(0);
        return;
      }
      // Cancel the touch if the container is scrolled — happens when the
      // user starts at top, pulls down a bit, then scrolls within the page.
      if (el!.scrollTop > 0) {
        state.current.active = false;
        setPull(0);
        return;
      }
      // Rubber-band damping: the further you pull, the harder it gets.
      // Pulling 200px in the finger frame yields ~100px on screen.
      const damped = Math.min(dy * 0.5, threshold * 1.8);
      state.current.armed = damped >= threshold;
      setPull(damped);
      // Prevent the browser from also vertically bouncing the page so the
      // gesture feels owned by the hook. Only call when we're actually
      // controlling the gesture (dy > 0 && at top).
      if (e.cancelable) e.preventDefault();
    }

    function onTouchEnd(): void {
      if (!state.current.active) return;
      state.current.active = false;
      const armed = state.current.armed;
      state.current.armed = false;
      if (!armed) {
        setPull(0);
        return;
      }
      // Trigger refresh. Keep the indicator pinned at threshold while in flight.
      setPull(threshold);
      setRefreshing(true);
      Promise.resolve(opts.onRefresh())
        .catch(() => undefined)
        .finally(() => {
          setRefreshing(false);
          setPull(0);
        });
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [opts, opts.disabled, threshold, refreshing]);

  return {
    ref,
    pull,
    refreshing,
    armed: pull >= threshold,
  };
}

/**
 * Tiny visual helper — render this above your scrollable content with the
 * pull state to get a free indicator. The component is intentionally
 * minimal; callers can also build their own using the raw `pull` value.
 */
export function PullIndicator({
  state,
}: {
  state: Pick<PullToRefreshState, 'pull' | 'refreshing' | 'armed'>;
}): JSX.Element | null {
  if (state.pull <= 0 && !state.refreshing) return null;
  return (
    <div
      aria-hidden="true"
      style={{ height: Math.max(state.pull, state.refreshing ? 48 : 0) }}
      className="sm:hidden flex items-end justify-center overflow-hidden text-muted-foreground"
    >
      <div className="pb-2 flex items-center gap-2 text-xs">
        <span
          className={
            state.refreshing
              ? 'inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent'
              : 'inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent transition-transform'
          }
          style={{
            transform: state.refreshing
              ? undefined
              : `rotate(${Math.min(state.pull * 4, 360)}deg)`,
          }}
        />
        <span>{state.refreshing ? 'Refreshing…' : state.armed ? 'Release to refresh' : 'Pull to refresh'}</span>
      </div>
    </div>
  );
}
