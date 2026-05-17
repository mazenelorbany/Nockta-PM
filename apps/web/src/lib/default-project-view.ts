// Default-project-view preference. Persisted in localStorage so the user's
// choice survives reloads without a round-trip to the API. The legal set
// is intentionally narrow — only the routes that make sense as a
// "I land on this when I open a project" home: board / dashboard / list /
// backlog / timeline. Hidden routes (worklog, deployments, automations,
// settings) are not picked as defaults because they aren't where most users
// start.
export type DefaultProjectView = 'board' | 'dashboard' | 'list' | 'backlog' | 'timeline';

const KEY = 'nockta.defaultProjectView';
const FALLBACK: DefaultProjectView = 'board';
const ALLOWED: readonly DefaultProjectView[] = ['board', 'dashboard', 'list', 'backlog', 'timeline'];

export function getDefaultProjectView(): DefaultProjectView {
  if (typeof window === 'undefined') return FALLBACK;
  const raw = window.localStorage.getItem(KEY);
  if (raw && (ALLOWED as readonly string[]).includes(raw)) {
    return raw as DefaultProjectView;
  }
  return FALLBACK;
}

export function setDefaultProjectView(view: DefaultProjectView): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(KEY, view);
}

/** Map a default-view value to the path segment under `/projects/:id/`.
 *  `list` is the board route with `?view=list` (the toolbar treats them as
 *  peer tabs). */
export function defaultViewToPath(projectId: string, view: DefaultProjectView): string {
  if (view === 'list') return `/projects/${projectId}/board?view=list`;
  return `/projects/${projectId}/${view}`;
}
