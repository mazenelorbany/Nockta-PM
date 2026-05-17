import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Indeterminate spinner. Sized to inherit from the parent's font-size so it
 * lines up with adjacent text — pass an explicit size via className if needed.
 */
export function Spinner({
  className,
  label = 'Loading',
}: {
  className?: string;
  label?: string;
}): JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn('inline-block align-[-2px]', className)}
    >
      <svg
        className="h-[1em] w-[1em] animate-spin text-current"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path
          d="M22 12a10 10 0 0 0-10-10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
