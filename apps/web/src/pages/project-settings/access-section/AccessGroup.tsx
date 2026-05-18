// =============================================================================
// AccessGroup — subsection container that gives Members/Teams/Guests a
// consistent header, optional inline action button, and an empty state. The
// id is used by anchor chips at the top of the Access section so clicking
// "Guests · 2" scrolls right to the group.
// =============================================================================

export function AccessGroup({
  id,
  title,
  icon,
  hint,
  empty,
  emptyHint,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  hint: string;
  /** Caller signals whether the grant list is empty. Inferring this from
   *  children was unreliable because empty arrays / `false` branches still
   *  occupy a child slot in React. */
  empty: boolean;
  emptyHint: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section id={id} className="scroll-mt-24">
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        </div>
        {action}
      </header>
      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{hint}</p>
      <div className="rounded-lg border border-border bg-card/40 overflow-hidden">
        {empty && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {emptyHint}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
