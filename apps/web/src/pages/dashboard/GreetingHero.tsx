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
          the personal dashboard hero. Build is the mode this page is for.
          Pushed further off-screen and dimmer so the date + new-task
          controls on the same row stay legible. */}
      <img
        src="/build.png"
        alt=""
        aria-hidden="true"
        className="absolute -right-32 -bottom-24 h-[320px] w-[320px] object-contain pointer-events-none select-none opacity-30"
      />
      <div className="relative px-4 sm:px-6 md:px-8 pt-5 pb-6 sm:pt-7 sm:pb-8 flex items-end justify-between gap-4 sm:gap-6 flex-wrap">
        <div className="min-w-0">
          <span className="nockta-eyebrow text-brand">{greeting()}</span>
          {/* Tightened vertical rhythm: the hero used to dominate the viewport
              on a fresh dashboard load, pushing the actually-useful task lists
              below the fold. Smaller display heading + reduced top padding
              gets the user to content one screen earlier without losing the
              welcome moment. */}
          <h1
            className="display-heading mt-2 leading-[1.04]"
            style={{ fontSize: 'clamp(1.7rem, 3vw, 2.6rem)' }}
          >
            {firstName}
            <span className="text-brand">.</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">
            {"Here's what's on your plate today. Sharpest items first."}
          </p>
        </div>
        {/* Wrap the date + new-task controls in their own solid card so they
            stay readable even when the brand cube watermark crosses
            underneath. */}
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 shadow-sm">
          <span className="nockta-eyebrow text-foreground/80">
            {todayLabel(undefined)}
          </span>
          {/* Quick-add anchor — opens the command palette in "new task"
              mode. Also serves as the InteractiveTour target so we can
              point at a stable real DOM element on the dashboard. */}
          <span aria-hidden="true" className="text-border">|</span>
          <button
            type="button"
            data-tour="new-task-button"
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
            }}
            className="tap inline-flex items-center gap-1.5 rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground hover:opacity-90 transition-opacity"
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
