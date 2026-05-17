import { Home, Inbox, ListTodo, Search, Settings } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { cn } from '@nockta/ui';

// =============================================================================
// MobileBottomNav
//
// Tab bar that replaces the desktop sidebar on viewports <sm. Five tabs cover
// the most common nav targets:
//
//   Home    → /
//   Tasks   → /my-tasks
//   Search  → Cmd+K palette (we dispatch the same synthetic keypress the
//             desktop sidebar's search button uses)
//   Inbox   → /inbox
//   Settings→ /settings
//
// The bar is fixed to the bottom with a backdrop blur + safe-area padding so
// it sits cleanly above the iOS home indicator. Hidden on >= sm via Tailwind.
// =============================================================================

interface TabDef {
  to?: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
  /** When set, the tab is an action instead of a route link. */
  onClick?: () => void;
}

const TABS: TabDef[] = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/my-tasks', label: 'Tasks', icon: ListTodo },
  {
    label: 'Search',
    icon: Search,
    onClick: () => {
      // Synthesize Cmd+K to trigger the existing CommandPalette listener.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    },
  },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function MobileBottomNav(): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'sm:hidden fixed bottom-0 inset-x-0 z-30',
        'border-t border-border bg-card/95 backdrop-blur-md',
        // Honor iOS safe area so the bar floats just above the home indicator.
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <ul className="grid grid-cols-5 h-14">
        {TABS.map((tab) => (
          <li key={tab.label} className="contents">
            {tab.onClick ? (
              <button
                type="button"
                onClick={tab.onClick}
                className="flex flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                aria-label={tab.label}
              >
                <tab.icon className="h-5 w-5" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            ) : (
              <NavLink
                to={tab.to!}
                end={tab.end ?? false}
                className={({ isActive }) =>
                  cn(
                    'flex flex-col items-center justify-center gap-0.5 text-[10px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )
                }
                aria-label={tab.label}
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cn(
                        'relative inline-flex items-center justify-center h-5 w-5',
                        isActive && 'text-brand',
                      )}
                    >
                      <tab.icon className="h-5 w-5" aria-hidden="true" />
                      {isActive && (
                        <span className="absolute -top-2 h-0.5 w-6 rounded-full bg-brand" />
                      )}
                    </span>
                    <span>{tab.label}</span>
                  </>
                )}
              </NavLink>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
