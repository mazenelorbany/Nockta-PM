import { describe, expect, it } from 'vitest';
import { isHorizontalDominant, resolveSwipe } from '../../hooks/useSwipeGesture';

// =============================================================================
// swipe-gesture — pure-function tests.
//
// The frontend vitest config is node-only (no jsdom), so we can't render a
// real <BoardCard> and fire pointer events. Instead we cover the decision
// layer that the card delegates to:
//
//   - resolveSwipe: vector → discrete outcome ({ kind, distance }) — the same
//     function the drawer's swipe-down-to-close and the card's swipe-to-
//     complete / snooze gestures both call into.
//   - isHorizontalDominant: the disambiguation predicate the card uses on
//     pointermove to decide whether to claim the gesture or release it to
//     dnd-kit.
//
// Both pieces are pure, so a regression in the swipe math will surface here
// regardless of which UI surface eventually mounts the listeners.
// =============================================================================

describe('resolveSwipe — direction + threshold', () => {
  it('returns "none" for sub-threshold horizontal motion', () => {
    // 30px is the default vertical threshold but well under horizontal (80px).
    expect(resolveSwipe({ dx: 30, dy: 0 })).toEqual({ kind: 'none' });
    expect(resolveSwipe({ dx: -30, dy: 0 })).toEqual({ kind: 'none' });
  });

  it('fires right swipe past the threshold', () => {
    const out = resolveSwipe({ dx: 90, dy: 10 });
    expect(out.kind).toBe('right');
    if (out.kind === 'right') expect(out.distance).toBe(90);
  });

  it('fires left swipe past the threshold', () => {
    const out = resolveSwipe({ dx: -120, dy: 5 });
    expect(out.kind).toBe('left');
    if (out.kind === 'left') expect(out.distance).toBe(120);
  });

  it('routes a dominantly-vertical drag to vertical outcomes', () => {
    // dy is bigger than dx → vertical axis wins.
    const down = resolveSwipe({ dx: 10, dy: 80 });
    expect(down.kind).toBe('down');
    const up = resolveSwipe({ dx: -2, dy: -50 });
    expect(up.kind).toBe('up');
  });

  it('honours a custom horizontalThreshold', () => {
    // Lift the threshold and the previous "right" no longer fires.
    expect(resolveSwipe({ dx: 90, dy: 0 }, { horizontalThreshold: 100 })).toEqual({ kind: 'none' });
    expect(resolveSwipe({ dx: 110, dy: 0 }, { horizontalThreshold: 100 }).kind).toBe('right');
  });

  it('respects allowHorizontal:false (drawer dismiss mode)', () => {
    // Drawer swipe-down: we only want vertical outcomes, even if horizontal
    // motion happens to dominate at a particular sample.
    const out = resolveSwipe(
      { dx: 100, dy: 50 },
      { allowHorizontal: false, verticalThreshold: 30 },
    );
    // Horizontal not allowed; vertical alone is < threshold once horizontal
    // is excluded — so we fall through to 'none'.
    expect(out.kind).toBe('none');
  });

  it('crosses the 80px threshold for the board card simulation', () => {
    // Simulate the BoardCard pointer trail at 80px sample threshold + small
    // vertical drift (finger never stays perfectly on axis).
    const ptr: Array<{ dx: number; dy: number; expect: string }> = [
      { dx: 10, dy: 2, expect: 'none' },
      { dx: 50, dy: 4, expect: 'none' },
      { dx: 79, dy: 5, expect: 'none' },
      { dx: 81, dy: 6, expect: 'right' },
      { dx: 120, dy: 8, expect: 'right' },
      { dx: -90, dy: 4, expect: 'left' },
    ];
    for (const sample of ptr) {
      expect(resolveSwipe({ dx: sample.dx, dy: sample.dy }).kind).toBe(sample.expect);
    }
  });
});

describe('isHorizontalDominant — dnd-kit handoff predicate', () => {
  it('claims horizontal-dominant motion', () => {
    expect(isHorizontalDominant({ dx: 10, dy: 5 })).toBe(true);
    expect(isHorizontalDominant({ dx: -10, dy: 5 })).toBe(true);
  });

  it('releases vertical-dominant motion to dnd-kit', () => {
    expect(isHorizontalDominant({ dx: 5, dy: 10 })).toBe(false);
    expect(isHorizontalDominant({ dx: 0, dy: -8 })).toBe(false);
  });

  it('applies the slack factor so jitter near the diagonal favours dnd-kit', () => {
    // Default slack is 1.4 — equal dx/dy is rejected.
    expect(isHorizontalDominant({ dx: 5, dy: 5 })).toBe(false);
    // Tight slack lowers the bar — same input now claims horizontal.
    expect(isHorizontalDominant({ dx: 5, dy: 5 }, 0.5)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Pointer-event simulator — exercises the BoardCard's full claim/release flow
// without needing a real DOM. We replay the same pointer state machine the
// component uses and assert that the callback fires once dx crosses 80px.
// -----------------------------------------------------------------------------

interface FakeBoardCardState {
  startX: number;
  startY: number;
  mode: 'claimed' | 'released' | null;
  fired: 'done' | 'snooze' | null;
}

function simulateCardSwipe(
  trail: Array<{ x: number; y: number }>,
  releaseAt: { x: number; y: number },
): FakeBoardCardState {
  const SWIPE_THRESHOLD = 80;
  const SWIPE_REVEAL_TRIGGER = 5;
  const state: FakeBoardCardState = {
    startX: trail[0]?.x ?? 0,
    startY: trail[0]?.y ?? 0,
    mode: null,
    fired: null,
  };
  for (let i = 1; i < trail.length; i++) {
    const p = trail[i]!;
    const dx = p.x - state.startX;
    const dy = p.y - state.startY;
    if (state.mode === null) {
      if (Math.abs(dx) < SWIPE_REVEAL_TRIGGER && Math.abs(dy) < SWIPE_REVEAL_TRIGGER) continue;
      state.mode = isHorizontalDominant({ dx, dy }) ? 'claimed' : 'released';
    }
  }
  if (state.mode === 'claimed') {
    const dx = releaseAt.x - state.startX;
    if (dx > SWIPE_THRESHOLD) state.fired = 'done';
    else if (dx < -SWIPE_THRESHOLD) state.fired = 'snooze';
  }
  return state;
}

describe('BoardCard pointer simulator', () => {
  it('fires "done" when finger crosses +80px to the right', () => {
    const trail = [
      { x: 0, y: 0 },
      { x: 20, y: 2 },
      { x: 60, y: 3 },
      { x: 90, y: 4 },
    ];
    const result = simulateCardSwipe(trail, { x: 95, y: 4 });
    expect(result.mode).toBe('claimed');
    expect(result.fired).toBe('done');
  });

  it('fires "snooze" when finger crosses -80px to the left', () => {
    const trail = [
      { x: 200, y: 0 },
      { x: 180, y: 2 },
      { x: 140, y: 3 },
      { x: 100, y: 4 },
    ];
    const result = simulateCardSwipe(trail, { x: 100, y: 4 });
    expect(result.fired).toBe('snooze');
  });

  it('does not fire when the swipe ends under the threshold', () => {
    const trail = [
      { x: 0, y: 0 },
      { x: 30, y: 2 },
      { x: 60, y: 3 },
    ];
    const result = simulateCardSwipe(trail, { x: 70, y: 3 });
    expect(result.mode).toBe('claimed');
    expect(result.fired).toBeNull();
  });

  it('hands off to dnd-kit for vertical drags (no swipe fire)', () => {
    const trail = [
      { x: 0, y: 0 },
      { x: 2, y: 30 },
      { x: 3, y: 80 },
    ];
    const result = simulateCardSwipe(trail, { x: 3, y: 100 });
    expect(result.mode).toBe('released');
    expect(result.fired).toBeNull();
  });
});
