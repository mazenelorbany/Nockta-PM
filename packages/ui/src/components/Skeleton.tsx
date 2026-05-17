import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Shimmer placeholder for loading content. Sized via the className the caller
 * provides — no enforced height/width — so it composes with any layout.
 */
export function Skeleton({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-muted/60',
        className,
      )}
      {...rest}
    />
  );
}

/**
 * Convenience: a vertical stack of N skeleton rows at a uniform height. Use
 * for list-style loading states where you'd otherwise show "Loading…" text.
 */
export function SkeletonList({
  rows = 5,
  rowClassName,
  className,
}: {
  rows?: number;
  rowClassName?: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('space-y-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn('h-10 w-full', rowClassName)} />
      ))}
    </div>
  );
}
