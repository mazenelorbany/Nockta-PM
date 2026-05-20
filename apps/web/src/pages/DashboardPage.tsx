import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CalendarDays } from 'lucide-react';
import { QueryErrorState } from '@nockta/ui';

import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';

import { GreetingHero } from './dashboard/GreetingHero';
import { MyProjects } from './dashboard/MyProjects';
import { StatStrip } from './dashboard/StatStrip';
import { TimeThisWeek } from './dashboard/TimeThisWeek';
import { StandupCard } from './dashboard/StandupCard';
import { Card, InlineEmpty } from './dashboard/Card';
import { TaskList } from './dashboard/TaskList';
import { OpenByPriority } from './dashboard/OpenByPriority';
import { ActivityFeed } from './dashboard/ActivityFeed';
import { byPriorityThenDue, startOfToday } from './dashboard/helpers';
import type {
  PersonalDashboard,
  TaskSearchResp,
  TimelineEvent,
} from './dashboard/types';

// =============================================================================
// /  — personal command center. Replaces the 4-stat-card page with a
// multi-column "what's on my plate" surface drawn from the analytics + search
// endpoints we already have.
// =============================================================================

export function DashboardPage(): JSX.Element {
  const { user } = useAuth();

  const statsQuery = useQuery({
    queryKey: ['analytics', 'me'],
    queryFn: () => api.get<PersonalDashboard>('/analytics/me'),
  });

  const myTasksQuery = useQuery({
    queryKey: ['dashboard', 'my-tasks', user?.id],
    queryFn: () =>
      api.get<TaskSearchResp>(
        `/search/tasks?assigneeUserId=${user?.id ?? ''}&limit=50`,
      ),
    enabled: Boolean(user?.id),
  });

  const activityQuery = useQuery({
    queryKey: ['dashboard', 'activity', user?.id],
    queryFn: () =>
      api.get<{ items: TimelineEvent[]; nextCursor: string | null }>(
        `/timeline/me?limit=15`,
      ),
    enabled: Boolean(user?.id),
  });

  const stats = statsQuery.data;
  const allMine = (myTasksQuery.data?.items ?? []).filter(
    (t) => t.status.toLowerCase() !== 'done',
  );
  const today = startOfToday();
  const tomorrow = today + 24 * 60 * 60 * 1000;
  const overdueMine = allMine.filter(
    (t) => t.dueDate && new Date(t.dueDate).getTime() < today,
  );
  const dueTodayMine = allMine
    .filter((t) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate).getTime();
      return d >= today && d < tomorrow;
    })
    .sort(byPriorityThenDue);
  const upcomingMine = allMine
    .filter((t) => t.dueDate && new Date(t.dueDate).getTime() >= tomorrow)
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
    .slice(0, 8);
  const blockedMine = allMine.filter((t) => t.isBlocked);
  const inProgressMine = allMine.filter((t) => t.status.toLowerCase() === 'in progress');
  const firstName = (user?.name ?? user?.email ?? 'there').split(' ')[0];

  return (
    // Tightened from space-y-8 → space-y-5 on the outer stack and space-y-6 →
    // space-y-5 inside so a returning user sees Stat strip + Projects + first
    // task list above the fold on a 13" laptop. The hero itself was also
    // slimmed (see GreetingHero) for the same reason.
    <div className="space-y-5 pb-12">
      {/* Cinematic greeting hero — brand gradient band, big display heading */}
      <GreetingHero firstName={firstName} />

      <div className="px-4 sm:px-6 md:px-8 space-y-5">
        {/* Surface fetch failures so the user knows the numbers aren't current.
         * Stats + tasks are computed from independent queries; either can fail
         * without the other. Retry attempts both for simplicity. */}
        {(statsQuery.isError || myTasksQuery.isError) && (
          <QueryErrorState
            title={'Your dashboard is out of date'}
            description={
              statsQuery.isError && myTasksQuery.isError
                ? "We couldn't reach the analytics or task service. Counts below may be empty."
                : statsQuery.isError
                ? "Couldn't load your weekly stats. Task lists below are still fresh."
                : "Couldn't load your task list. Top-level counts are still fresh."
            }
            error={statsQuery.error ?? myTasksQuery.error}
            onRetry={() => {
              void statsQuery.refetch();
              void myTasksQuery.refetch();
            }}
            className="rounded-lg border border-destructive/30 bg-destructive/5 py-6"
          />
        )}

        {/* Recent-projects shortcut strip — one-click re-entry into any
         * project the user has open work in, ranked by urgency. Free of an
         * extra API call: bucketed from `allMine`. Hides itself when the
         * user has nothing assigned (e.g. brand-new account). */}
        <MyProjects tasks={allMine} />

        {/* Stat strip — four equal urgency tiles. All counts derived from
         * /search/tasks so they stay in sync with what the lists below show. */}
        <StatStrip
          dueToday={dueTodayMine.length}
          overdue={overdueMine.length}
          blocked={blockedMine.length}
          inProgress={inProgressMine.length}
        />

        {statsQuery.data?.timeThisWeek && (
          <TimeThisWeek
            totalSeconds={statsQuery.data.timeThisWeek.totalSeconds}
            byDay={statsQuery.data.timeThisWeek.byDay}
            target={statsQuery.data.weeklyTarget ?? null}
          />
        )}

        {user?.id && <StandupCard userId={user.id} />}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 grid-flow-dense">
          {/* Left two-thirds: my work */}
          <div className="lg:col-span-2 space-y-6">
            {overdueMine.length > 0 && (
              <Card
                title={'Overdue'}
                eyebrow={`${overdueMine.length} items`}
                tone="destructive"
              >
                <TaskList tasks={overdueMine} />
              </Card>
            )}

            {dueTodayMine.length > 0 && (
              <Card
                title={'Due today'}
                eyebrow={`${dueTodayMine.length}`}
                icon={<CalendarClock className="h-4 w-4 text-brand" />}
              >
                <TaskList tasks={dueTodayMine} />
              </Card>
            )}

            <Card
              title={'Upcoming'}
              eyebrow={`${upcomingMine.length} of ${allMine.length}`}
              icon={<CalendarDays className="h-4 w-4 text-muted-foreground" />}
            >
              {upcomingMine.length === 0 ? (
                <InlineEmpty text={'No upcoming deadlines. Nice.'} />
              ) : (
                <TaskList tasks={upcomingMine} />
              )}
            </Card>

            {blockedMine.length > 0 && (
              <Card
                title={'Blocked'}
                eyebrow={`${blockedMine.length}`}
                tone="warning"
              >
                <TaskList tasks={blockedMine} />
              </Card>
            )}

            {stats && <OpenByPriority stats={stats} />}
          </div>

          {/* Right column: activity feed */}
          <div className="space-y-6" data-tour="dashboard-stream">
            <ActivityFeed
              items={activityQuery.data?.items}
              isLoading={activityQuery.isLoading}
              isError={activityQuery.isError}
              error={activityQuery.error}
              onRetry={() => void activityQuery.refetch()}
            />
          </div>
        </div>
      </div>

    </div>
  );
}
