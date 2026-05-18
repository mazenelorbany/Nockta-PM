import { useEffect, useState } from 'react';

// -----------------------------------------------------------------------------
// Recent-projects tracker.
//
// Jira-style "Spaces" picker: we keep a small ordered list of recently-visited
// project ids in localStorage. The sidebar shows the top N inline; everything
// else lives behind the "More projects" popover. New visits push to the front,
// duplicates dedupe, the list is capped so it doesn't grow forever.
//
// Cross-tab sync via the `storage` event so opening a project in a second tab
// reorders the first tab's sidebar too.
// -----------------------------------------------------------------------------

const RECENT_PROJECTS_KEY = 'nockta:recent-projects';
const RECENT_PROJECTS_CAP = 20;

function readRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_PROJECTS_CAP);
  } catch {
    return [];
  }
}

export function pushRecentProject(id: string): void {
  try {
    const current = readRecentProjects();
    const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_PROJECTS_CAP);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
    // Notify same-tab listeners (the storage event only fires in *other* tabs).
    window.dispatchEvent(new CustomEvent('nockta:recent-projects-changed'));
  } catch {
    /* ignore */
  }
}

export function useRecentProjects(): string[] {
  const [ids, setIds] = useState<string[]>(() => readRecentProjects());
  useEffect(() => {
    function refresh(): void {
      setIds(readRecentProjects());
    }
    window.addEventListener('storage', refresh);
    window.addEventListener('nockta:recent-projects-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('nockta:recent-projects-changed', refresh);
    };
  }, []);
  return ids;
}
