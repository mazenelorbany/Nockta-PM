import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Empty-state block. Use when a query succeeded but returned no rows. Keep
 * the copy actionable ("Create your first X" beats "No data"). Optional icon
 * slot accepts any React node — a lucide icon, an inline SVG, or omit
 * entirely for text-only states.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-12',
        className,
      )}
      role="status"
    >
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      {description && (
        <p className="mt-1 max-w-sm text-xs text-muted-foreground leading-relaxed">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
