import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@nockta/ui';

export function AccessChip({
  label,
  count,
  icon,
  href,
  tone,
}: {
  label: string;
  count: number;
  icon: JSX.Element;
  href: string;
  tone?: 'guest';
}): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <a
      href={href}
      onClick={(e) => {
        // Push through React Router so the page-level hash-scroll effect fires.
        e.preventDefault();
        navigate(`${location.pathname}${href}`);
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        count > 0
          ? tone === 'guest'
            ? 'border-priority-medium/40 bg-priority-medium/5 text-foreground hover:bg-priority-medium/10'
            : 'border-brand/40 bg-brand/5 text-foreground hover:bg-brand/10'
          : 'border-border bg-card/40 text-muted-foreground hover:text-foreground hover:bg-accent/40',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{count}</span>
    </a>
  );
}
