import { useCallback, useEffect, useRef, useState } from 'react';

import { resolveSwipe } from '../../hooks/useSwipeGesture';

/**
 * Mobile-only tabs shown at the top of the sheet. Desktop renders the side
 * panel directly so the comment thread is visible alongside the form.
 */
export type MobileTab = 'details' | 'activity' | 'subtasks' | 'attachments';

/**
 * State machine for the TaskDetailDrawer's closing animation, mobile tab
 * selection, activity tab selection, and swipe-down-to-dismiss gesture.
 *
 * Returned values are wired up by the drawer orchestrator. The hook owns:
 *   - `closing` + a 200ms timer so the drawer can play its exit transition
 *     before the parent unmounts (asymmetric close — open feels instant,
 *     close has visible feedback).
 *   - `mobileTab` / `activityTab` state.
 *   - The swipe-down-to-close pointer-event handlers. The math itself lives
 *     in `resolveSwipe` (so it can be unit-tested without jsdom). When the
 *     drawer is not in mobile mode the handlers collapse to an empty object
 *     so the JSX wiring stays uniform.
 */
export function useTaskDrawerState({
  isMobile,
  onClose,
}: {
  isMobile: boolean;
  onClose: () => void;
}): {
  closing: boolean;
  requestClose: () => void;
  activityTab: 'comments' | 'activity';
  setActivityTab: (t: 'comments' | 'activity') => void;
  mobileTab: MobileTab;
  setMobileTab: (t: MobileTab) => void;
  dragOffsetY: number;
  dragHandlers: {
    onPointerDown?: (e: React.PointerEvent) => void;
    onPointerMove?: (e: React.PointerEvent) => void;
    onPointerUp?: (e: React.PointerEvent) => void;
    onPointerCancel?: () => void;
  };
} {
  // Asymmetric close: trigger an exit transition (200ms ease-out) before the
  // parent unmounts. Without this, the drawer pops out instantly while the
  // open feels deliberate — Emil's "system response should be quick, but
  // visible" pattern.
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => onClose(), 200);
  }, [closing, onClose]);
  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const [activityTab, setActivityTab] = useState<'comments' | 'activity'>('comments');
  const [mobileTab, setMobileTab] = useState<MobileTab>('details');

  // -------------------------------------------------------------------------
  // Swipe-down-to-close — mobile only. Pointer events on the drawer header
  // track a vertical drag; releasing past ~30px down triggers requestClose.
  // The drawer follows the finger via a translateY style so it feels physical.
  // We use pointer events (not touch) so it works on hybrid devices and is
  // simpler to test in jsdom-free vitest (the math lives in useSwipeGesture).
  // -------------------------------------------------------------------------
  const dragStartRef = useRef<{ y: number; x: number; id: number } | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const dragHandlers = isMobile
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          // Ignore drags that start on interactive elements inside the header.
          const target = e.target as HTMLElement;
          if (target.closest('button, a, input, select, textarea')) return;
          dragStartRef.current = { y: e.clientY, x: e.clientX, id: e.pointerId };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: React.PointerEvent) => {
          const start = dragStartRef.current;
          if (!start || start.id !== e.pointerId) return;
          const dy = Math.max(0, e.clientY - start.y);
          setDragOffsetY(dy);
        },
        onPointerUp: (e: React.PointerEvent) => {
          const start = dragStartRef.current;
          if (!start || start.id !== e.pointerId) {
            setDragOffsetY(0);
            return;
          }
          const outcome = resolveSwipe(
            { dx: e.clientX - start.x, dy: e.clientY - start.y },
            { horizontalThreshold: 9999, verticalThreshold: 30, allowHorizontal: false },
          );
          dragStartRef.current = null;
          setDragOffsetY(0);
          if (outcome.kind === 'down') {
            requestClose();
          }
        },
        onPointerCancel: () => {
          dragStartRef.current = null;
          setDragOffsetY(0);
        },
      }
    : {};

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  return {
    closing,
    requestClose,
    activityTab,
    setActivityTab,
    mobileTab,
    setMobileTab,
    dragOffsetY,
    dragHandlers,
  };
}
