import { CheckCircle2, XCircle } from 'lucide-react';
import { Spinner, cn } from '@nockta/ui';
import type { ImportRunSummary } from './types';

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'primary' | 'danger' | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border p-3 text-center',
        tone === 'primary' && 'border-primary/40 bg-primary/10',
        tone === 'danger' && 'border-status-blocked/40 bg-status-blocked/10',
        !tone && 'border-border bg-card/30',
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}

export function SourceHeader({
  icon,
  title,
  subtitle,
}: {
  icon: JSX.Element;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="h-10 w-10 rounded-md bg-brand/10 text-brand flex items-center justify-center">
        {icon}
      </div>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: ImportRunSummary['status'] }): JSX.Element {
  if (status === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 text-status-done">
        <CheckCircle2 className="h-3 w-3" />
        Succeeded
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-status-blocked">
        <XCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-primary">
        <Spinner className="h-3 w-3" />
        Running
      </span>
    );
  }
  return <span className="text-muted-foreground capitalize">{status}</span>;
}
