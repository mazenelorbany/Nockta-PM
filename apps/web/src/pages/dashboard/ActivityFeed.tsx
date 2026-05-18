import { QueryErrorState, SkeletonList } from '@nockta/ui';

import { AvatarCircle } from '../../components/task-bits';

import { Card, InlineEmpty } from './Card';
import { formatRelative, prettyEvent } from './helpers';
import type { TimelineEvent } from './types';

export function ActivityFeed({
  items,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  items: TimelineEvent[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}): JSX.Element {
  const list = items ?? [];
  return (
    <Card
      title={'Recent activity'}
      eyebrow={list.length ? `${list.length}` : undefined}
    >
      {isLoading ? (
        <SkeletonList rows={6} rowClassName="h-8" />
      ) : isError ? (
        <QueryErrorState
          title={"Couldn't load activity"}
          error={error}
          onRetry={onRetry}
          className="py-6"
        />
      ) : list.length === 0 ? (
        <InlineEmpty text={'No recent activity yet.'} />
      ) : (
        <ul className="space-y-3.5 stagger-list">
          {list.map((ev) => (
            <li key={ev.id} className="stagger-item flex items-start gap-2.5">
              <AvatarCircle
                user={ev.actor ?? null}
                size={20}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0 text-xs">
                <span className="text-foreground font-medium">
                  {ev.actor?.name ?? 'System'}
                </span>{' '}
                <span className="text-muted-foreground">
                  {prettyEvent(ev.type)}
                </span>
                <div className="text-muted-foreground/80 mt-0.5">
                  {formatRelative(ev.createdAt)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
