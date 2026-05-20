import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@nockta/ui';

// =============================================================================
// Reusable in-app dialog primitives — replace native `window.prompt()` and
// `window.confirm()` so the app reads as one coherent system instead of a
// half-React / half-browser UI. Both render via a portal to document.body so
// they sit above any popover / drawer / scrim that triggered them.
//
// Conventions: Esc cancels, click-outside-scrim cancels, Enter submits the
// primary action, the focused control on mount is the input (prompt) or the
// destructive button (confirm). Keep these primitives small; surface-specific
// flourishes belong on the caller side.
// =============================================================================

interface BaseProps {
  title: string;
  body?: React.ReactNode;
  onCancel: () => void;
}

interface ConfirmDialogProps extends BaseProps {
  /** Label of the primary action (defaults to "Confirm"). */
  confirmLabel?: string;
  /** Label of the cancel button (defaults to "Cancel"). */
  cancelLabel?: string;
  /** When true, the confirm button is painted destructive (red) to signal
   *  irreversible action. Wire this for delete-style flows. */
  destructive?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-background/85"
      />
      <div className="animate-popover-in relative z-[91] w-full max-w-sm rounded-xl border border-border bg-popover shadow-2xl shadow-black/50">
        <header className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {body && <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{body}</div>}
        </header>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-3 py-2.5 bg-card/40 rounded-b-xl mt-2">
          <button
            type="button"
            onClick={onCancel}
            className="tap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              'tap rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

interface PromptDialogProps extends BaseProps {
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** When true the input is required (empty submit is disabled). Default true. */
  required?: boolean;
  /** When false, the submit button stays primary-coloured even without input.
   *  Set true for destructive prompt flows (rare). */
  destructive?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  onSubmit: (value: string) => void;
}

export function PromptDialog({
  title,
  body,
  defaultValue = '',
  placeholder,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  required = true,
  destructive = false,
  inputMode,
  onCancel,
  onSubmit,
}: PromptDialogProps): JSX.Element {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSubmit = !required || value.trim().length > 0;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-background/85"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(value);
        }}
        className="animate-popover-in relative z-[91] w-full max-w-sm rounded-xl border border-border bg-popover shadow-2xl shadow-black/50"
      >
        <header className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {body && <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{body}</div>}
        </header>
        <div className="px-4 pb-3">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            inputMode={inputMode}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
            maxLength={200}
          />
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border px-3 py-2.5 bg-card/40 rounded-b-xl">
          <button
            type="button"
            onClick={onCancel}
            className="tap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'tap rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              !canSubmit
                ? 'bg-primary/30 text-primary-foreground/60 cursor-not-allowed'
                : destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
