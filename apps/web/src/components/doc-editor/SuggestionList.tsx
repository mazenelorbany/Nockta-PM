import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ForwardRefRenderFunction,
} from 'react';
import { cn } from '@nockta/ui';

import type {
  SuggestionItemBase,
  SuggestionListHandle,
  SuggestionListProps,
} from './types';

// =============================================================================
// Floating suggestion list — used by both slash commands and mentions.
// =============================================================================

const SuggestionListInner: ForwardRefRenderFunction<
  SuggestionListHandle,
  SuggestionListProps<SuggestionItemBase>
> = (props, ref) => {
  // Destructure outside the imperative-handle factory so the dep list
  // narrows to the specific props we touch (lint flagged a missing
  // `props` dep otherwise — including the whole props object would
  // re-create the handle on every render).
  const { items, command, renderItem } = props;
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(
    ref,
    (): SuggestionListHandle => ({
      onKeyDown: (event: KeyboardEvent): boolean => {
        if (event.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % Math.max(1, items.length));
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelected(
            (s) => (s - 1 + items.length) % Math.max(1, items.length),
          );
          return true;
        }
        if (event.key === 'Enter') {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [items, command, selected],
  );

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-border bg-popover shadow-md text-xs text-muted-foreground px-3 py-2">
        No matches
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-popover shadow-md overflow-hidden text-sm min-w-[12rem]">
      {items.map((it, idx) => {
        const r = renderItem(it);
        return (
          <button
            type="button"
            key={idx}
            onMouseDown={(e) => {
              e.preventDefault();
              command(it);
            }}
            onMouseEnter={() => setSelected(idx)}
            className={cn(
              'w-full text-left px-3 py-1.5 flex items-baseline justify-between gap-3',
              idx === selected ? 'bg-accent text-foreground' : 'text-foreground/90',
            )}
          >
            <span className="font-medium">{r.primary}</span>
            <span className="text-xs text-muted-foreground truncate">{r.secondary}</span>
          </button>
        );
      })}
    </div>
  );
};

export const SuggestionList = forwardRef(SuggestionListInner);
SuggestionList.displayName = 'SuggestionList';

// ---------- popup mount helpers ----------

export function mountPopup(
  element: Element | null,
  rect: (() => DOMRect | null) | null | undefined,
): HTMLDivElement | null {
  if (!element) return null;
  const popup = document.createElement('div');
  popup.style.position = 'absolute';
  popup.style.zIndex = '60';
  popup.appendChild(element);
  document.body.appendChild(popup);
  positionPopup(popup, rect);
  return popup;
}

export function positionPopup(
  popup: HTMLDivElement | null,
  rect: (() => DOMRect | null) | null | undefined,
): void {
  if (!popup || typeof rect !== 'function') return;
  const r = rect();
  if (!r) return;
  popup.style.left = `${r.left + window.scrollX}px`;
  popup.style.top = `${r.bottom + window.scrollY + 4}px`;
}
