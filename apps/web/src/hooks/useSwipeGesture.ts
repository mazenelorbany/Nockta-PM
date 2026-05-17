// =============================================================================
// useSwipeGesture — pure-function helper used by the swipe-to-complete card
// gesture and the mobile drawer dismiss gesture.
//
// We deliberately separate the pointer math from the React surface so the
// thresholds + direction-resolution logic are testable in node-only vitest
// (no jsdom required). The React component owns its pointer listeners and
// state; this module just answers "given the current vector, what should we
// do?".
//
// `resolveSwipe` lives here so both ProjectBoardPage's card and the mobile
// drawer header can call into the same decision tree, and the test suite
// can hit it directly with synthesized vectors.
// =============================================================================

export interface SwipeVector {
  dx: number;
  dy: number;
}

export type SwipeOutcome =
  | { kind: 'none' }
  | { kind: 'right'; distance: number }
  | { kind: 'left'; distance: number }
  | { kind: 'down'; distance: number }
  | { kind: 'up'; distance: number };

export interface SwipeOptions {
  /** Minimum horizontal distance (px) before a left/right swipe registers. */
  horizontalThreshold?: number;
  /** Minimum vertical distance (px) before an up/down swipe registers. */
  verticalThreshold?: number;
  /** Disable axes you don't want. */
  allowHorizontal?: boolean;
  allowVertical?: boolean;
}

/**
 * Classify a pointer drag vector into a discrete swipe outcome.
 *
 * Rules:
 *   - Whichever axis dominates wins. If |dx| > |dy| → horizontal swipe.
 *   - Below threshold → 'none'.
 *   - Sign of the dominant axis chooses the direction.
 */
export function resolveSwipe(v: SwipeVector, opts: SwipeOptions = {}): SwipeOutcome {
  const hThreshold = opts.horizontalThreshold ?? 80;
  const vThreshold = opts.verticalThreshold ?? 30;
  const allowH = opts.allowHorizontal ?? true;
  const allowV = opts.allowVertical ?? true;
  const absDx = Math.abs(v.dx);
  const absDy = Math.abs(v.dy);

  // Whichever axis dominates wins — but only if that axis is allowed. When the
  // caller has disabled an axis (e.g. drawer dismiss only wants vertical), a
  // drag dominated by the *forbidden* axis resolves to 'none' instead of
  // falling through and firing on the secondary one. That keeps the gesture
  // semantics predictable: "swipe down" never fires on a left/right wiggle.
  if (absDx >= absDy) {
    if (!allowH) return { kind: 'none' };
    if (absDx < hThreshold) return { kind: 'none' };
    return v.dx > 0
      ? { kind: 'right', distance: absDx }
      : { kind: 'left', distance: absDx };
  }
  if (!allowV) return { kind: 'none' };
  if (absDy < vThreshold) return { kind: 'none' };
  return v.dy > 0
    ? { kind: 'down', distance: absDy }
    : { kind: 'up', distance: absDy };
}

/**
 * Decide whether a small drag vector should be claimed by a swipe handler
 * vs. let through to a sibling drag-and-drop sensor.
 *
 * Used by the board card so vertical motion routes to dnd-kit (reordering
 * within a column) while horizontal motion routes to the swipe-to-complete /
 * snooze gesture.
 */
export function isHorizontalDominant(v: SwipeVector, slack = 1.4): boolean {
  return Math.abs(v.dx) > Math.abs(v.dy) * slack;
}
