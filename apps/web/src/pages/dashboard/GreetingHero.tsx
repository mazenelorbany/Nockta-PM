import { greeting, todayLabel } from './helpers';

export function GreetingHero({ firstName }: { firstName: string }): JSX.Element {
  return (
    <header className="relative overflow-hidden border-b border-border">
      <div className="absolute inset-0 bg-brand-gradient pointer-events-none" />
      <div
        className="absolute inset-0 opacity-[0.035] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />
      {/* Brand cube — "build" (the lone purple cube) sits bottom-right of
          the personal dashboard hero. Build is the mode this page is for. */}
      <img
        src="/build.png"
        alt=""
        aria-hidden="true"
        className="absolute -right-12 -bottom-16 h-[360px] w-[360px] object-contain pointer-events-none select-none opacity-65"
      />
      <div className="relative px-4 sm:px-6 md:px-8 pt-6 pb-8 sm:pt-10 sm:pb-12 flex items-end justify-between gap-4 sm:gap-6 flex-wrap">
        <div className="min-w-0">
          <span className="nockta-eyebrow text-brand">{greeting()}</span>
          <h1
            className="display-heading mt-3 leading-[1.04]"
            style={{ fontSize: 'clamp(2rem, 4vw, 3.4rem)' }}
          >
            {firstName}
            <span className="text-brand">.</span>
          </h1>
          <p className="text-sm md:text-base text-muted-foreground mt-3 max-w-xl">
            {"Here's what's on your plate today. Sharpest items first."}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="nockta-eyebrow">{todayLabel(undefined)}</span>
          {/* Quick-add anchor — opens the command palette in "new task"
              mode. Also serves as the InteractiveTour target so we can
              point at a stable real DOM element on the dashboard. */}
          <button
            type="button"
            data-tour="new-task-button"
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
            }}
            className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
            aria-label={'Create a task'}
          >
            <span aria-hidden="true">+</span>
            {'New task'}
          </button>
        </div>
      </div>
    </header>
  );
}
