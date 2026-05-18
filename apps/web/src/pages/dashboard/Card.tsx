import { cn } from '@nockta/ui';

export function Card({
  title,
  eyebrow,
  icon,
  tone,
  children,
}: {
  title: string;
  eyebrow?: string | undefined;
  icon?: React.ReactNode;
  tone?: 'destructive' | 'warning';
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className={cn(
        'relative rounded-lg border bg-card p-5 md:p-6',
        tone === 'destructive' ? 'border-status-blocked/30 shadow-[0_0_0_1px_hsl(var(--status-blocked)/0.08)_inset]' :
        tone === 'warning'     ? 'border-priority-high/30' :
                                 'border-border',
      )}
    >
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-base font-semibold tracking-tight flex items-center gap-1.5">
          {icon}
          {title}
        </h2>
        {eyebrow && (
          <span className="nockta-eyebrow text-muted-foreground">{eyebrow}</span>
        )}
      </header>
      {children}
    </section>
  );
}

export function InlineEmpty({ text }: { text: string }): JSX.Element {
  return <div className="text-xs text-muted-foreground py-2">{text}</div>;
}
