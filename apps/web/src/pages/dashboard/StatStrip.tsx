import { Ban, CalendarClock, Flame, Timer } from 'lucide-react';
import { cn } from '@nockta/ui';

export function StatStrip({
  dueToday,
  overdue,
  blocked,
  inProgress,
}: {
  dueToday: number;
  overdue: number;
  blocked: number;
  inProgress: number;
}): JSX.Element {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatTile
        icon={<CalendarClock className="h-4 w-4" />}
        label={'Due today'}
        value={dueToday}
        tone={dueToday > 0 ? 'urgent' : undefined}
      />
      <StatTile
        icon={<Flame className="h-4 w-4" />}
        label={'Overdue'}
        value={overdue}
        tone={overdue > 0 ? 'destructive' : undefined}
      />
      <StatTile
        icon={<Ban className="h-4 w-4" />}
        label={'Blocked'}
        value={blocked}
        tone={blocked > 0 ? 'warning' : undefined}
      />
      <StatTile
        icon={<Timer className="h-4 w-4" />}
        label={'In progress'}
        value={inProgress}
      />
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'destructive' | 'warning' | 'urgent' | undefined;
}): JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card p-4 transition-colors hover:border-ring">
      <div className="relative flex items-center gap-1.5 nockta-eyebrow text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          'relative display-heading mt-1 tabular-nums leading-none',
          tone === 'destructive' && value > 0 && 'text-status-blocked',
          tone === 'warning' && value > 0 && 'text-priority-high',
          tone === 'urgent' && value > 0 && 'text-brand',
        )}
        style={{ fontSize: 'clamp(1.6rem, 2.4vw, 2rem)' }}
      >
        {value}
      </div>
    </div>
  );
}
