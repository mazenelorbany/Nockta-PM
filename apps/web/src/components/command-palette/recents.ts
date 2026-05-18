import { RECENTS_KEY, RECENTS_MAX, type RecentEntry } from './types';

export function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentEntry[];
    return Array.isArray(parsed) ? parsed.slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}
export function saveRecent(entry: Omit<RecentEntry, 'visitedAt'>): void {
  try {
    const cur = loadRecents().filter((r) => r.id !== entry.id);
    const next: RecentEntry[] = [{ ...entry, visitedAt: Date.now() }, ...cur].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {/* ignore */}
}
