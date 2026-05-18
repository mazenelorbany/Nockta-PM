import type { UseMutationResult } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { cn } from '@nockta/ui';

import { Section, Field } from './shared';
import { BROADCAST_EVENTS } from './constants';
import { prettyEventName } from './utils';
import type { Project } from './types';

export function IntegrationsSection({
  draft,
  setDraft,
  patch,
  commit,
  updateMutation,
}: {
  draft: Project;
  setDraft: (next: Project) => void;
  patch: <K extends keyof Project>(key: K, value: Project[K]) => void;
  commit: <K extends keyof Project>(key: K) => void;
  updateMutation: UseMutationResult<Project, unknown, Partial<Project>, unknown>;
}): JSX.Element {
  function toggleBroadcastEvent(event: string): void {
    const next = draft.chatBroadcastEvents.includes(event)
      ? draft.chatBroadcastEvents.filter((e) => e !== event)
      : [...draft.chatBroadcastEvents, event];
    setDraft({ ...draft, chatBroadcastEvents: next });
    updateMutation.mutate({ chatBroadcastEvents: next });
  }

  return (
    <Section
      id="integrations"
      icon={<MessageSquare className="h-4 w-4" />}
      title="Integrations"
      hint="Where this project broadcasts its events outside Nockta."
    >
      <Field label="Google Chat space ID" hint="Find this in the space URL: spaces/AAAA…">
        <input
          value={draft.chatSpaceId ?? ''}
          onChange={(e) => patch('chatSpaceId', e.target.value || null)}
          onBlur={() => commit('chatSpaceId')}
          placeholder="spaces/AAAA…"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
      </Field>
      <div>
        <div className="nockta-eyebrow text-muted-foreground mb-2">
          Events to broadcast
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {BROADCAST_EVENTS.map((ev) => {
            const on = draft.chatBroadcastEvents.includes(ev);
            return (
              <button
                key={ev}
                type="button"
                onClick={() => toggleBroadcastEvent(ev)}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-xs text-left transition-colors',
                  on
                    ? 'border-brand/50 bg-accent text-foreground'
                    : 'border-border bg-background/40 text-muted-foreground hover:text-foreground hover:bg-accent/40',
                )}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      on ? 'bg-brand' : 'bg-muted-foreground/40',
                    )}
                  />
                  {prettyEventName(ev)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );
}
