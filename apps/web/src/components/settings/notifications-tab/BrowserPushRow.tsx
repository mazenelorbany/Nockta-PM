import { useState } from 'react';
import toast from 'react-hot-toast';

import { HelpHint } from '../primitives';

export function BrowserPushRow(): JSX.Element {
  const [state, setState] = useState<'on' | 'off' | 'denied' | 'unsupported' | 'prompt'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (
      Notification.permission === 'granted' &&
      localStorage.getItem('nockta.browser-push') === 'on'
    ) {
      return 'on';
    }
    if (Notification.permission === 'granted') return 'off';
    return 'prompt';
  });

  async function enable(): Promise<void> {
    const mod = await import('../../../lib/use-notifications');
    const r = await mod.enableBrowserNotifications();
    if (r === 'unsupported') {
      toast.error('This browser does not support notifications.');
      setState('unsupported');
    } else if (r === 'denied') {
      toast.error('Permission denied. Re-enable in your browser site settings.');
      setState('denied');
    } else if (r === 'granted') {
      toast.success('Desktop notifications on');
      setState('on');
    }
  }
  function disable(): void {
    void import('../../../lib/use-notifications').then((mod) =>
      mod.disableBrowserNotifications(),
    );
    setState('off');
    toast.success('Desktop notifications off');
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-4 flex items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand/10 text-brand shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-1">
          Desktop notifications
          <HelpHint hint="System-level toasts when the browser tab isn't focused. The in-app bell keeps counting either way." />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          Surface @mentions, blockers, and assignments as system toasts when the tab isn't focused.
          The in-app bell stays on regardless.
        </p>
      </div>
      <div className="shrink-0">
        {state === 'unsupported' && (
          <span className="text-xs text-muted-foreground">Not supported in this browser.</span>
        )}
        {state === 'denied' && (
          <span className="text-xs text-status-blocked">Blocked in browser settings.</span>
        )}
        {state === 'prompt' && (
          <button
            type="button"
            onClick={enable}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Enable
          </button>
        )}
        {state === 'off' && (
          <button
            type="button"
            onClick={enable}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            Turn on
          </button>
        )}
        {state === 'on' && (
          <button
            type="button"
            onClick={disable}
            className="rounded-md border border-brand/40 bg-brand/10 text-brand px-3 py-1.5 text-xs hover:bg-brand/20"
          >
            On — turn off
          </button>
        )}
      </div>
    </div>
  );
}
