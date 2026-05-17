import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@nockta/ui';

// =============================================================================
// Global keyboard shortcuts. Mounted once at the App level.
//   ?    — open the shortcuts help overlay
//   c    — open the create-task dialog (broadcasts a window event the
//          ProjectBoardPage listens to; falls back to navigating to /board)
//   /    — focus the Cmd+K search palette (dispatches a synthetic Cmd+K)
//   j / k — move focus down / up across [data-kbd-row] elements
//   Esc  — close the help overlay
//
// Keystrokes are ignored while the user is typing in an input, textarea, or
// any contentEditable element — standard Jira/Linear/Github behaviour.
// =============================================================================

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function focusRow(direction: 1 | -1): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-kbd-row]'));
  if (rows.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  let idx = active ? rows.indexOf(active) : -1;
  if (idx === -1) {
    // Find the closest ancestor that's a row.
    let cursor: HTMLElement | null = active;
    while (cursor && !cursor.matches('[data-kbd-row]')) cursor = cursor.parentElement;
    idx = cursor ? rows.indexOf(cursor) : -1;
  }
  const next = idx === -1
    ? (direction === 1 ? 0 : rows.length - 1)
    : Math.max(0, Math.min(rows.length - 1, idx + direction));
  rows[next].focus();
  rows[next].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

export function KeyboardShortcuts(): JSX.Element | null {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // Esc closes help (and only help — drawers own their own Esc listener).
      if (e.key === 'Escape' && helpOpen) {
        e.preventDefault();
        setHelpOpen(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      // Don't fight modifier combos — those belong to the OS or other handlers.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case '?':
          e.preventDefault();
          setHelpOpen((o) => !o);
          break;
        case 'c':
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('nockta:create-task'));
          break;
        case '/':
          e.preventDefault();
          // Dispatch Cmd+K so the existing CommandPalette responds.
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
          break;
        case 'j':
          e.preventDefault();
          focusRow(1);
          break;
        case 'k':
          e.preventDefault();
          focusRow(-1);
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  if (!helpOpen) return null;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4">
          <p className="nockta-eyebrow text-muted-foreground">
            {t('shortcuts.eyebrow', 'Keyboard shortcuts')}
          </p>
          <h2 className="mt-1 text-base font-semibold">
            {t('shortcuts.title', 'Move faster')}
          </h2>
        </header>
        <ul className="space-y-1.5 text-sm">
          {[
            { keys: ['?'], label: t('shortcuts.toggle_dialog', 'Toggle this dialog') },
            { keys: ['c'], label: t('shortcuts.new_task', 'New task') },
            { keys: ['/'], label: t('shortcuts.search_everywhere', 'Search everywhere') },
            { keys: ['j'], label: t('shortcuts.next_row', 'Next row') },
            { keys: ['k'], label: t('shortcuts.prev_row', 'Previous row') },
            { keys: ['Esc'], label: t('shortcuts.close', 'Close this dialog or any drawer') },
            { keys: ['⌘', 'K'], label: t('shortcuts.command_palette', 'Command palette') },
          ].map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="flex items-center gap-1">
                {row.keys.map((k) => (
                  <kbd
                    key={k}
                    className={cn(
                      'inline-flex h-6 min-w-[24px] items-center justify-center rounded border border-border bg-background',
                      'px-1.5 text-[11px] font-mono text-foreground/80'
                    )}
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] text-muted-foreground">
          {t('shortcuts.tip', "Tip: shortcuts are ignored while you're typing in a field.")}
        </p>
      </div>
    </div>
  );
}
