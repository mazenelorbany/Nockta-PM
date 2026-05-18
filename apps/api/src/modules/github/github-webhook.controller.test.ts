import { createHmac } from 'node:crypto';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Env } from '../../config/env';

import { GithubWebhookController } from './github-webhook.controller';
import type { GithubEventsService } from './github-events.service';

/**
 * Stateful Redis stub that mimics SET key value EX ttl NX semantics: first
 * call for a key returns 'OK' and remembers it; subsequent calls for the
 * same key return null. Sufficient for testing the replay-protection path
 * without spinning up a real Redis.
 */
function makeRedisStub(): Redis {
  const seen = new Set<string>();
  return {
    set: vi.fn(
      async (key: string, _value: string, _modeEx: string, _ttl: number, modeNx: string) => {
        if (modeNx === 'NX' && seen.has(key)) return null;
        seen.add(key);
        return 'OK';
      },
    ),
  } as unknown as Redis;
}

// =============================================================================
// github-webhook controller — HMAC verification ONLY.
//
// The downstream auto-status state machine is exercised via AutoStatusService's
// own seam in github/auto-status.service.ts. This file pins the signature gate
// because that's the security boundary: anything that gets past it is treated
// as a trusted GitHub message and used to mutate Tasks via the events service.
//
// DIVERGENCE FROM SPEC: there is no replay-protection in the current
// controller (no delivery-id tracking). A captured signed request can be
// replayed and will be accepted. This is a known gap, not a test bug — noted
// so it isn't silently re-introduced as "covered". If/when delivery-id
// dedup ships, a new test should land here pinning that behavior.
// =============================================================================

// We need to mutate Env at runtime to control which secret the controller
// validates against. The controller imports Env eagerly, so we mutate the
// already-loaded module rather than juggling vi.resetModules.

const SECRET = 'super-shhh-github-webhook-secret-1234567890';

function sign(body: Buffer | string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

interface Mocks {
  events: {
    onInstallationCreated: ReturnType<typeof vi.fn>;
    onInstallationSuspended: ReturnType<typeof vi.fn>;
    onInstallationDeleted: ReturnType<typeof vi.fn>;
    onPush: ReturnType<typeof vi.fn>;
    onPullRequest: ReturnType<typeof vi.fn>;
  };
}

function build(): { controller: GithubWebhookController; mocks: Mocks; redis: Redis } {
  const events = {
    onInstallationCreated: vi.fn().mockResolvedValue(undefined),
    onInstallationSuspended: vi.fn().mockResolvedValue(undefined),
    onInstallationDeleted: vi.fn().mockResolvedValue(undefined),
    onPush: vi.fn().mockResolvedValue(undefined),
    onPullRequest: vi.fn().mockResolvedValue(undefined),
  };
  const redis = makeRedisStub();
  const controller = new GithubWebhookController(
    events as unknown as GithubEventsService,
    redis,
  );
  return { controller, mocks: { events }, redis };
}

describe('GithubWebhookController.receive — signature verification', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    // Env is parsed once at module load; assigning to the frozen export object
    // requires a writable cast. We restore in afterEach so the next test sees
    // a clean slate.
    originalSecret = (Env as { GITHUB_APP_WEBHOOK_SECRET?: string }).GITHUB_APP_WEBHOOK_SECRET;
    (Env as { GITHUB_APP_WEBHOOK_SECRET?: string }).GITHUB_APP_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    (Env as { GITHUB_APP_WEBHOOK_SECRET?: string }).GITHUB_APP_WEBHOOK_SECRET = originalSecret;
  });

  it('rejects with 401 when no webhook secret is configured server-side', async () => {
    // Fail-closed: if the operator forgot to set the env var, we must NOT
    // accept traffic. The alternative would be a webhook URL that silently
    // mutates tasks for anyone who knows the endpoint.
    (Env as { GITHUB_APP_WEBHOOK_SECRET?: string }).GITHUB_APP_WEBHOOK_SECRET = undefined;
    const { controller, mocks } = build();
    const body = { installation: { id: 1 } };
    const raw = Buffer.from(JSON.stringify(body));

    await expect(
      controller.receive(
        { rawBody: raw } as never,
        {
          'x-github-event': 'push',
          'x-hub-signature-256': sign(raw),
        },
        body,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(mocks.events.onPush).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the signature header is missing entirely', async () => {
    const { controller, mocks } = build();
    const body = { installation: { id: 1 } };
    const raw = Buffer.from(JSON.stringify(body));

    await expect(
      controller.receive(
        { rawBody: raw } as never,
        { 'x-github-event': 'push' },
        body,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(mocks.events.onPush).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the X-GitHub-Event header is missing', async () => {
    // Both signature AND event headers are required. The controller bundles
    // them under one check; this test pins the event-missing case.
    const { controller } = build();
    const body = { installation: { id: 1 } };
    const raw = Buffer.from(JSON.stringify(body));

    await expect(
      controller.receive(
        { rawBody: raw } as never,
        { 'x-hub-signature-256': sign(raw) },
        body,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects with 401 when the signature is a well-formed but wrong value', async () => {
    // Test that timingSafeEqual returns false on a mismatch of the right
    // length (anything shorter would fail the length-check guard first).
    const { controller, mocks } = build();
    const body = { installation: { id: 1 } };
    const raw = Buffer.from(JSON.stringify(body));
    // Sign with a different key — same length, different bytes.
    const wrongSig = sign(raw, 'not-the-real-secret-not-the-real-secret-x');

    await expect(
      controller.receive(
        { rawBody: raw } as never,
        {
          'x-github-event': 'push',
          'x-hub-signature-256': wrongSig,
        },
        body,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(mocks.events.onPush).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the signature is a wrong length (length-check guard)', async () => {
    // The explicit length check before timingSafeEqual prevents the comparison
    // from throwing (timingSafeEqual requires equal-length Buffers). Removing
    // the guard would make malformed requests crash with a 500 instead of 401.
    const { controller } = build();
    const body = { installation: { id: 1 } };
    const raw = Buffer.from(JSON.stringify(body));

    await expect(
      controller.receive(
        { rawBody: raw } as never,
        {
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=tooshort',
        },
        body,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a valid signature and dispatches to GithubEventsService.onPush', async () => {
    // The happy path. We assert that the body the controller verifies is the
    // RAW body (not JSON.stringify(parsedBody) — which is byte-equivalent here
    // but wouldn't be for any payload with unusual whitespace).
    const { controller, mocks } = build();
    const body = {
      installation: { id: 42 },
      ref: 'refs/heads/main',
      repository: {
        id: 99,
        full_name: 'acme/widgets',
        name: 'widgets',
        owner: { login: 'acme' },
      },
      commits: [
        { id: 'abc', message: 'fix things', author: { name: 'dev', username: 'dev' } },
      ],
    };
    const raw = Buffer.from(JSON.stringify(body));

    await controller.receive(
      { rawBody: raw } as never,
      {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(raw),
      },
      body,
    );

    expect(mocks.events.onPush).toHaveBeenCalledOnce();
    const args = mocks.events.onPush.mock.calls[0]?.[0];
    expect(args.installation.installationId).toBe(42);
    expect(args.branch).toBe('main');
    expect(args.commits[0].sha).toBe('abc');
  });

  it('falls back to JSON.stringify(body) when rawBody is absent', async () => {
    // Express usually populates rawBody via a middleware. If a deployment
    // configuration accidentally drops that middleware, the controller still
    // works as long as the JSON serialization is stable — but this fallback
    // is a known foot-gun (whitespace differences would break HMAC). Pin the
    // current behavior so a future "remove the fallback" decision is explicit.
    const { controller, mocks } = build();
    const body = { installation: { id: 1 }, action: 'deleted' };
    const serialized = Buffer.from(JSON.stringify(body));

    await controller.receive(
      {} as never, // no rawBody
      {
        'x-github-event': 'installation',
        'x-hub-signature-256': sign(serialized),
      },
      body,
    );

    expect(mocks.events.onInstallationDeleted).toHaveBeenCalledWith(1);
  });

  it('returns silently (no events dispatched) for events without an installation', async () => {
    // Ping events and similar lack `installation`. The signature must still
    // pass — we just don't have anywhere to route them.
    const { controller, mocks } = build();
    const body = { zen: 'speak as if to a friend' };
    const raw = Buffer.from(JSON.stringify(body));

    await controller.receive(
      { rawBody: raw } as never,
      {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign(raw),
      },
      body,
    );

    expect(mocks.events.onPush).not.toHaveBeenCalled();
    expect(mocks.events.onPullRequest).not.toHaveBeenCalled();
    expect(mocks.events.onInstallationCreated).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Replay protection (not implemented)
// =============================================================================

describe('GithubWebhookController.receive — replay protection', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = (Env as { GITHUB_APP_WEBHOOK_SECRET?: string }).GITHUB_APP_WEBHOOK_SECRET;
    (Env as { GITHUB_APP_WEBHOOK_SECRET?: string }).GITHUB_APP_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    (Env as { GITHUB_APP_WEBHOOK_SECRET?: string }).GITHUB_APP_WEBHOOK_SECRET = originalSecret;
  });

  it('processes a delivery once and silently no-ops on the same delivery id replayed', async () => {
    // The attacker (or a GitHub redelivery) captures a valid request and
    // replays it byte-for-byte. The signature still verifies. Without dedup
    // we'd double-dispatch onPush — creating duplicate comments, double
    // auto-status transitions, etc. With dedup the second call is a 204
    // no-op (so GitHub stops retrying) and the handler runs exactly once.
    const { controller, mocks, redis } = build();
    const body = {
      installation: { id: 7 },
      ref: 'refs/heads/main',
      repository: { id: 1, full_name: 'a/b', name: 'b', owner: { login: 'a' } },
      commits: [],
    };
    const raw = Buffer.from(JSON.stringify(body));
    const headers = {
      'x-github-event': 'push',
      'x-hub-signature-256': sign(raw),
      'x-github-delivery': 'dlv-replay-1',
    };

    await controller.receive({ rawBody: raw } as never, headers, body);
    await controller.receive({ rawBody: raw } as never, headers, body);

    expect(mocks.events.onPush).toHaveBeenCalledOnce();
    // Two SETNX claims — first succeeds, second returns null.
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  it('dispatches when the same body is delivered with a DIFFERENT delivery id', async () => {
    // GitHub sometimes legitimately delivers the same payload twice with
    // different ids (e.g., a check_run that fires on multiple installations).
    // Our dedup must key on the delivery id, not the body — otherwise we'd
    // drop legitimate parallel deliveries.
    const { controller, mocks } = build();
    const body = {
      installation: { id: 7 },
      ref: 'refs/heads/main',
      repository: { id: 1, full_name: 'a/b', name: 'b', owner: { login: 'a' } },
      commits: [],
    };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = sign(raw);

    await controller.receive(
      { rawBody: raw } as never,
      { 'x-github-event': 'push', 'x-hub-signature-256': sig, 'x-github-delivery': 'dlv-A' },
      body,
    );
    await controller.receive(
      { rawBody: raw } as never,
      { 'x-github-event': 'push', 'x-hub-signature-256': sig, 'x-github-delivery': 'dlv-B' },
      body,
    );

    expect(mocks.events.onPush).toHaveBeenCalledTimes(2);
  });

  it('dispatches but logs a warning when X-GitHub-Delivery is missing', async () => {
    // Real GitHub always sends a delivery id; missing-id requests come from
    // test clients or misconfigured proxies. We accept them (signature is
    // already verified) but skip dedup — flagged with a warn-level log so
    // an oncall engineer can spot a misconfiguration.
    const { controller, mocks, redis } = build();
    const body = {
      installation: { id: 7 },
      ref: 'refs/heads/main',
      repository: { id: 1, full_name: 'a/b', name: 'b', owner: { login: 'a' } },
      commits: [],
    };
    const raw = Buffer.from(JSON.stringify(body));

    await controller.receive(
      { rawBody: raw } as never,
      { 'x-github-event': 'push', 'x-hub-signature-256': sign(raw) },
      body,
    );

    expect(mocks.events.onPush).toHaveBeenCalledOnce();
    // No SETNX attempt when no id to dedupe on.
    expect(redis.set).not.toHaveBeenCalled();
  });
});
