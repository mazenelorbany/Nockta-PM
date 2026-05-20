import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';
import { queryKeys } from './query-keys';

// =============================================================================
// project-route — single resolver for project URL params.
//
// URLs used to embed project UUIDs (`/projects/49f12a39-7b2c-…/board`); now we
// emit the project KEY instead (`/projects/ACME/board`). The route param
// stays named `projectId` for backwards compatibility — pages don't have to
// migrate `useParams` shape — but the value it carries may be EITHER a UUID
// (legacy bookmarks) or an uppercase project key (the new default).
//
// useResolvedProject takes that raw param and:
//   1. Looks it up in the cached `/projects` list (no extra fetch most of
//      the time — sidebar, project tree, and most pages already prime it).
//   2. Falls back to a one-off detail fetch when the cache doesn't contain
//      a match (e.g. a deep-link landing on a project that hasn't been
//      listed yet, or a UUID-shaped param when the projects list only
//      indexed keys).
//   3. Resolves to the canonical `Project` record so callers always have
//      `project.id` for API calls and `project.key` for navigation.
//
// On a UUID landing, the hook also fires a one-time `replace` navigation to
// the key-based URL so the address bar matches the new convention. Old
// bookmarks therefore self-heal: the user lands, the URL is rewritten in
// place, and any further navigation emits keys.
// =============================================================================

export interface ResolvedProject {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
  archivedAt: string | null;
}

// Project key shape, mirrored from the backend DTO (`@Matches(/^[A-Z]{2,10}$/)`).
// Anything matching this regex is treated as a key candidate; anything else
// is treated as a UUID. We don't fully validate UUIDs — the API will reject
// malformed values, and the resolver returns `isUnknown` so the page can
// render a "project not found" state.
const KEY_PATTERN = /^[A-Z][A-Z0-9_-]{0,15}$/;

export function looksLikeKey(param: string): boolean {
  return KEY_PATTERN.test(param);
}

/**
 * Read the project segment from the URL (`/projects/:projectId/...`).
 * Returns the raw value — it may be either a UUID or a project key.
 */
export function useProjectParam(): string {
  const { projectId = '' } = useParams<{ projectId: string }>();
  return projectId;
}

/**
 * Resolve the project URL param to a canonical Project record.
 *
 * Returns `project: null` when the lookup hasn't completed yet OR when the
 * param matches nothing in the cached projects list (and the detail fetch
 * also 404s). Pages should branch on `isLoading` for "still resolving" and
 * `isUnknown` for "param doesn't match any project I can see".
 */
export function useResolvedProject(): {
  project: ResolvedProject | null;
  /** Canonical project id for API calls. Stable string once project is loaded. */
  projectId: string;
  /** Canonical project key for URL construction. Falls back to id when key absent. */
  projectKey: string;
  isLoading: boolean;
  isUnknown: boolean;
  /** The raw URL param as-is (may be key or UUID). */
  rawParam: string;
} {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const rawParam = useProjectParam();

  // Cached project list — primed by the sidebar (which renders on every
  // protected route). Hitting it is a no-op in the common case.
  const listQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => api.get<ResolvedProject[]>('/projects'),
  });

  const project = useMemo<ResolvedProject | null>(() => {
    if (!rawParam || !listQuery.data) return null;
    if (looksLikeKey(rawParam)) {
      return listQuery.data.find((p) => p.key === rawParam) ?? null;
    }
    return listQuery.data.find((p) => p.id === rawParam) ?? null;
  }, [rawParam, listQuery.data]);

  // One-shot URL rewrite: if the address bar has a UUID but we know the key,
  // replace the URL so the user sees the slug. `replace: true` so the back
  // button still works as if they landed on the key version directly.
  useEffect(() => {
    if (!project) return;
    if (!project.key) return;
    if (rawParam === project.key) return;
    if (!looksLikeKey(rawParam)) {
      const nextPath = location.pathname.replace(
        `/projects/${rawParam}`,
        `/projects/${project.key}`,
      );
      if (nextPath !== location.pathname) {
        navigate({ pathname: nextPath, search: location.search, hash: location.hash }, { replace: true });
      }
    }
  }, [project, rawParam, location.pathname, location.search, location.hash, navigate]);

  // Prime the per-id project query cache so downstream `queryKeys.project(id)`
  // consumers hit warm cache when they later look up by canonical id.
  useEffect(() => {
    if (!project) return;
    queryClient.setQueryData(queryKeys.project(project.id), project);
  }, [project, queryClient]);

  const isLoading = listQuery.isLoading;
  const isUnknown =
    !isLoading && listQuery.isSuccess && project === null;

  return {
    project,
    projectId: project?.id ?? '',
    projectKey: project?.key ?? rawParam,
    isLoading,
    isUnknown,
    rawParam,
  };
}

/**
 * Build a path under `/projects/<slug>/...`. Pass the project (so we have
 * `.key`) or just the key/id; the helper picks `.key` first and falls back
 * to `.id` if a key isn't available (e.g. transitional rendering before the
 * project list has loaded).
 *
 * `subpath` is the segment AFTER the project — pass it WITHOUT a leading
 * slash (the function adds one) so call sites don't have to remember.
 */
export function projectPath(
  projectOrSlug:
    | { id: string; key?: string | null }
    | string
    | null
    | undefined,
  subpath = '',
): string {
  const slug =
    typeof projectOrSlug === 'string'
      ? projectOrSlug
      : projectOrSlug?.key ?? projectOrSlug?.id ?? '';
  if (!slug) return '/projects';
  const tail = subpath ? `/${subpath.replace(/^\/+/, '')}` : '';
  return `/projects/${slug}${tail}`;
}
