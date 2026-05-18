import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRecents, saveRecent } from './recents';
import { RECENTS_KEY, RECENTS_MAX } from './types';

// =============================================================================
// recents.ts — Cmd+K "recently visited" cache, backed by localStorage. The
// Node test env doesn't ship one, so we install a tiny in-memory shim.
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

const original = (globalThis as { localStorage?: unknown }).localStorage;

beforeEach(() => {
  (globalThis as { localStorage: unknown }).localStorage = new MemoryStorage();
});

afterEach(() => {
  if (original === undefined) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  } else {
    (globalThis as { localStorage: unknown }).localStorage = original;
  }
});

describe('loadRecents', () => {
  it('returns [] when nothing has been saved', () => {
    expect(loadRecents()).toEqual([]);
  });

  it('returns [] when the cache is junk', () => {
    localStorage.setItem(RECENTS_KEY, '{not json');
    expect(loadRecents()).toEqual([]);
  });

  it('returns [] when the cache is non-array JSON', () => {
    localStorage.setItem(RECENTS_KEY, '{"oops": true}');
    expect(loadRecents()).toEqual([]);
  });

  it('clamps reads to RECENTS_MAX entries', () => {
    const many = Array.from({ length: RECENTS_MAX + 4 }, (_, i) => ({
      id: `id-${i}`,
      label: `Entry ${i}`,
      to: `/x/${i}`,
      type: 'task' as const,
      visitedAt: i,
    }));
    localStorage.setItem(RECENTS_KEY, JSON.stringify(many));
    expect(loadRecents()).toHaveLength(RECENTS_MAX);
  });
});

describe('saveRecent', () => {
  it('writes a new entry at the head of the list', () => {
    saveRecent({ id: 'a', label: 'A', to: '/t/a', type: 'task' });
    saveRecent({ id: 'b', label: 'B', to: '/t/b', type: 'task' });
    const r = loadRecents();
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('dedupes — adding an existing id moves it to the head, not duplicates', () => {
    saveRecent({ id: 'a', label: 'A', to: '/t/a', type: 'task' });
    saveRecent({ id: 'b', label: 'B', to: '/t/b', type: 'task' });
    saveRecent({ id: 'a', label: 'A again', to: '/t/a', type: 'task' });
    const r = loadRecents();
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r[0]?.label).toBe('A again');
  });

  it('keeps the list capped at RECENTS_MAX after many writes', () => {
    for (let i = 0; i < RECENTS_MAX + 5; i++) {
      saveRecent({ id: `id-${i}`, label: `L${i}`, to: `/t/${i}`, type: 'task' });
    }
    const r = loadRecents();
    expect(r).toHaveLength(RECENTS_MAX);
    // Head is the most recent write.
    expect(r[0]?.id).toBe(`id-${RECENTS_MAX + 4}`);
  });

  it('stamps each entry with a visitedAt timestamp', () => {
    saveRecent({ id: 'a', label: 'A', to: '/t/a', type: 'task' });
    const [entry] = loadRecents();
    expect(typeof entry?.visitedAt).toBe('number');
    expect(entry?.visitedAt).toBeGreaterThan(0);
  });
});
