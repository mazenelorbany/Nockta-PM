import { HelpHint } from '../primitives';

export function SnoozeAllRow({
  snoozedUntil,
  onSnooze,
  pending,
}: {
  snoozedUntil: Date | null;
  onSnooze: (minutes: number) => void;
  pending: boolean;
}): JSX.Element {
  const presets: { label: string; minutes: number }[] = [
    { label: '1 hour', minutes: 60 },
    { label: '4 hours', minutes: 240 },
    { label: 'Until tomorrow 9am', minutes: minutesUntilTomorrow9am() },
    { label: 'Until Monday 9am', minutes: minutesUntilMonday9am() },
  ];
  return (
    <div className="rounded-lg border border-border bg-background/40 p-4 flex items-start gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium flex items-center gap-1">
          {'Snooze everything'}
          <HelpHint hint={'Mutes Chat + desktop pings. The in-app bell badge still counts so you can find missed items when you return.'} />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
          {'Mute Chat + desktop pings (in-app stays on so the bell badge still counts) for a focus block.'}
          {snoozedUntil && (
            <>
              <br />
              <span className="text-foreground font-medium">
                {`Currently snoozed until ${snoozedUntil.toLocaleString(undefined)}`}
              </span>
            </>
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={pending}
              onClick={() => onSnooze(p.minutes)}
              className="rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {p.label}
            </button>
          ))}
          {snoozedUntil && (
            <button
              type="button"
              disabled={pending}
              onClick={() => onSnooze(0)}
              className="rounded-md border border-brand/40 bg-brand/10 text-brand px-2.5 py-1 text-xs hover:bg-brand/20 disabled:opacity-50"
            >
              {'Clear snooze'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function minutesUntilTomorrow9am(): number {
  const d = new Date();
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return Math.max(1, Math.round((tomorrow.getTime() - d.getTime()) / 60_000));
}

function minutesUntilMonday9am(): number {
  const d = new Date();
  const monday = new Date(d);
  // 1 = Monday in JS getDay(); cycle to next Monday (skip today if it's already Mon).
  const offset = ((1 - d.getDay() + 7) % 7) || 7;
  monday.setDate(d.getDate() + offset);
  monday.setHours(9, 0, 0, 0);
  return Math.max(1, Math.round((monday.getTime() - d.getTime()) / 60_000));
}

export function formatSnooze(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.round(minutes / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
