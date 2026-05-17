import { Download, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';

// =============================================================================
// InstallPwaCard
//
// Listens for the browser's `beforeinstallprompt` event (Chromium / Edge) and
// surfaces an Install button that triggers the native A2HS flow. Hidden when:
//   - The app is already running standalone (matchMedia '(display-mode: standalone)').
//   - The browser never fires beforeinstallprompt (Safari, FF) AND we're not
//     already standalone — we fall back to a small "open in your browser's
//     install menu" hint so the card still teaches the affordance exists.
//
// One-time outcome tracking: after the user accepts/dismisses the prompt we
// store the result in localStorage so the card doesn't keep nagging.
// =============================================================================

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const LS_KEY = 'nockta:install-pwa-state';

type Outcome = 'accepted' | 'dismissed' | 'unsupported';

export function InstallPwaCard(): JSX.Element | null {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => isStandalone());
  const [savedOutcome, setSavedOutcome] = useState<Outcome | null>(() => readSavedOutcome());

  useEffect(() => {
    function onBeforeInstall(e: Event): void {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    }
    function onAppInstalled(): void {
      setInstalled(true);
      saveOutcome('accepted');
      setSavedOutcome('accepted');
    }
    function onDisplayModeChange(): void {
      setInstalled(isStandalone());
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    // Re-check on display-mode flips (e.g. user taps "add to home" from menu).
    const mm = window.matchMedia('(display-mode: standalone)');
    mm.addEventListener?.('change', onDisplayModeChange);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
      mm.removeEventListener?.('change', onDisplayModeChange);
    };
  }, []);

  if (installed) return null;
  // If the user already dismissed once in this browser, fall silent — they
  // can still install via the URL bar menu.
  if (savedOutcome === 'dismissed') return null;

  async function onInstall(): Promise<void> {
    if (!evt) {
      toast('Open your browser menu and choose "Install app".');
      return;
    }
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      saveOutcome(choice.outcome);
      setSavedOutcome(choice.outcome);
      if (choice.outcome === 'accepted') {
        toast.success('Installing Nockta…');
      }
    } catch {
      toast.error('Install prompt failed.');
    } finally {
      setEvt(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-background/40 p-4 flex items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand/10 text-brand shrink-0">
        <Smartphone className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">Install Nockta on your device</div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          Get a standalone window with offline support, push notifications, and a faster
          launch from your home screen or dock.
        </p>
      </div>
      <div className="shrink-0">
        <button
          type="button"
          onClick={onInstall}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {evt ? 'Install' : 'How'}
        </button>
      </div>
    </div>
  );
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia('(display-mode: standalone)').matches;
  // iOS Safari uses a non-standard navigator flag.
  const ios = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return mm || ios;
}

function readSavedOutcome(): Outcome | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === 'accepted' || raw === 'dismissed' || raw === 'unsupported') return raw;
    return null;
  } catch {
    return null;
  }
}

function saveOutcome(outcome: Outcome): void {
  try {
    localStorage.setItem(LS_KEY, outcome);
  } catch {
    /* ignore */
  }
}
