import { useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Database,
  FileText,
  MessageSquare,
  Settings as SettingsIcon,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { cn } from '@nockta/ui';

// =============================================================================
// SettingsRail — left-side anchor navigation. Updates the URL hash on click
// so deep-links work (`/projects/:id/settings#access`), and supports keyboard
// navigation: Up/Down cycle through entries (focus only), Enter navigates.
// Stays sticky as the user moves through the sections.
// =============================================================================

export function SettingsRail({
  archived,
  accessTotal,
}: {
  archived: boolean;
  accessTotal: number;
}): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const railRef = useRef<HTMLElement | null>(null);

  const items: { href: string; label: string; icon: JSX.Element; tail?: string | undefined }[] = [
    { href: '#overview', label: 'Overview', icon: <SettingsIcon className="h-3.5 w-3.5" /> },
    {
      href: '#access',
      label: 'Access',
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      tail: accessTotal > 0 ? String(accessTotal) : undefined,
    },
    { href: '#workflow', label: 'Workflow', icon: <Workflow className="h-3.5 w-3.5" /> },
    {
      href: '#integrations',
      label: 'Integrations',
      icon: <MessageSquare className="h-3.5 w-3.5" />,
    },
    {
      href: '#custom-fields',
      label: 'Custom fields',
      icon: <Database className="h-3.5 w-3.5" />,
    },
    { href: '#templates', label: 'Templates', icon: <FileText className="h-3.5 w-3.5" /> },
    {
      href: '#danger',
      label: 'Danger zone',
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    },
  ];

  /**
   * Keyboard nav. Up/Down move focus between rail entries, Enter activates the
   * focused entry, Home/End jump to first/last. Listens at the <aside> level
   * via React's onKeyDown so we don't pollute the global document listeners.
   *
   * Focus management is left to the browser's default <a> focus behavior; we
   * only intervene to redirect arrow keys.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const root = railRef.current;
      if (!root) return;
      const links = Array.from(
        root.querySelectorAll<HTMLAnchorElement>('a[data-rail-item]'),
      );
      if (links.length === 0) return;
      const activeIdx = links.findIndex((l) => l === document.activeElement);

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        // If no rail item is focused yet, start at the top (Down) or bottom (Up).
        let nextIdx: number;
        if (activeIdx === -1) {
          nextIdx = e.key === 'ArrowDown' ? 0 : links.length - 1;
        } else {
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          nextIdx = (activeIdx + dir + links.length) % links.length;
        }
        links[nextIdx]?.focus();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        links[0]?.focus();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        links[links.length - 1]?.focus();
        return;
      }
      // Enter on a focused rail link triggers a normal click. We don't need
      // to do anything — the browser already fires the click handler — but
      // we surface it here so future maintainers can find the keymap.
    },
    [],
  );

  return (
    <aside
      ref={railRef}
      onKeyDown={onKeyDown}
      role="navigation"
      aria-label="Project settings sections"
      className="hidden md:flex w-56 shrink-0 border-r border-border flex-col overflow-y-auto p-3 gap-0.5"
    >
      {items.map((i) => {
        const active = location.hash === i.href;
        return (
          <a
            key={i.href}
            href={i.href}
            data-rail-item
            {...(active ? { 'aria-current': 'true' as const } : {})}
            onClick={(e) => {
              // Intercept so we push the hash through React Router's location.
              // This makes the deep-link round-trip work: `useEffect[location.hash]`
              // on the page sees the change and scrolls the section into view.
              // Default <a href="#x"> works too, but it doesn't update React
              // Router's location object — so our scroll effect wouldn't fire.
              e.preventDefault();
              navigate(`${location.pathname}${i.href}`, { replace: false });
            }}
            className={cn(
              'group flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/40',
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  'shrink-0',
                  i.href === '#danger' ? 'text-destructive/70' : 'text-muted-foreground/70',
                )}
              >
                {i.icon}
              </span>
              <span className="truncate">{i.label}</span>
            </span>
            {i.tail && (
              <span className="text-[10px] font-mono text-muted-foreground/70 group-hover:text-foreground/70 shrink-0">
                {i.tail}
              </span>
            )}
          </a>
        );
      })}
      {archived && (
        <div className="mt-3 rounded-md border border-status-blocked/30 bg-status-blocked/5 px-2.5 py-2 text-[10px] text-status-blocked">
          This project is archived. Most actions are disabled.
        </div>
      )}
    </aside>
  );
}
