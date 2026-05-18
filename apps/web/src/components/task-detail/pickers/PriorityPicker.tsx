import { useState } from 'react';

import { PriorityDot, type Priority } from '../../task-bits';
import { PRIORITY_OPTIONS } from '../constants';
import type { TaskDetail } from '../types';
import { usePopover } from '../utils';

import { PopoverItem, PopoverList, PopoverShell, ValuePill } from './Popover';

// AiWhyChip — the "AI · why?" affordance next to the priority picker.
// When the auto-prioritization processor wrote a structured factor breakdown
// (aiPriorityFactors), we render a small table on hover/click. Without
// factors, falls back to a plain title-attr tooltip — same UX as before.
//
// `triageExplanation` is the new 2-3 sentence narrative the processor writes
// alongside the factors. Rendered below the table so users can read the AI's
// reasoning in prose form — distinct from the one-line `reason` tooltip and
// the numeric factor breakdown.
export function AiWhyChip({
  reason,
  factors,
  triageExplanation,
}: {
  reason: string;
  factors: TaskDetail['aiPriorityFactors'];
  triageExplanation?: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasTable = Array.isArray(factors) && factors.length > 0;
  const hasTriage = Boolean(triageExplanation && triageExplanation.trim().length > 0);

  // No structured detail at all → tiny tooltip variant, same as before.
  if (!hasTable && !hasTriage) {
    return (
      <span
        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand/10 text-brand cursor-help"
        title={reason}
        aria-label={`AI priority rationale: ${reason}`}
      >
        AI · why?
      </span>
    );
  }

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-brand/10 text-brand cursor-help"
        aria-label="Show AI priority factors"
      >
        AI · why?
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute z-50 top-full mt-1 left-0 w-80 rounded-md border border-border bg-popover p-2 shadow-md text-[11px]"
        >
          <div className="text-muted-foreground mb-1">{reason}</div>
          {hasTable && (
            <table className="w-full">
              <thead>
                <tr className="text-muted-foreground/70">
                  <th className="text-left font-normal pb-1">Factor</th>
                  <th className="text-right font-normal pb-1">Weight</th>
                  <th className="text-right font-normal pb-1">Signal</th>
                  <th className="text-right font-normal pb-1">Score</th>
                </tr>
              </thead>
              <tbody>
                {factors!.map((f, i) => (
                  <tr key={`${f.name}-${i}`} className="border-t border-border/40">
                    <td className="py-1 truncate pr-2">{f.name}</td>
                    <td className="py-1 text-right font-mono">{f.weight.toFixed(1)}</td>
                    <td className="py-1 text-right font-mono">{f.value.toFixed(2)}</td>
                    <td className="py-1 text-right font-mono">{f.contribution.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {hasTriage && (
            <div className={hasTable ? 'mt-2 pt-2 border-t border-border/40' : ''}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">
                Triage explanation
              </div>
              <p className="text-foreground/90 leading-snug">{triageExplanation}</p>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

export function PriorityPicker({
  current,
  onChange,
}: {
  current: Priority;
  onChange: (p: Priority) => void;
}): JSX.Element {
  const pop = usePopover();
  return (
    <div className="relative inline-block">
      <ValuePill open={pop.open} onClick={pop.toggle} leading={<PriorityDot priority={current} />}>
        {current}
      </ValuePill>
      <PopoverShell open={pop.open} onClose={pop.close} align="left">
        <PopoverList>
          {PRIORITY_OPTIONS.map((p) => (
            <PopoverItem
              key={p}
              selected={p === current}
              onClick={() => {
                if (p !== current) onChange(p);
                pop.close();
              }}
            >
              <PriorityDot priority={p} />
              <span className="text-foreground/90">{p}</span>
            </PopoverItem>
          ))}
        </PopoverList>
      </PopoverShell>
    </div>
  );
}
