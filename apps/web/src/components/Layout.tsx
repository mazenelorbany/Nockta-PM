import { NocktaLogo } from '@nockta/ui';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { useNotificationsSurface } from '../lib/use-notifications';

import { ActiveTimerChip } from './ActiveTimerChip';
import { NotificationsBell } from './NotificationsBell';
import { PageTransition } from './PageTransition';
import { Sidebar } from './layout/sidebar';

// =============================================================================
// Layout — app shell. Wires the Sidebar (which owns its own data + drawer
// logic) and the top header bar (hamburger toggle, brand on mobile, active
// timer chip, notifications bell). Everything else routes through <Outlet/>.
// =============================================================================

export function Layout(): JSX.Element {
  // Title pulse + browser-push toast for new notifications. Mounted here so
  // the surface follows the user across every authenticated page.
  useNotificationsSurface();

  const location = useLocation();

  // Mobile sidebar drawer state — toggled by the hamburger in the top bar
  // on viewports <md. Always open on >=md.
  const [mobileOpen, setMobileOpen] = useState(false);
  // Auto-close on route change so the drawer doesn't stay over the new page.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Hamburger ref is owned here so the Sidebar's focus-trap effect can restore
  // focus to it when the drawer closes (passed down by ref).
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <Sidebar
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        hamburgerRef={hamburgerRef}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-between gap-2 px-3 md:px-4 bg-background/95 backdrop-blur-sm">
          {/* Hamburger toggle — only visible <md, where the sidebar is hidden. */}
          <button
            ref={hamburgerRef}
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={'Toggle menu'}
            aria-expanded={mobileOpen}
            aria-controls="mobile-sidebar"
            className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <div className="md:hidden flex items-center gap-2">
            <NocktaLogo height={18} />
          </div>
          <div className="flex items-center gap-2 ms-auto">
            <ActiveTimerChip />
            <NotificationsBell />
          </div>
        </header>
        <main className="flex-1 overflow-auto focus:outline-none">
          <PageTransition>
            <Outlet />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
