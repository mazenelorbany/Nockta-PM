import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';
import { api } from '../../lib/api';
import { Field, SectionTitle, ToggleRow, apiErrorMessage } from './primitives';

// =============================================================================
// AiSettingsTab — workspace-wide AI knobs.
//
// Lives under /settings/ai. Backed by /workspace/ai-settings (GET + PATCH).
// Admin gates the write path; non-Admin users see a read-only view (no
// edit affordance is rendered for them).
// =============================================================================

interface AiSettings {
  dupThreshold: number;
  priorityWeights: {
    deadline: number;
    blocked: number;
    customerImpact: number;
    [key: string]: number;
  };
  autoSuggestEnabled: boolean;
  modelPreference: 'auto' | 'ollama' | 'anthropic';
  updatedAt: string;
  updatedById: string;
}

interface DupPreviewResponse {
  count: number;
  taskId: string | null;
}

interface SampleTask {
  id: string;
  key: string;
  title: string;
}

export function AiSettingsTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['workspace-ai-settings'],
    queryFn: () => api.get<AiSettings>('/workspace/ai-settings'),
  });

  // Local edit buffer so sliders feel responsive — we only PATCH on release
  // (via the existing mutation) and on the live-preview debounce timer.
  const [draft, setDraft] = useState<AiSettings | null>(null);
  useEffect(() => {
    if (settingsQuery.data && !draft) setDraft(settingsQuery.data);
  }, [settingsQuery.data, draft]);

  const save = useMutation({
    mutationFn: (patch: Partial<AiSettings>) =>
      api.patch<AiSettings>('/workspace/ai-settings', patch),
    onSuccess: (next) => {
      qc.setQueryData(['workspace-ai-settings'], next);
      toast.success('Saved');
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err, 'Could not save AI settings')),
  });

  if (settingsQuery.isLoading || !draft) {
    return (
      <div className="p-4 sm:p-6 md:p-8 max-w-3xl">
        <SectionTitle
          title={'AI'}
          hint={'Loading workspace AI knobs…'}
        />
      </div>
    );
  }

  function commit(patch: Partial<AiSettings>): void {
    if (!isAdmin) return;
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    save.mutate(patch);
  }

  function setDraftLocal(patch: Partial<AiSettings>): void {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-3xl space-y-8">
      <SectionTitle
        title={'AI'}
        hint={'Tune duplicate detection, auto-prioritization, and the LLM provider for the whole workspace.'}
      />
      {!isAdmin && (
        <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          {'Read-only — only workspace Admins can edit AI settings.'}
        </div>
      )}

      <div className="space-y-6">
        <Field
          label={'Duplicate threshold'}
          hint={`Tasks whose embedding similarity is ≥ ${draft.dupThreshold.toFixed(2)} are flagged as duplicates by the AI comment bot.`}
        >
          <SliderRow
            min={0.7}
            max={0.99}
            step={0.01}
            value={draft.dupThreshold}
            disabled={!isAdmin}
            onLocalChange={(v) => setDraftLocal({ dupThreshold: v })}
            onCommit={(v) => commit({ dupThreshold: v })}
            valueLabel={draft.dupThreshold.toFixed(2)}
          />
          <DupPreview threshold={draft.dupThreshold} enabled={draft.autoSuggestEnabled} />
        </Field>

        <Field
          label={'Priority weights'}
          hint={'Used by the auto-prioritization processor when scoring deadline / blocker / customer-impact signals. 0 disables that factor.'}
        >
          <div className="space-y-3">
            {(['deadline', 'blocked', 'customerImpact'] as const).map((k) => (
              <SliderRow
                key={k}
                label={LABELS[k]}
                min={0}
                max={5}
                step={0.1}
                value={draft.priorityWeights[k] ?? 1}
                disabled={!isAdmin}
                onLocalChange={(v) => setDraftLocal({
                  priorityWeights: { ...draft.priorityWeights, [k]: v },
                })}
                onCommit={(v) => commit({
                  priorityWeights: { ...draft.priorityWeights, [k]: v },
                })}
                valueLabel={(draft.priorityWeights[k] ?? 1).toFixed(1)}
              />
            ))}
          </div>
        </Field>

        <Field
          label={'LLM provider'}
          hint={"`auto` defers to the API's LLM_PROVIDER env. Forcing a provider here overrides it; misconfigured providers (e.g. Anthropic without API key) silently fall back."}
        >
          <div className="flex flex-wrap gap-2">
            {(['auto', 'ollama', 'anthropic'] as const).map((p) => (
              <label
                key={p}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs cursor-pointer',
                  draft.modelPreference === p
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-border bg-background/40 hover:bg-background/70',
                  !isAdmin && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="radio"
                  name="modelPreference"
                  value={p}
                  disabled={!isAdmin}
                  checked={draft.modelPreference === p}
                  onChange={() => commit({ modelPreference: p })}
                  className="sr-only"
                />
                {p}
              </label>
            ))}
          </div>
        </Field>

        <ToggleRow
          label={'Enable AI auto-suggestions'}
          hint={'Master switch for AI affordances (priority suggestion, duplicate detection comments, standup cards). Disable to make the workspace AI-quiet.'}
          checked={draft.autoSuggestEnabled}
          disabled={!isAdmin}
          onChange={(v) => commit({ autoSuggestEnabled: v })}
        />
      </div>

      {/* Usage & cost — the workspace-wide AI spend dashboard. Pulls the last
          30 days of cost telemetry rows and renders a tiny sparkline + a
          by-feature / by-model breakdown. Read open to every authenticated
          user; the underlying endpoint is Internal-only (clients can't see
          workspace cost). */}
      <UsageAndCostSection />
    </div>
  );
}

// =============================================================================
// UsageAndCostSection — AI cost telemetry dashboard.
//
// Renders four pieces:
//   1. This-month total spend (sum of last 30 days of costUsdCents).
//   2. A 30-day sparkline of daily spend.
//   3. Breakdown table: cost by feature (kind).
//   4. Breakdown table: cost by model.
//
// Source: GET /ai/usage/summary?days=30. The endpoint computes the daily
// series in SQL so this component just renders what the API returns.
// =============================================================================

interface UsagePoint {
  date: string;
  totalCostCents: number;
  byKind: Record<string, number>;
  byModel: Record<string, number>;
}

interface UsageSummary {
  days: UsagePoint[];
  totalCostCents: number;
}

function UsageAndCostSection(): JSX.Element {
  const query = useQuery<UsageSummary>({
    queryKey: ['ai-usage-summary', 30],
    queryFn: () => api.get<UsageSummary>('/ai/usage/summary?days=30'),
  });

  const summary = query.data;
  const byKind = aggregate(summary?.days ?? [], (p) => p.byKind);
  const byModel = aggregate(summary?.days ?? [], (p) => p.byModel);

  return (
    <div className="space-y-4 border-t border-border pt-8">
      <SectionTitle
        title={'Usage & cost'}
        hint={"This month's AI spend across every feature, broken down by feature and model. Rates update when models change — see the static price table in `ai-cost-tracking.service.ts`."}
      />

      {query.isLoading && (
        <div className="text-xs text-muted-foreground">
          {'Loading usage…'}
        </div>
      )}
      {query.isError && (
        <div className="text-xs text-amber-500">
          {'Could not load usage summary. The cost telemetry tables may not exist yet — run migrations.'}
        </div>
      )}

      {summary && (
        <>
          <div className="flex items-baseline gap-3">
            <div className="text-2xl font-semibold tracking-tight">
              ${(summary.totalCostCents / 100).toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">
              {'last 30 days'}
            </div>
          </div>

          <UsageSparkline days={summary.days} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <UsageBreakdown
              title={'By feature'}
              entries={byKind}
            />
            <UsageBreakdown
              title={'By model'}
              entries={byModel}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Sum each `byKind` / `byModel` map across the entire window so the breakdown
 *  tables show a total per feature/model rather than just the latest day. */
function aggregate(
  days: UsagePoint[],
  pick: (p: UsagePoint) => Record<string, number>,
): Array<[string, number]> {
  const total: Record<string, number> = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(pick(d))) {
      total[k] = (total[k] ?? 0) + v;
    }
  }
  return Object.entries(total).sort((a, b) => b[1] - a[1]);
}

function UsageBreakdown({
  title,
  entries,
}: {
  title: string;
  entries: Array<[string, number]>;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        {title}
      </div>
      {entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">—</div>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([k, cents]) => (
              <tr key={k} className="border-t border-border/40">
                <td className="py-1.5 truncate pr-2">{k}</td>
                <td className="py-1.5 text-right font-mono">
                  ${(cents / 100).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Inline SVG sparkline of daily spend. Sized to a single row of text so it
 *  reads as a visual accent next to the headline total. */
function UsageSparkline({ days }: { days: UsagePoint[] }): JSX.Element {
  if (days.length === 0) {
    return <div className="text-xs text-muted-foreground">—</div>;
  }
  const max = Math.max(1, ...days.map((d) => d.totalCostCents));
  const width = 300;
  const height = 40;
  const stepX = days.length > 1 ? width / (days.length - 1) : width;
  const points = days
    .map((d, i) => {
      const x = i * stepX;
      const y = height - (d.totalCostCents / max) * (height - 4) - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
        <span>{days[0]?.date ?? ''}</span>
        <span>{days[days.length - 1]?.date ?? ''}</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-10"
        preserveAspectRatio="none"
        aria-label="Daily AI spend, last 30 days"
        role="img"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-brand"
          points={points}
        />
      </svg>
    </div>
  );
}

const LABELS: Record<'deadline' | 'blocked' | 'customerImpact', string> = {
  deadline: 'Deadline urgency',
  blocked: 'Blockers',
  customerImpact: 'Customer impact',
};

// =============================================================================
// SliderRow — shared range input with live label + commit-on-release.
// =============================================================================

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  disabled,
  valueLabel,
  onLocalChange,
  onCommit,
}: {
  label?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  valueLabel?: string;
  onLocalChange: (v: number) => void;
  onCommit: (v: number) => void;
}): JSX.Element {
  return (
    <div>
      {label && (
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono text-foreground">{valueLabel}</span>
        </div>
      )}
      {!label && (
        <div className="flex justify-end text-[11px] mb-1">
          <span className="font-mono text-foreground">{valueLabel}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onLocalChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        className="w-full accent-brand"
      />
    </div>
  );
}

// =============================================================================
// DupPreview — live "how many duplicates would this threshold flag?" readout.
// Picks a recent task as the sample; re-queries with a 300ms debounce as the
// slider drags. Falls back to a neutral message when no sample is available.
// =============================================================================

function DupPreview({ threshold, enabled }: { threshold: number; enabled: boolean }): JSX.Element {
  const sampleQuery = useQuery({
    queryKey: ['ai-preview-sample'],
    queryFn: async () => {
      // Re-uses the existing /search/tasks endpoint to grab any recent open
      // task. Best-effort — if there are no tasks yet, we show a neutral
      // message rather than an error.
      const list = await api
        .get<{ items: SampleTask[] }>('/search/tasks?limit=1')
        .catch(() => ({ items: [] as SampleTask[] }));
      return list.items?.[0] ?? null;
    },
    staleTime: 60_000,
  });
  const sample = sampleQuery.data ?? null;

  // Debounce: only fire a request 300ms after the slider settles. Without a
  // debounce we'd hammer the embeddings API on every pixel of slider drag.
  const debounced = useDebouncedValue(threshold, 300);
  const previewQuery = useQuery<DupPreviewResponse>({
    queryKey: ['ai-dup-preview', sample?.id, debounced],
    enabled: Boolean(sample?.id) && enabled,
    queryFn: async () => {
      const similar = await api.get<Array<{ score: number }>>(
        `/ai/tasks/${sample!.id}/similar`,
      );
      const count = similar.filter((h) => h.score >= debounced).length;
      return { count, taskId: sample!.id };
    },
  });

  if (!enabled) {
    return (
      <div className="mt-2 text-[11px] text-muted-foreground">
        Auto-suggest is disabled — preview is paused.
      </div>
    );
  }
  if (!sample) {
    return (
      <div className="mt-2 text-[11px] text-muted-foreground">
        Live preview unavailable — no recent open task to score against.
      </div>
    );
  }
  return (
    <div className="mt-2 text-[11px] text-muted-foreground">
      Sample <code className="font-mono text-foreground">{sample.key}</code> —{' '}
      {previewQuery.isLoading ? (
        <span>scoring…</span>
      ) : (
        <span>
          would flag <span className="font-mono text-foreground">{previewQuery.data?.count ?? 0}</span>{' '}
          similar open task{previewQuery.data?.count === 1 ? '' : 's'} at this threshold.
        </span>
      )}
    </div>
  );
}

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  const ref = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => setDebounced(value), ms);
    return () => {
      if (ref.current) clearTimeout(ref.current);
    };
  }, [value, ms]);
  return debounced;
}
