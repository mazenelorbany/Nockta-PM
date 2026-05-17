import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
  /** Optional override for the error UI. Receives the captured error and a reset function. */
  fallback?: (err: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort error boundary around the app. A render error in any sub-tree
 * lands here so the user sees a recoverable message instead of a white screen.
 * Reset clears the captured error so the user can try again without a full
 * page reload (useful when the bug is transient).
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
    // Forward to Sentry if it's been installed in the page.
    const Sentry = (window as unknown as { Sentry?: { captureException?: (e: unknown) => void } }).Sentry;
    Sentry?.captureException?.(error);
  }

  reset = (): void => this.setState({ error: null });

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    // We can't useTranslation() inside a class component, but i18n.t() works
    // identically — language changes still trigger a re-render via the parent
    // tree above us.
    const t = (key: string, fallback: string): string =>
      i18n.t(key, { defaultValue: fallback });
    return (
      <div className="min-h-screen flex items-center justify-center p-8 bg-background text-foreground">
        <div className="max-w-md w-full rounded-xl border border-border bg-card p-6 shadow-xl">
          <p className="nockta-eyebrow text-destructive">{t('errors.generic_title', 'Something broke')}</p>
          <h1 className="mt-2 text-lg font-semibold tracking-tight">
            {t('errors.generic_render', 'We caught a render error.')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t(
              'errors.generic_logged',
              'The error has been logged. Try resetting; if it recurs, refresh the page or sign out.',
            )}
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted/50 p-3 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition"
            >
              {t('errors.try_again', 'Try again')}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent transition"
            >
              {t('errors.reload_page', 'Reload page')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
