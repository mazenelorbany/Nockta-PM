import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Inline error fallback for failed react-query / fetch operations. The default
 * ErrorBoundary catches render-time exceptions; this component covers the
 * commoner case of "the data fetch failed but the page still rendered". Pass
 * `onRetry` to surface a button — most callers will pass `() => query.refetch()`.
 */
export function QueryErrorState({
  title = 'Something went wrong',
  description,
  error,
  onRetry,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}): JSX.Element {
  const message =
    description ??
    (error instanceof Error
      ? error.message
      : 'The request failed. Check your connection and try again.');
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-12',
        className,
      )}
    >
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground leading-relaxed">
        {message}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Try again
        </button>
      )}
    </div>
  );
}
