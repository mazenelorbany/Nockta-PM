import { Flame } from 'lucide-react';
import { cn } from '@nockta/ui';

/**
 * Logged-time-this-week tile + per-day mini bar chart. Shows the user how
 * much focus time the worklog timer (or manual logs) has captured Monday→now.
 */
export function TimeThisWeek({
  totalSeconds,
  byDay,
  target,
}: {
  totalSeconds: number;
  byDay: { day: string; seconds: number }[];
  /** When the user has set a weekly hours target, render a progress bar
   *  alongside the bar chart and a small "🔥 N week streak" chip. Null hides
   *  the entire target/streak treatment. */
  target: {
    hours: number;
    secondsLogged: number;
    secondsTarget: number;
    hit: boolean;
    streakWeeks: number;
  } | null;
}): JSX.Element {
  // Build a Mon→Sun array seeded with zeros so empty days still render.
  const start = new Date();
  const dow = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  start.setUTCHours(0, 0, 0, 0);
  const days: { label: string; iso: string; seconds: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const found = byDay.find((b) => b.day === iso);
    days.push({
      label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
      iso,
      seconds: found?.seconds ?? 0,
    });
  }
  const max = Math.max(1, ...days.map((d) => d.seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);

  // When a target is set: progress bar + "X / Y h" label, and a streak chip.
  const progressPct = target && target.secondsTarget > 0
    ? Math.min(100, (target.secondsLogged / target.secondsTarget) * 100)
    : 0;

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <div>
          <p className="nockta-eyebrow text-muted-foreground">Time this week</p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums">
            {hours}h {String(mins).padStart(2, '0')}m
            {target && (
              <span className="ml-2 text-sm text-muted-foreground font-normal">
                / {target.hours}h
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          {target && target.streakWeeks > 0 && (
            <span
              title={`${target.streakWeeks} consecutive ${
                target.streakWeeks === 1 ? 'week' : 'weeks'
              } at or above target`}
              className="inline-flex items-center gap-1 rounded-md bg-priority-high/10 px-2 py-0.5 text-[11px] font-medium text-priority-high"
            >
              <Flame className="h-3 w-3" />
              {target.streakWeeks} wk streak
            </span>
          )}
          {!target && (
            <p className="text-xs text-muted-foreground">
              {totalSeconds === 0 ? 'No worklog entries yet this week.' : 'Logged via timer or manual entry.'}
            </p>
          )}
        </div>
      </div>
      {target && (
        <div className="mb-3">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-secondary/60"
            role="progressbar"
            aria-valuenow={Math.round(progressPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Weekly progress: ${Math.round(progressPct)}%`}
          >
            <div
              className={cn(
                'h-full transition-all',
                target.hit ? 'bg-status-done' : 'bg-primary/70',
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {target.hit
              ? "You're at goal for the week."
              : `${Math.round(progressPct)}% of target — keep going.`}
          </p>
        </div>
      )}
      <div className="grid grid-cols-7 gap-2 items-end h-20">
        {days.map((d) => {
          const heightPct = (d.seconds / max) * 100;
          return (
            <div key={d.iso} className="flex flex-col items-center gap-1 h-full justify-end">
              <div
                className={cn(
                  'w-full rounded-t-sm transition-all',
                  d.seconds > 0 ? 'bg-primary/70' : 'bg-secondary/40',
                )}
                style={{ height: `${Math.max(heightPct, 4)}%` }}
                title={d.seconds > 0 ? `${Math.round(d.seconds / 60)} min` : 'No logs'}
              />
              <span className="text-[10px] text-muted-foreground">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
