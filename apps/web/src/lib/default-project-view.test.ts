import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultViewToPath,
  getDefaultProjectView,
  setDefaultProjectView,
  type DefaultProjectView,
} from './default-project-view';

// =============================================================================
// default-project-view — small localStorage-backed preference. Drives the
// "where do I land when I open a project?" routing. Bug-class: if a stale
// or unknown value is read back unchecked, we navigate into a 404.
// =============================================================================

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: new MemoryStorage(),
  };
});

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  }
});

describe('getDefaultProjectView', () => {
  it('falls back to "board" when nothing is stored', () => {
    expect(getDefaultProjectView()).toBe('board');
  });

  it('returns the stored value when it is in the allow-list', () => {
    setDefaultProjectView('dashboard');
    expect(getDefaultProjectView()).toBe('dashboard');
    setDefaultProjectView('timeline');
    expect(getDefaultProjectView()).toBe('timeline');
  });

  it('falls back to "board" if the stored value is not allowed (e.g. legacy or tampered)', () => {
    const w = (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } })
      .window;
    w.localStorage.setItem('nockta.defaultProjectView', 'settings');
    expect(getDefaultProjectView()).toBe('board');
  });
});

describe('defaultViewToPath', () => {
  it('maps each canonical view to its route under /projects/:id', () => {
    expect(defaultViewToPath('p1', 'board')).toBe('/projects/p1/board');
    expect(defaultViewToPath('p1', 'dashboard')).toBe('/projects/p1/dashboard');
    expect(defaultViewToPath('p1', 'backlog')).toBe('/projects/p1/backlog');
    expect(defaultViewToPath('p1', 'timeline')).toBe('/projects/p1/timeline');
  });

  it('routes "list" through the board page with the view query param', () => {
    // Implementation detail: there is no /projects/:id/list — the list tab
    // is the board page with ?view=list. The test pins this so a future
    // route rename or query-param change is loud.
    expect(defaultViewToPath('p1', 'list')).toBe('/projects/p1/board?view=list');
  });

  it('round-trips through setDefaultProjectView → getDefaultProjectView for every allowed view', () => {
    const views: DefaultProjectView[] = ['board', 'dashboard', 'list', 'backlog', 'timeline'];
    for (const v of views) {
      setDefaultProjectView(v);
      expect(getDefaultProjectView()).toBe(v);
    }
  });
});
