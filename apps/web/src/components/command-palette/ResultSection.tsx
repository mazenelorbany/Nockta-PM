export function ResultSection({
  label,
  children,
}: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="py-1">
      <div className="px-4 pt-2 pb-1 nockta-eyebrow text-muted-foreground/60">
        {label}
      </div>
      <ul>{children}</ul>
    </div>
  );
}
