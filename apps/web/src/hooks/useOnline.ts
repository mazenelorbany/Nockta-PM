import { useEffect, useState } from 'react';

// =============================================================================
// useOnline
//
// Subscribes to the browser's `online` / `offline` events and returns the
// current connectivity state. SSR-safe — defaults to `true` if `navigator`
// isn't available so server-rendered markup doesn't claim "offline".
// =============================================================================

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  });

  useEffect(() => {
    function up(): void {
      setOnline(true);
    }
    function down(): void {
      setOnline(false);
    }
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return online;
}
