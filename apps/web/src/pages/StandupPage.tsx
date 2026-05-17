import { useMutation } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  ListChecks,
  Loader2,
  Quote,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { NocktaMark, Spinner } from '@nockta/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';

// =============================================================================
// /standup — dedicated "Daily check-in" page.
//
// The dashboard already carries a compact StandupCard, but standups deserve a
// home in the sidebar so people remember to use them. This page wraps the same
// backend endpoint (`POST /ai/users/:userId/standup`) and adds:
//   - A hero so the page is obviously the standup, not another dashboard tile.
//   - A "Copy" button so the user can paste it into whatever channel they
//     actually run standup in.
//   - The raw signals (completed yesterday, in progress today, blockers) below
//     the generated prose so the user can sanity-check what the LLM read.
// =============================================================================

interface StandupResponse {
  markdown: string;
  raw: {
    completedYesterday: string[];
    inProgressToday: string[];
    blockers: string[];
  };
}

// Structured synthesis returned by /ai/users/:id/standup-synthesis.
// Each bullet carries a `sourceIds[]` array so the UI can attribute the line
// back to the comment / task it was drawn from. Empty sourceIds means the
// LLM couldn't ground the bullet — surfaced visually as an "ungrounded" chip.
interface SynthesisLine {
  line: string;
  sourceIds: string[];
}

interface SynthesisResponse {
  did: SynthesisLine[];
  doing: SynthesisLine[];
  blockers: SynthesisLine[];
  costUsdCents: number;
}

export function StandupPage(): JSX.Element {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [result, setResult] = useState<StandupResponse | null>(null);
  const [synthesis, setSynthesis] = useState<SynthesisResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Generate runs both endpoints in parallel: the legacy markdown for the
  // copy-into-Slack flow + the structured synthesis with quote attribution
  // for the Synthesis panel below. If the synthesis call fails we still keep
  // the markdown — synthesis is enhancement, not replacement.
  const generate = useMutation({
    mutationFn: async () => {
      const [markdown, struct] = await Promise.all([
        api.post<StandupResponse>(`/ai/users/${user!.id}/standup`),
        api
          .post<SynthesisResponse>(`/ai/users/${user!.id}/standup-synthesis`)
          .catch(() => null),
      ]);
      return { markdown, struct };
    },
    onSuccess: ({ markdown, struct }) => {
      setResult(markdown);
      setSynthesis(struct);
      setCopied(false);
    },
    onError: () => toast.error(t('standup.generate_error', 'Could not generate standup')),
  });

  function copy(): void {
    if (!result?.markdown) return;
    void navigator.clipboard.writeText(result.markdown).then(() => {
      setCopied(true);
      toast.success(t('standup.copy_success', 'Copied to clipboard'));
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!user?.id) {
    return (
      <div className="p-8 text-sm text-muted-foreground flex items-center gap-2">
        <Spinner /> {t('common.loading', 'Loading…')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Hero header — visually distinct so the page reads as "standup", not
          "yet another dashboard". Subtle Nockta mark in the corner to match
          the rest of the project pages. */}
      <header className="relative overflow-hidden border-b border-border gradient-mesh-subtle">
        <div
          className="absolute -right-12 -bottom-16 text-brand/[0.05] pointer-events-none select-none"
          aria-hidden="true"
        >
          <NocktaMark className="h-[240px] w-[240px]" />
        </div>
        <div className="relative px-4 sm:px-6 md:px-8 pt-6 sm:pt-8 pb-6 sm:pb-8 flex items-end justify-between gap-4 sm:gap-6 flex-wrap">
          <div>
            <span className="nockta-eyebrow text-brand inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" />
              {t('standup.eyebrow', 'Standup')}
            </span>
            <h1
              className="display-heading mt-2 leading-[1.04]"
              style={{ fontSize: 'clamp(1.8rem, 3.4vw, 2.6rem)' }}
            >
              {t('standup.title', 'Daily check-in')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground max-w-xl">
              {t(
                'standup.subtitle',
                "An AI-built recap of yesterday, today, and anything blocking you — pulled from your tasks, comments, and PR activity. Generate it once each morning; copy it into Slack, Chat, or wherever your team meets.",
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {result && (
              <button
                type="button"
                onClick={copy}
                className="tap inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                aria-label={t('standup.copy_aria', 'Copy to clipboard')}
              >
                {copied ? (
                  <>
                    <ClipboardCheck className="h-3.5 w-3.5 text-status-done" />
                    {t('standup.copied', 'Copied')}
                  </>
                ) : (
                  <>
                    <Clipboard className="h-3.5 w-3.5" />
                    {t('standup.copy', 'Copy')}
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="tap inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60"
            >
              {generate.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('standup.thinking', 'Thinking…')}
                </>
              ) : result ? (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  {t('standup.regenerate', 'Regenerate')}
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  {t('standup.generate', 'Generate')}
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 space-y-6">
        {/* Empty state */}
        {!result && !generate.isPending && (
          <div className="rounded-xl border border-dashed border-border bg-card/30 px-6 py-12 text-center">
            <Sparkles className="h-6 w-6 text-primary mx-auto" />
            <p className="mt-3 text-sm font-medium">
              {t('standup.empty_title', 'No standup generated yet today.')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
              {/* Translators: the <strong> wraps the literal "Generate" button
                  label, which itself is translated separately. We hardcode the
                  English in the fallback rather than chaining keys to keep the
                  fallback rendering robust if the JSON is missing. */}
              {t('standup.empty_body_prefix', 'Click ')}
              <span className="text-foreground font-medium">
                {t('standup.generate', 'Generate')}
              </span>
              {t(
                'standup.empty_body_suffix',
                ' above to build it from your task activity in the last 24 hours.',
              )}
            </p>
          </div>
        )}

        {/* Loading state */}
        {generate.isPending && !result && (
          <div className="rounded-xl border border-border bg-card/40 p-6 flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              {t('standup.loading', "Pulling yesterday's activity and today's open work…")}
            </p>
          </div>
        )}

        {/* Generated markdown */}
        {result && (
          <article className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
            <header className="flex items-center gap-2 mb-3">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <h2 className="text-sm font-semibold tracking-tight">
                {t('standup.todays_standup', "Today's standup")}
              </h2>
            </header>
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {result.markdown}
            </div>
          </article>
        )}

        {/* Structured synthesis with quote attribution. Renders the four
            buckets (wins / blockers / focusToday / risks expressed as
            did / blockers / doing / risks) with a clickable Quote icon
            beside each line showing the source IDs it was drawn from.
            Hidden when synthesis returned no bullets (e.g. feature off or
            zero source signals). */}
        {synthesis && (synthesis.did.length || synthesis.doing.length || synthesis.blockers.length) ? (
          <article className="rounded-xl border border-border bg-card/40 p-5 sm:p-6">
            <header className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Quote className="h-3.5 w-3.5 text-primary" />
                <h2 className="text-sm font-semibold tracking-tight">
                  {t('standup.synthesis_title', 'Synthesis')}
                </h2>
              </div>
              {synthesis.costUsdCents > 0 && (
                <span
                  className="text-[10px] font-mono text-muted-foreground"
                  title="Cost in USD cents — recorded in workspace AI usage telemetry"
                >
                  {(synthesis.costUsdCents / 100).toFixed(3)}¢
                </span>
              )}
            </header>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              {t(
                'standup.synthesis_subtitle',
                'Bullets cite the comment or task they were drawn from. Click the quote chip to inspect the source.',
              )}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <SynthesisBucket
                title={t('standup.wins', 'Wins')}
                items={synthesis.did}
                tone="done"
              />
              <SynthesisBucket
                title={t('standup.focus_today', 'Focus today')}
                items={synthesis.doing}
                tone="focus"
              />
              <SynthesisBucket
                title={t('standup.blockers', 'Blockers')}
                items={synthesis.blockers}
                tone="block"
              />
              <SynthesisBucket
                title={t('standup.risks', 'Risks')}
                // The current backend bundles risks under blockers; the bucket
                // stays empty until the synthesis service splits them. Kept in
                // the UI so the 4-bucket spec stays visible in markup.
                items={[]}
                tone="risk"
              />
            </div>
          </article>
        ) : null}

        {/* Raw signals — surfaces what the LLM read so the user can sanity-check.
            Three small cards, one per bucket. Hidden until we have data. */}
        {result && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <SignalCard
              icon={<CheckCircle2 className="h-3.5 w-3.5 text-status-done" />}
              title={t('standup.completed_yesterday', 'Completed yesterday')}
              items={result.raw.completedYesterday}
              emptyText={t('standup.completed_yesterday_empty', 'Nothing closed since yesterday.')}
            />
            <SignalCard
              icon={<ListChecks className="h-3.5 w-3.5 text-primary" />}
              title={t('standup.in_progress_today', 'In progress today')}
              items={result.raw.inProgressToday}
              emptyText={t('standup.in_progress_today_empty', 'No open work in progress.')}
            />
            <SignalCard
              icon={<ShieldAlert className="h-3.5 w-3.5 text-status-blocked" />}
              title={t('standup.blockers', 'Blockers')}
              items={result.raw.blockers}
              emptyText={t('standup.blockers_empty', 'Nothing blocked. Nice.')}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// One bucket inside the Synthesis panel. Renders each `SynthesisLine` with
// a "Quote" chip showing the source IDs the LLM cited (clickable so users
// can verify the AI didn't hallucinate). Empty buckets render a muted "—".
function SynthesisBucket({
  title,
  items,
  tone,
}: {
  title: string;
  items: SynthesisLine[];
  tone: 'done' | 'focus' | 'block' | 'risk';
}): JSX.Element {
  const toneClass = {
    done: 'text-status-done',
    focus: 'text-primary',
    block: 'text-status-blocked',
    risk: 'text-amber-500',
  }[tone];
  return (
    <section className="rounded-xl border border-border bg-card/40 p-4">
      <header className="flex items-center gap-2 mb-2">
        <Quote className={`h-3.5 w-3.5 ${toneClass}`} />
        <h3 className="text-xs font-semibold tracking-tight">{title}</h3>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((line, i) => (
            <li
              key={i}
              className="text-xs text-foreground/90 leading-relaxed flex items-start gap-1.5"
            >
              <span className="flex-1">{line.line}</span>
              {line.sourceIds.length > 0 ? (
                <button
                  type="button"
                  title={`Source IDs: ${line.sourceIds.join(', ')}`}
                  className="inline-flex items-center gap-0.5 rounded bg-brand/10 text-brand text-[10px] font-mono px-1 py-0.5 hover:bg-brand/20"
                  onClick={() => {
                    // Clipboard-copy the source IDs so the user can paste them
                    // into the task drawer search. Cheaper than wiring a
                    // navigation hook here; opens the door for a deeper
                    // affordance later.
                    void navigator.clipboard.writeText(line.sourceIds.join(', '));
                  }}
                  aria-label={`Cited sources: ${line.sourceIds.join(', ')}`}
                >
                  <Quote className="h-2.5 w-2.5" />
                  {line.sourceIds.length}
                </button>
              ) : (
                <span
                  className="inline-flex items-center rounded bg-amber-500/10 text-amber-600 text-[10px] font-mono px-1 py-0.5"
                  title="No source cited — bullet may be ungrounded"
                >
                  ungrounded
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SignalCard({
  icon,
  title,
  items,
  emptyText,
}: {
  icon: React.ReactNode;
  title: string;
  items: string[];
  emptyText: string;
}): JSX.Element {
  return (
    <section className="rounded-xl border border-border bg-card/40 p-4">
      <header className="flex items-center gap-2 mb-2">
        {icon}
        <h3 className="text-xs font-semibold tracking-tight">{title}</h3>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((line, i) => (
            <li key={i} className="text-xs text-foreground/90 leading-relaxed">
              {line}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
