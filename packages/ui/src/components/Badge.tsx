import * as React from 'react';

import { cn } from '../lib/cn';

type Variant = 'default' | 'secondary' | 'outline' | 'brand' | 'destructive' | 'muted';

const variants: Record<Variant, string> = {
  default:    'bg-foreground/10 text-foreground',
  secondary:  'bg-secondary text-secondary-foreground',
  outline:    'border border-border text-foreground',
  brand:      'bg-brand text-brand-foreground',
  destructive:'bg-destructive text-destructive-foreground',
  muted:      'bg-muted text-muted-foreground',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export function Badge({ className, variant = 'default', ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        variants[variant],
        className,
      )}
      {...rest}
    />
  );
}
