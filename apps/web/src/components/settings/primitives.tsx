import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, ShieldCheck } from 'lucide-react';
import { ApiError } from '@nockta/sdk';
import { cn } from '@nockta/ui';

// =============================================================================
// Settings primitives — shared bits used by every tab body so the tab files
// stay focused on their own domain. Extracted from the original SettingsPage.tsx
// monolith; no behavior changes here.
// =============================================================================

/**
 * SectionTitle — eyebrow + optional hint text. Rendered above each section so
 * the user gets a one-line read on what the controls below do.
 */
export function SectionTitle({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): JSX.Element {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

/**
 * Field — labelled control wrapper used by Workspace + Project settings forms.
 * Optional hint renders below the control in muted text.
 */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="nockta-eyebrow text-muted-foreground mb-1 block"
      >
        {label}
      </label>
      {children}
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

/**
 * ToggleRow — row containing a label/hint pair on the left and a switch on
 * the right. Used in Workflow + Notifications and other places where the
 * answer is a single boolean preference.
 */
export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label
      className={cn(
        'flex items-start justify-between gap-4 rounded-md border border-border bg-background/40 px-3 py-3 transition-colors',
        disabled
          ? 'opacity-60 cursor-not-allowed'
          : 'cursor-pointer hover:bg-background/70',
      )}
    >
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <span
        role="switch"
        aria-checked={checked}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors shrink-0 mt-1',
          checked ? 'bg-brand' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </span>
    </label>
  );
}

/**
 * Toggle — bare switch used inside table cells (Notifications matrix).
 * No surrounding label or padding; the parent renders its own context.
 */
export function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 rounded-full transition-colors',
        checked ? 'bg-brand' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/**
 * EditableField — render-as-text-until-clicked input. Used in the UserDrawer
 * header so the admin can click on the name or email and edit it inline.
 *
 * Behavior:
 *   - Click → switches to an input pre-filled with the current value.
 *   - Blur or Enter → commits via onSave (no-op if unchanged or empty).
 *   - Escape → reverts and exits edit mode without saving.
 */
export function EditableField({
  value,
  type = 'text',
  placeholder,
  className,
  onSave,
}: {
  value: string;
  type?: 'text' | 'email';
  placeholder?: string;
  className?: string;
  onSave: (next: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  // Keep the local draft in sync when the parent's value changes (e.g. after
  // a successful save) so the next edit starts from the new value.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  function commit(): void {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    onSave(next);
  }

  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        className={cn(
          'bg-transparent border-b border-brand/50 focus:border-brand outline-none w-full min-w-0',
          className,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={cn(
        'block w-full min-w-0 text-left rounded-sm px-0.5 -mx-0.5 truncate transition-colors',
        'hover:bg-accent/40 hover:text-foreground cursor-text',
        className,
      )}
    >
      {value || (
        <span className="text-muted-foreground/60 italic">
          {placeholder ?? 'Click to set'}
        </span>
      )}
    </button>
  );
}

/**
 * HelpHint — tiny (?) icon that surfaces a tooltip on hover (desktop) and a
 * tap-toggled popover on mobile. Inline-block so it sits beside its label
 * without taking a full line. Touch users tap the icon to toggle the popover;
 * clicking outside closes it.
 */
export function HelpHint({ hint, className }: { hint: string; className?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();

  // Close on outside click whenever the popover is visible. Used by mobile
  // taps; on desktop the hover state takes precedence and this listener is
  // a no-op since open=false stays until tap.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(`[data-help-hint-id="${id}"]`)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, id]);

  return (
    <span
      data-help-hint-id={id}
      className={cn('relative inline-flex group align-middle', className)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label="Help"
        aria-expanded={open}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span
        role="tooltip"
        className={cn(
          'absolute left-1/2 top-full z-50 mt-1 -translate-x-1/2 w-56 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md',
          // Hover-driven on desktop; click-driven on touch (open state).
          'pointer-events-none opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100 group-hover:pointer-events-auto',
          open && 'opacity-100 pointer-events-auto',
        )}
      >
        {hint}
      </span>
    </span>
  );
}

/**
 * Fieldset — labelled grouping with an uppercase legend. Lets each settings
 * tab group related controls into visually distinct blocks instead of one
 * undifferentiated stack.
 */
export function Fieldset({
  legend,
  hint,
  children,
  className,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <fieldset className={cn('rounded-lg border border-border bg-card/40 p-4 sm:p-5', className)}>
      <legend className="nockta-eyebrow text-muted-foreground/80 px-1.5">
        {legend}
      </legend>
      {hint && (
        <p className="text-xs text-muted-foreground mt-1 mb-3 leading-relaxed">
          {hint}
        </p>
      )}
      <div className={cn(!hint && 'mt-1', 'space-y-3')}>{children}</div>
    </fieldset>
  );
}

/**
 * AdminGate — the "you're not an Admin so this tab is empty" view. Rendered
 * by every admin-only tab when the auth context says the current user is a
 * plain Member. Lives here so the message is consistent across tabs.
 */
export function AdminGate(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-md">
      <div className="rounded-lg border border-border bg-card/40 p-6 text-center">
        <ShieldCheck className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
        <div className="text-sm font-semibold">{t('settings.admin_only', 'Admin only')}</div>
        <div className="text-xs text-muted-foreground mt-1">
          {t('settings.admin_only_body', 'Ask a workspace admin to grant you access.')}
        </div>
      </div>
    </div>
  );
}

/**
 * apiErrorMessage — pull a user-facing string out of an unknown error.
 * Centralised so all settings tabs report API failures the same way.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.problem.title || err.problem.detail || err.message || fallback;
  }
  return fallback;
}
