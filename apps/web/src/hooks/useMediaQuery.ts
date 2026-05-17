import { useEffect, useState } from 'react';

// =============================================================================
// useMediaQuery
//
// Subscribes to a CSS media query and returns the current match state. SSR-safe
// — defaults to `false` on the server (no window) so server-rendered markup
// doesn't assume a mobile viewport.
//
// Usage:
//   const isMobile = useMediaQuery('(max-width: 768px)');
//
// We deliberately re-evaluate when the query string changes so a component
// can swap breakpoints dynamically. Older Safari (<14) lacks
// MediaQueryList.addEventListener, so we fall back to addListener — the test
// suite stubs matchMedia anyway.
// =============================================================================

export function useMediaQuery(query: string): boolean {
  const getMatch = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(query).matches;
  };

  const [matches, setMatches] = useState<boolean>(getMatch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent | MediaQueryList): void => {
      setMatches('matches' in e ? e.matches : mq.matches);
    };
    // Sync once on mount in case the query string changed between renders.
    setMatches(mq.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange as (e: MediaQueryListEvent) => void);
      return () => mq.removeEventListener('change', onChange as (e: MediaQueryListEvent) => void);
    }
    // Safari < 14 fallback.
    type LegacyMQ = MediaQueryList & {
      addListener: (cb: (e: MediaQueryListEvent) => void) => void;
      removeListener: (cb: (e: MediaQueryListEvent) => void) => void;
    };
    const legacy = mq as LegacyMQ;
    legacy.addListener(onChange as (e: MediaQueryListEvent) => void);
    return () => legacy.removeListener(onChange as (e: MediaQueryListEvent) => void);
  }, [query]);

  return matches;
}
