import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from '@nockta/sdk';

// =============================================================================
// SDK retry path — exercised through createClient with a fake fetch.
//
// We don't import apps/web's `lib/api.ts` here because that module wires the
// SDK to a zustand store with localStorage persistence. The retry logic
// itself lives in @nockta/sdk and is what we care about: 401 → call
// onUnauthorized → if it returns a token, retry once with the new bearer.
//
// Pinning this is high-leverage: every authenticated request in the app
// flows through it, and a regression silently logs users out.
// =============================================================================

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function emptyResponse(status: number): Response {
  // Per the Fetch spec, Response(body, ...) rejects status 204/205/304 with
  // a non-null body. Pass null so the constructor accepts both 200 and 204.
  return new Response(null, { status, headers: { 'content-length': '0' } });
}

describe('createClient — happy path', () => {
  it('attaches the Authorization header on every request', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = createClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => 'tok-1',
      fetch: fetchSpy,
    });
    const res = await client.get<{ ok: boolean }>('/widgets');
    expect(res).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/widgets');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-1');
  });

  it('omits Authorization when no token is available', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = createClient({
      baseUrl: 'https://api.test/v1',
      getAccessToken: () => null,
      fetch: fetchSpy,
    });
    await client.get('/public');
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('serializes JSON bodies on POST/PATCH/PUT and sets content-type', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = createClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => null,
      fetch: fetchSpy,
    });
    await client.post('/x', { foo: 'bar' });
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).body).toBe(JSON.stringify({ foo: 'bar' }));
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns undefined for 204 No Content and empty 200 bodies', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(emptyResponse(200));
    const client = createClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => null,
      fetch: fetchSpy,
    });
    await expect(client.delete('/a')).resolves.toBeUndefined();
    await expect(client.get('/b')).resolves.toBeUndefined();
  });
});

describe('createClient — 401 refresh + retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on 401: calls onUnauthorized, retries with the new bearer, returns success', async () => {
    const fetchSpy = vi
      .fn()
      // First call: 401 with the old token.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }),
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      )
      // Retry: success.
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const onUnauthorized = vi.fn().mockResolvedValue('NEW-TOK');
    let token = 'OLD-TOK';
    const client = createClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => token,
      onUnauthorized: async () => {
        token = (await onUnauthorized()) as string;
        return token;
      },
      fetch: fetchSpy,
    });

    const res = await client.get<{ ok: boolean }>('/me');
    expect(res).toEqual({ ok: true });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // First request used the OLD token.
    const firstHeaders = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe('Bearer OLD-TOK');
    // Retry used the NEW token.
    const retryHeaders = (fetchSpy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer NEW-TOK');
  });

  it('on 401 with no onUnauthorized handler: throws ApiError immediately', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }),
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const client = createClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'tok',
      fetch: fetchSpy,
    });
    await expect(client.get('/me')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('on 401 with onUnauthorized returning null (refresh failed): throws ApiError, no retry', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Unauthorized', status: 401 }),
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const client = createClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'tok',
      onUnauthorized: async () => null,
      fetch: fetchSpy,
    });
    await expect(client.get('/me')).rejects.toBeInstanceOf(ApiError);
    // No retry — only one fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createClient — error parsing', () => {
  it('parses a problem+json body into ApiError.problem', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'about:blank', title: 'Validation', status: 422, detail: 'bad input' }),
        { status: 422, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const client = createClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => null,
      fetch: fetchSpy,
    });
    try {
      await client.get('/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(422);
      expect(apiErr.problem.title).toBe('Validation');
      expect(apiErr.problem.detail).toBe('bad input');
    }
  });

  it('falls back to status text when the body is not JSON', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('not json', { status: 500, statusText: 'Internal Server Error' }),
    );
    const client = createClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => null,
      fetch: fetchSpy,
    });
    await expect(client.get('/x')).rejects.toMatchObject({
      status: 500,
      problem: { title: 'Internal Server Error', status: 500 },
    });
  });
});
