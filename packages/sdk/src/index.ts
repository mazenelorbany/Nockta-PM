// =============================================================================
// @nockta/sdk — typed HTTP client used by web and client apps.
// Endpoint methods are added as the API grows. The client owns auth-header
// injection, refresh-token rotation, and request/response typing.
// =============================================================================

import type { Paginated, ProblemDetails } from '@nockta/types';

export interface SdkConfig {
  baseUrl: string;
  /** Returns the current access token or null. The SDK calls this on every request. */
  getAccessToken: () => string | null;
  /** Called when the server returns 401 — should refresh the token and return a new one, or null on failure. */
  onUnauthorized?: () => Promise<string | null>;
  /** Optional fetch override (e.g. for tests, or to pipe through React Native's fetch). */
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public problem: ProblemDetails,
  ) {
    super(problem.title || `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  /** GET — typed JSON response, throws ApiError on non-2xx. */
  get<T>(path: string, init?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  delete<T>(path: string, init?: RequestInit): Promise<T>;
  /** Convenience: paginated list with cursor handling. */
  list<T>(path: string, params?: { cursor?: string; limit?: number }): Promise<Paginated<T>>;
}

export function createClient(config: SdkConfig): ApiClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('No fetch implementation available — supply one via SdkConfig.fetch');
  }

  async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const doFetch = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const fetchInit: RequestInit = {
        ...init,
        method,
        headers,
      };
      if (body !== undefined) fetchInit.body = JSON.stringify(body);
      return fetchImpl(`${config.baseUrl}${path}`, fetchInit);
    };

    let response = await doFetch(config.getAccessToken());
    if (response.status === 401 && config.onUnauthorized) {
      const newToken = await config.onUnauthorized();
      if (newToken) response = await doFetch(newToken);
    }

    if (!response.ok) {
      let problem: ProblemDetails;
      try {
        problem = (await response.json()) as ProblemDetails;
      } catch {
        problem = {
          type: 'about:blank',
          title: response.statusText || 'Request failed',
          status: response.status,
        };
      }
      throw new ApiError(response.status, problem);
    }

    if (response.status === 204) return undefined as T;
    // Defensive: some void-returning endpoints respond 200 with no body.
    // Prefer Content-Length when present; fall back to text() then parse so
    // an empty payload becomes `undefined` instead of a JSON parse error.
    const len = response.headers.get('content-length');
    if (len === '0') return undefined as T;
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    get: (path, init) => request('GET', path, undefined, init),
    post: (path, body, init) => request('POST', path, body, init),
    patch: (path, body, init) => request('PATCH', path, body, init),
    put: (path, body, init) => request('PUT', path, body, init),
    delete: (path, init) => request('DELETE', path, undefined, init),
    list: async (path, params) => {
      const qs = new URLSearchParams();
      if (params?.cursor) qs.set('cursor', params.cursor);
      if (params?.limit !== undefined) qs.set('limit', String(params.limit));
      const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
      return request('GET', `${path}${suffix}`);
    },
  };
}
