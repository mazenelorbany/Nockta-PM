import { useQuery } from '@tanstack/react-query';

import { api } from '../../../lib/api';
import { Section } from '../Section';
import type { TimelineEvent } from '../types';
import { formatRelative, prettyEventType } from '../utils';

// =============================================================================
// Activity timeline
// =============================================================================

export function ActivitySection({ taskId, projectId }: { taskId: string; projectId: string }): JSX.Element {
  const activityQuery = useQuery({
    queryKey: ['activity', taskId],
    queryFn: () =>
      api.get<{ items: TimelineEvent[]; nextCursor: string | null }>(
        `/timeline/entity/Task/${taskId}?projectId=${projectId}&limit=50`,
      ),
  });

  const events = activityQuery.data?.items ?? [];

  return (
    <Section title="Activity">
      {activityQuery.isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : events.length === 0 ? (
        <div className="text-xs text-muted-foreground">No activity recorded.</div>
      ) : (
        <ul className="space-y-2.5">
          {events.map((ev) => (
            <li key={ev.id} className="flex items-start gap-2.5 text-xs">
              <span className="mt-1 h-1.5 w-1.5 rounded-full bg-brand/70 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-foreground">
                  <span className="font-medium">{ev.actor?.name ?? 'System'}</span>{' '}
                  <span className="text-muted-foreground">{prettyEventType(ev.type)}</span>
                </span>
                <span className="text-muted-foreground"> · {formatRelative(ev.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
