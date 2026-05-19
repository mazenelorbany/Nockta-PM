import { useLayoutEffect, useMemo, useState } from 'react';

// =============================================================================
// virtualizer — lightweight vertical list virtualizer.
//
// We deliberately hand-roll this instead of pulling in @tanstack/react-virtual
// because:
//   1. We only need vertical, fixed-estimate, single-list virtualization for
//      board columns. The library is ~6 KB gzipped + brings 4 hooks and
//      a measurement layer we don't need yet.
//   2. We avoid an `npm install` step the parent agent would have to surface.
//      If we hit more virtualization needs (timeline, calendar) we'll swap to
//      the library.
//
// API mirrors `useVirtualizer` from @tanstack/react-virtual so the swap is
// drop-in if/when we install it: `useVirtualizer({ count, estimateSize,
// getScrollElement, overscan })` returns `{ getVirtualItems, getTotalSize }`.
// =============================================================================

interface UseVirtualizerOptions {
  count: number;
  estimateSize: () => number;
  getScrollElement: () => HTMLElement | null;
  overscan?: number;
}

export interface VirtualItem {
  index: number;
  start: number;
  size: number;
  key: number;
}

export interface VirtualizerApi {
  getVirtualItems: () => VirtualItem[];
  getTotalSize: () => number;
  /** Current scrollTop of the scroll element. Surface for tests/debugging. */
  scrollOffset: number;
}

export function useVirtualizer(opts: UseVirtualizerOptions): VirtualizerApi {
  const { count, estimateSize, getScrollElement, overscan = 5 } = opts;
  const [scrollOffset, setScrollOffset] = useState(0);
  const [viewportSize, setViewportSize] = useState(0);

  // Resolve the scroll element + wire scroll listener + ResizeObserver to
  // keep the viewport size up to date as the column resizes (column reflow,
  // sidebar collapse, window resize all change it).
  useLayoutEffect(() => {
    const el = getScrollElement();
    if (!el) return;
    const onScroll = (): void => setScrollOffset(el.scrollTop);
    onScroll();
    setViewportSize(el.clientHeight);
    el.addEventListener('scroll', onScroll, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        setViewportSize(el.clientHeight);
      });
      ro.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [getScrollElement]);

  // Evaluate estimateSize once per render — cheap, and avoids the parent
  // having to memoise the callback (parent always passes a fresh closure).
  const size = estimateSize();

  const items = useMemo<VirtualItem[]>(() => {
    if (count === 0 || size === 0) return [];
    const viewport = Math.max(viewportSize, 1);
    const startIdx = Math.max(0, Math.floor(scrollOffset / size) - overscan);
    const endIdx = Math.min(
      count - 1,
      Math.ceil((scrollOffset + viewport) / size) + overscan,
    );
    const out: VirtualItem[] = [];
    for (let i = startIdx; i <= endIdx; i++) {
      out.push({ index: i, start: i * size, size, key: i });
    }
    return out;
  }, [count, size, scrollOffset, viewportSize, overscan]);

  return {
    getVirtualItems: () => items,
    getTotalSize: () => count * size,
    scrollOffset,
  };
}

/** Threshold above which a column should switch to virtualized rendering. */
export const VIRTUALIZE_THRESHOLD = 50;

/** Estimated px height of a single board card. Tuned to match the average
 *  card on the board (one title line, chip row, assignee row, borders). */
export const ESTIMATED_CARD_HEIGHT = 132;

