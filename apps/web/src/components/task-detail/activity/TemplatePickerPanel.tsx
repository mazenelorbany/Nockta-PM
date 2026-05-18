import { cn } from '@nockta/ui';

import type { CommentTemplate } from './types';

// =============================================================================
// Pass I (Comments 8 → 9). Composer add-ons.
//
// TemplatePickerPanel — small flyout under the "Templates" button. Workspace
// and project templates are merged into a single list; the scope shows as a
// tiny chip per row so the user can tell them apart when names collide.
// =============================================================================

export function TemplatePickerPanel({
  templates,
  loading,
  onPick,
  onClose,
}: {
  templates: CommentTemplate[];
  loading: boolean;
  onPick: (tpl: CommentTemplate) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      className="absolute z-20 top-full left-0 mt-1 w-72 rounded-md border border-border bg-card shadow-md p-1"
      onMouseLeave={onClose}
    >
      {loading ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          No templates yet. Admins can add some under Settings → Comment templates.
        </div>
      ) : (
        <ul className="max-h-64 overflow-auto">
          {templates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="w-full text-left rounded-sm px-2 py-1.5 text-xs hover:bg-accent flex items-center gap-2"
              >
                <span className="flex-1 min-w-0 truncate">{t.name}</span>
                <span className={cn(
                  'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  t.scope === 'workspace'
                    ? 'bg-brand/10 text-brand'
                    : 'bg-muted text-muted-foreground',
                )}>
                  {t.scope}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
