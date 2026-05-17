import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Ban, CalendarClock, CalendarDays, Flame, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn, QueryErrorState, SkeletonList } from '@nockta/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import {
  AvatarCircle, BlockedBadge, DueDateChip, PriorityDot, StatusPill, TypeBadge,
  type Priority, type TaskType,
} from '../components/task-bits';

// =============================================================================
// /  — personal command center. Replaces the 4-stat-card page with a
// multi-column "what's on my plate" surface drawn from the analytics + search
// endpoints we already have.
// =============================================================================

interface PersonalDashboard {
  openByPriority: { priority: Priority; count: number }[];
  overdueCount: number;
  watchingCount: number;
  mentionsLast7Days: number;
  timeThisWeek?: {
    totalSeconds: number;
    byDay: { day: string; seconds: number }[];
  };
  /** Set when the user has configured a weekly hours target in their
   *  preferences. Null when no target is set — the streak widget hides. */
  weeklyTarget?: {
    hours: number;
    secondsLogged: number;
    secondsTarget: number;
    hit: boolean;
    streakWeeks: number;
  } | null;
}

interface MyTask {
  id: string;
  key: string;
  type?: TaskType;
  title: string;
  status: string;
  priority: Priority;
  isBlocked: boolean;
  dueDate: string | null;
  project?: { id: string; key: string; name: string };
  assignee?: { id: string; name: string } | null;
}

interface TaskSearchResp {
  items: MyTask[];
  nextCursor: string | null;
}

interface TimelineEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  actor?: { id: string; name: string } | null;
}

export function DashboardPage(): JSX.Element {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();

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
    <div className="space-y-8 pb-12">
      {/* Cinematic greeting hero — brand gradient band, big display heading */}
      <header className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-brand-gradient pointer-events-none" />
        <div
          className="absolute inset-0 opacity-[0.035] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />
        {/* Brand cube — "build" (the lone purple cube) sits bottom-right of
            the personal dashboard hero. Build is the mode this page is for. */}
        <img
          src="/build.png"
          alt=""
          aria-hidden="true"
          className="absolute -right-12 -bottom-16 h-[360px] w-[360px] object-contain pointer-events-none select-none opacity-65"
        />
        <div className="relative px-4 sm:px-6 md:px-8 pt-6 pb-8 sm:pt-10 sm:pb-12 flex items-end justify-between gap-4 sm:gap-6 flex-wrap">
          <div className="min-w-0">
            <span className="nockta-eyebrow text-brand">{greeting(t)}</span>
            <h1
              className="display-heading mt-3 leading-[1.04]"
              style={{ fontSize: 'clamp(2rem, 4vw, 3.4rem)' }}
            >
              {firstName}
              <span className="text-brand">.</span>
            </h1>
            <p className="text-sm md:text-base text-muted-foreground mt-3 max-w-xl">
              {t('dashboard.subtitle', "Here's what's on your plate today. Sharpest items first.")}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="nockta-eyebrow">{todayLabel(i18n.language)}</span>
            {/* Quick-add anchor — opens the command palette in "new task"
                mode. Also serves as the InteractiveTour target so we can
                point at a stable real DOM element on the dashboard. */}
            <button
              type="button"
              data-tour="new-task-button"
              onClick={() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
              }}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
              aria-label={t('dashboard.quick_new_task', 'Create a task')}
            >
              <span aria-hidden="true">+</span>
              {t('dashboard.new_task', 'New task')}
            </button>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-6 md:px-8 space-y-6">
        {/* Surface fetch failures so the user knows the numbers aren't current.
         * Stats + tasks are computed from independent queries; either can fail
         * without the other. Retry attempts both for simplicity. */}
        {(statsQuery.isError || myTasksQuery.isError) && (
          <QueryErrorState
            title={t('dashboard.out_of_date_title', 'Your dashboard is out of date')}
            description={
              statsQuery.isError && myTasksQuery.isError
                ? t(
                    'dashboard.out_of_date_both',
                    "We couldn't reach the analytics or task service. Counts below may be empty.",
                  )
                : statsQuery.isError
                ? t(
                    'dashboard.out_of_date_stats',
                    "Couldn't load your weekly stats. Task lists below are still fresh.",
                  )
                : t(
                    'dashboard.out_of_date_tasks',
                    "Couldn't load your task list. Top-level counts are still fresh.",
                  )
            }
            error={statsQuery.error ?? myTasksQuery.error}
            onRetry={() => {
              void statsQuery.refetch();
              void myTasksQuery.refetch();
            }}
            className="rounded-lg border border-destructive/30 bg-destructive/5 py-6"
          />
        )}

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
                title={t('dashboard.overdue', 'Overdue')}
                eyebrow={t('dashboard.items_count', '{{count}} items', { count: overdueMine.length })}
                tone="destructive"
              >
                <TaskList tasks={overdueMine} />
              </Card>
            )}

            {dueTodayMine.length > 0 && (
              <Card
                title={t('dashboard.due_today', 'Due today')}
                eyebrow={`${dueTodayMine.length}`}
                icon={<CalendarClock className="h-4 w-4 text-brand" />}
              >
                <TaskList tasks={dueTodayMine} />
              </Card>
            )}

            <Card
              title={t('dashboard.upcoming', 'Upcoming')}
              eyebrow={t('dashboard.of_total', '{{shown}} of {{total}}', {
                shown: upcomingMine.length,
                total: allMine.length,
              })}
              icon={<CalendarDays className="h-4 w-4 text-muted-foreground" />}
            >
              {upcomingMine.length === 0 ? (
                <InlineEmpty text={t('dashboard.no_upcoming', 'No upcoming deadlines. Nice.')} />
              ) : (
                <TaskList tasks={upcomingMine} />
              )}
            </Card>

            {blockedMine.length > 0 && (
              <Card
                title={t('dashboard.blocked', 'Blocked')}
                eyebrow={`${blockedMine.length}`}
                tone="warning"
              >
                <TaskList tasks={blockedMine} />
              </Card>
            )}

            {stats && (
              <Card title={t('dashboard.my_open_by_priority', 'My open work by priority')}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {(['Critical', 'High', 'Medium', 'Low'] as Priority[]).map((p) => {
                    const row = stats.openByPriority.find((x) => x.priority === p);
                    const count = row?.count ?? 0;
                    return (
                      <div
                        key={p}
                        className="rounded-md bg-secondary/40 p-4 flex flex-col gap-2 transition-colors hover:bg-secondary/70"
                      >
                        <div className="flex items-center gap-2 nockta-eyebrow text-muted-foreground">
                          <PriorityDot priority={p} />
                          {p}
                        </div>
                        <div className="display-heading text-foreground tabular-nums leading-none" style={{ fontSize: 'clamp(1.6rem, 2.4vw, 2.2rem)' }}>
                          {count}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>

          {/* Right column: activity feed */}
          <div className="space-y-6" data-tour="dashboard-stream">
            <Card
              title={t('dashboard.recent_activity', 'Recent activity')}
              eyebrow={
                activityQuery.data?.items.length
                  ? `${activityQuery.data.items.length}`
                  : undefined
              }
            >
              {activityQuery.isLoading ? (
                <SkeletonList rows={6} rowClassName="h-8" />
              ) : activityQuery.isError ? (
                <QueryErrorState
                  title={t('dashboard.couldnt_load_activity', "Couldn't load activity")}
                  error={activityQuery.error}
                  onRetry={() => void activityQuery.refetch()}
                  className="py-6"
                />
              ) : (activityQuery.data?.items ?? []).length === 0 ? (
                <InlineEmpty text={t('dashboard.no_recent_activity', 'No recent activity yet.')} />
              ) : (
                <ul className="space-y-3.5 stagger-list">
                  {(activityQuery.data?.items ?? []).map((ev) => (
                    <li key={ev.id} className="stagger-item flex items-start gap-2.5">
                      <AvatarCircle
                        user={ev.actor ?? null}
                        size={20}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0 text-xs">
                        <span className="text-foreground font-medium">
                          {ev.actor?.name ?? t('dashboard.system_actor', 'System')}
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
          </div>
        </div>
      </div>

    </div>
  );
}

// -----------------------------------------------------------------------------

/**
 * Logged-time-this-week tile + per-day mini bar chart. Shows the user how
 * much focus time the worklog timer (or manual logs) has captured Monday→now.
 */
/**
 * StandupCard — generates a 3-section "yesterday / today / blockers" standup
 * on demand. The generated markdown is cached in component state so the user
 * can re-open the dashboard without re-paying the LLM cost.
 */
function StandupCard({ userId }: { userId: string }): JSX.Element {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const generate = useMutation({
    mutationFn: () => api.post<{ markdown: string }>(`/ai/users/${userId}/standup`),
    onSuccess: (data) => setMarkdown(data.markdown),
    onError: () => {
      // Toast handled centrally; component just shows a quiet error fallback.
    },
  });

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="nockta-eyebrow text-muted-foreground inline-flex items-center gap-1.5">
            <span className="text-primary">✨</span> Standup
          </p>
          <p className="mt-0.5 text-sm font-semibold">Daily check-in</p>
        </div>
        <button
          type="button"
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition disabled:opacity-50"
        >
          {markdown ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {generate.isPending && !markdown && (
        <p className="text-xs text-muted-foreground">
          Thinking… pulling yesterday's activity and today's open work.
        </p>
      )}
      {!generate.isPending && !markdown && (
        <p className="text-xs text-muted-foreground">
          Click "Generate" to build today's standup from your activity.
        </p>
      )}
      {markdown && (
        <div className="prose prose-invert prose-sm max-w-none whitespace-pre-wrap text-sm">
          {markdown}
        </div>
      )}
    </div>
  );
}

function TimeThisWeek({
  totalSeconds,
  byDay,
  target,
}: {
  totalSeconds: number;
  byDay: { day: string; seconds: number }[];
  /** When the user has set a weekly hours target, render a progress bar
   *  alongside the bar chart and a small "🔥 N week streak" chip. Null hides
   *  the entire target/streak treatment. */
  target: {
    hours: number;
    secondsLogged: number;
    secondsTarget: number;
    hit: boolean;
    streakWeeks: number;
  } | null;
}): JSX.Element {
  // Build a Mon→Sun array seeded with zeros so empty days still render.
  const start = new Date();
  const dow = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  start.setUTCHours(0, 0, 0, 0);
  const days: { label: string; iso: string; seconds: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const found = byDay.find((b) => b.day === iso);
    days.push({
      label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
      iso,
      seconds: found?.seconds ?? 0,
    });
  }
  const max = Math.max(1, ...days.map((d) => d.seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);

  // When a target is set: progress bar + "X / Y h" label, and a streak chip.
  const progressPct = target && target.secondsTarget > 0
    ? Math.min(100, (target.secondsLogged / target.secondsTarget) * 100)
    : 0;

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <div>
          <p className="nockta-eyebrow text-muted-foreground">Time this week</p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums">
            {hours}h {String(mins).padStart(2, '0')}m
            {target && (
              <span className="ml-2 text-sm text-muted-foreground font-normal">
                / {target.hours}h
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          {target && target.streakWeeks > 0 && (
            <span
              title={`${target.streakWeeks} consecutive ${
                target.streakWeeks === 1 ? 'week' : 'weeks'
              } at or above target`}
              className="inline-flex items-center gap-1 rounded-md bg-priority-high/10 px-2 py-0.5 text-[11px] font-medium text-priority-high"
            >
              <Flame className="h-3 w-3" />
              {target.streakWeeks} wk streak
            </span>
          )}
          {!target && (
            <p className="text-xs text-muted-foreground">
              {totalSeconds === 0 ? 'No worklog entries yet this week.' : 'Logged via timer or manual entry.'}
            </p>
          )}
        </div>
      </div>
      {target && (
        <div className="mb-3">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-secondary/60"
            role="progressbar"
            aria-valuenow={Math.round(progressPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Weekly progress: ${Math.round(progressPct)}%`}
          >
            <div
              className={cn(
                'h-full transition-all',
                target.hit ? 'bg-status-done' : 'bg-primary/70',
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {target.hit
              ? "You're at goal for the week."
              : `${Math.round(progressPct)}% of target — keep going.`}
          </p>
        </div>
      )}
      <div className="grid grid-cols-7 gap-2 items-end h-20">
        {days.map((d) => {
          const heightPct = (d.seconds / max) * 100;
          return (
            <div key={d.iso} className="flex flex-col items-center gap-1 h-full justify-end">
              <div
                className={cn(
                  'w-full rounded-t-sm transition-all',
                  d.seconds > 0 ? 'bg-primary/70' : 'bg-secondary/40',
                )}
                style={{ height: `${Math.max(heightPct, 4)}%` }}
                title={d.seconds > 0 ? `${Math.round(d.seconds / 60)} min` : 'No logs'}
              />
              <span className="text-[10px] text-muted-foreground">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatStrip({
  dueToday,
  overdue,
  blocked,
  inProgress,
}: {
  dueToday: number;
  overdue: number;
  blocked: number;
  inProgress: number;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatTile
        icon={<CalendarClock className="h-4 w-4" />}
        label={t('dashboard.due_today', 'Due today')}
        value={dueToday}
        tone={dueToday > 0 ? 'urgent' : undefined}
      />
      <StatTile
        icon={<Flame className="h-4 w-4" />}
        label={t('dashboard.overdue', 'Overdue')}
        value={overdue}
        tone={overdue > 0 ? 'destructive' : undefined}
      />
      <StatTile
        icon={<Ban className="h-4 w-4" />}
        label={t('dashboard.blocked', 'Blocked')}
        value={blocked}
        tone={blocked > 0 ? 'warning' : undefined}
      />
      <StatTile
        icon={<Timer className="h-4 w-4" />}
        label={t('dashboard.in_progress', 'In progress')}
        value={inProgress}
      />
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'destructive' | 'warning' | 'urgent' | undefined;
}): JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card p-4 transition-colors hover:border-ring">
      <div className="relative flex items-center gap-1.5 nockta-eyebrow text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          'relative display-heading mt-1 tabular-nums leading-none',
          tone === 'destructive' && value > 0 && 'text-status-blocked',
          tone === 'warning' && value > 0 && 'text-priority-high',
          tone === 'urgent' && value > 0 && 'text-brand',
        )}
        style={{ fontSize: 'clamp(1.6rem, 2.4vw, 2rem)' }}
      >
        {value}
      </div>
    </div>
  );
}

function Card({
  title,
  eyebrow,
  icon,
  tone,
  children,
}: {
  title: string;
  eyebrow?: string | undefined;
  icon?: React.ReactNode;
  tone?: 'destructive' | 'warning';
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className={cn(
        'relative rounded-lg border bg-card p-5 md:p-6',
        tone === 'destructive' ? 'border-status-blocked/30 shadow-[0_0_0_1px_hsl(var(--status-blocked)/0.08)_inset]' :
        tone === 'warning'     ? 'border-priority-high/30' :
                                 'border-border',
      )}
    >
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-base font-semibold tracking-tight flex items-center gap-1.5">
          {icon}
          {title}
        </h2>
        {eyebrow && (
          <span className="nockta-eyebrow text-muted-foreground">{eyebrow}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function TaskList({ tasks }: { tasks: MyTask[] }): JSX.Element {
  return (
    <ul className="space-y-1.5 stagger-list">
      {tasks.map((t) => (
        <li key={t.id} className="stagger-item">
          <Link
            to={
              t.project
                ? `/projects/${t.project.id}/board?task=${t.id}`
                : '#'
            }
            className="tap card-hover flex items-center gap-3 rounded-md border border-border bg-background/40 hover:bg-background hover:border-ring transition-colors px-3 py-2 text-sm group"
          >
            <TypeBadge type={t.type ?? 'Task'} />
            <PriorityDot priority={t.priority} />
            <span className="text-[11px] font-mono text-muted-foreground shrink-0 w-16">
              {t.key}
            </span>
            <span className="flex-1 truncate">{t.title}</span>
            <BlockedBadge blocked={t.isBlocked} />
            <DueDateChip dueDate={t.dueDate} done={t.status === 'Done'} />
            <StatusPill status={t.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function InlineEmpty({ text }: { text: string }): JSX.Element {
  return <div className="text-xs text-muted-foreground py-2">{text}</div>;
}

function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const PRIORITY_ORDER: Record<Priority, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
function byPriorityThenDue(a: MyTask, b: MyTask): number {
  const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (p !== 0) return p;
  if (!a.dueDate || !b.dueDate) return 0;
  return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
}

function greeting(t: (k: string, d: string) => string): string {
  const h = new Date().getHours();
  if (h < 5) return t('dashboard.greeting_late', 'Working late');
  if (h < 12) return t('dashboard.greeting_morning', 'Good morning');
  if (h < 18) return t('dashboard.greeting_afternoon', 'Good afternoon');
  return t('dashboard.greeting_evening', 'Good evening');
}

function todayLabel(locale?: string): string {
  // Pass the resolved locale so the long weekday + short month respect the
  // user's selected language. Passing `undefined` makes Intl use the
  // browser-default — fine in EN but wrong if they've switched to ES/AR.
  return new Date().toLocaleDateString(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function prettyEvent(t: string): string {
  return t.replace(/[._]/g, ' ').toLowerCase();
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = 60_000, h = 60 * m, d = 24 * h;
  if (diff < m) return 'just now';
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 7 * d) return `${Math.floor(diff / d)}d ago`;
  // Fallback to the user's active locale (rather than browser-default) so a
  // user who switched to ES sees a Spanish date here.
  // We can't use the hook outside of a component; reading i18n.language at
  // call time keeps this pure-ish and dependency-free.
  return new Date(iso).toLocaleDateString(
    (typeof document !== 'undefined' && document.documentElement.lang) || undefined,
  );
}
