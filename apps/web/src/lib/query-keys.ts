/**
 * Centralized React Query key factory.
 *
 * Why: prior to consolidation, the codebase contained ~24 hand-written
 * `['projects']` keys (plus similar families for tasks, sprints, members,
 * etc.). Hand-written keys make it impossible to grep for "every place that
 * caches a project list" reliably, and a typo silently fragments the cache.
 *
 * Rules of the road:
 *   - One entry per query-key *family*. A family is a group of keys that
 *     all start with the same root segment(s) and that you'd ever want to
 *     invalidate together. `queryClient.invalidateQueries({ queryKey: queryKeys.projects() })`
 *     should match every per-project key under the `projects` umbrella;
 *     React Query matches by prefix, so design accordingly.
 *   - Return `as const` tuples so TS narrows to literal-type arrays. This is
 *     what gives you autocomplete on `useQuery({ queryKey: queryKeys.foo() })`.
 *   - Skip one-off keys used in a single call site — adding them here is
 *     pure noise.
 *
 * Convention: a function with NO arguments returns a list-style root key
 * (e.g. `queryKeys.projects()` → `['projects']`); a function WITH arguments
 * returns a more specific key whose first segment matches the corresponding
 * list root so prefix invalidation works (`queryKeys.project(id)` →
 * `['project', id]`).
 */
export const queryKeys = {
  // Project list (the index page, sidebars, pickers).
  projects: () => ['projects'] as const,

  // A single project detail by id.
  // Accepts undefined so callers can pass `useParams()` values directly; pair
  // with `enabled: Boolean(projectId)` to suppress the request until ready.
  project: (projectId: string | undefined) => ['project', projectId] as const,

  // Tasks belonging to a project (board / list views).
  projectTasks: (projectId: string | undefined) => ['tasks', 'project', projectId] as const,

  // Sprint list for a project.
  sprints: (projectId: string | undefined) => ['sprints', projectId] as const,

  // Workspace members (team picker, mentions, assignment dropdowns).
  members: () => ['members'] as const,

  // Workspace teams (settings, project-create wizard).
  teams: () => ['teams'] as const,

  // Admin users list.
  usersList: () => ['users', 'list'] as const,

  // Saved views (per-user persisted filter sets).
  savedViews: () => ['saved-views'] as const,
} as const;
