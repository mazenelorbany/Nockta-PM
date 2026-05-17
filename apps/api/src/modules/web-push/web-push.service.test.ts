import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebPushService, type PushDriver } from './web-push.service';
import { makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// web-push.service — covers:
//   - subscribe() upserts by endpoint and pins the row to the calling user.
//   - dispatch() fans out one .send per stored subscription.
//   - 410 Gone responses prune the row from the DB.
//   - non-410 errors are tolerated (other endpoints keep flowing).
// =============================================================================

interface Build {
  service: WebPushService;
  prisma: PrismaService;
  driver: { send: ReturnType<typeof vi.fn>; setVapidDetails: ReturnType<typeof vi.fn> };
  pushSub: Record<string, ReturnType<typeof vi.fn>>;
}

function build(): Build {
  const prisma = makePrismaMock();
  // The default mock factory doesn't ship a `pushSubscription` model (it's
  // brand new) — hand-shape the methods this service uses. Same pattern as
  // worklog.service.test.ts.
  const pushSub = {
    upsert: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  (prisma as unknown as { pushSubscription: typeof pushSub }).pushSubscription = pushSub;

  const driver: PushDriver & { send: ReturnType<typeof vi.fn>; setVapidDetails: ReturnType<typeof vi.fn> } = {
    send: vi.fn().mockResolvedValue(undefined),
    setVapidDetails: vi.fn(),
  };

  // Env is parsed once at module load — in the unit-test sandbox the VAPID
  // keys are typically absent, which would short-circuit dispatch() with
  // `configured=false`. The TestableWebPushService subclass below exposes a
  // setter so we can force the configured flag on without monkey-patching
  // the module's cached Env object.
  const service = new TestableWebPushService(prisma, driver as PushDriver);
  service.forceConfigured(true);

  return { service, prisma, driver, pushSub };
}

class TestableWebPushService extends WebPushService {
  forceConfigured(v: boolean): void {
    (this as unknown as { configured: boolean }).configured = v;
  }
}

const USER_ID = 'user-1';

describe('WebPushService.subscribe', () => {
  let b: Build;
  beforeEach(() => {
    b = build();
  });

  it('upserts the subscription keyed by endpoint and pins it to the user', async () => {
    b.pushSub.upsert.mockResolvedValueOnce({ id: 'sub-1' });
    const out = await b.service.subscribe(USER_ID, {
      endpoint: 'https://fcm/abc',
      keys: { p256dh: 'p256-key', auth: 'auth-key' },
      label: 'Chrome on Mac',
    });
    expect(out).toEqual({ id: 'sub-1' });
    const args = b.pushSub.upsert.mock.calls[0]?.[0];
    expect(args.where).toEqual({ endpoint: 'https://fcm/abc' });
    expect(args.update).toMatchObject({
      userId: USER_ID,
      p256dh: 'p256-key',
      auth: 'auth-key',
      label: 'Chrome on Mac',
    });
    expect(args.create).toMatchObject({
      userId: USER_ID,
      endpoint: 'https://fcm/abc',
      p256dh: 'p256-key',
      auth: 'auth-key',
      label: 'Chrome on Mac',
    });
    expect(args.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it('omits the label when not supplied (no nullable label overwrite on re-subscribe)', async () => {
    b.pushSub.upsert.mockResolvedValueOnce({ id: 'sub-1' });
    await b.service.subscribe(USER_ID, {
      endpoint: 'https://fcm/abc',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const args = b.pushSub.upsert.mock.calls[0]?.[0];
    expect(args.update.label).toBeUndefined();
    expect(args.create.label).toBeNull();
  });
});

describe('WebPushService.unsubscribe', () => {
  it('only deletes rows owned by the calling user', async () => {
    const b = build();
    b.pushSub.deleteMany.mockResolvedValueOnce({ count: 1 });
    await b.service.unsubscribe(USER_ID, 'https://fcm/abc');
    expect(b.pushSub.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, endpoint: 'https://fcm/abc' },
    });
  });
});

describe('WebPushService.dispatch', () => {
  let b: Build;
  beforeEach(() => {
    b = build();
  });

  it('fans out one send per stored subscription', async () => {
    b.pushSub.findMany.mockResolvedValueOnce([
      { id: 's1', endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
      { id: 's2', endpoint: 'e2', p256dh: 'p2', auth: 'a2' },
      { id: 's3', endpoint: 'e3', p256dh: 'p3', auth: 'a3' },
    ]);

    const out = await b.service.dispatch(USER_ID, {
      title: 'Assigned to you',
      body: 'Login bug',
      url: '/?task=abc',
    });

    expect(b.driver.send).toHaveBeenCalledTimes(3);
    expect(out.sent).toBe(3);
    expect(out.pruned).toBe(0);
    // Payload is serialized as JSON exactly once per send.
    const payload = b.driver.send.mock.calls[0]?.[1];
    expect(typeof payload).toBe('string');
    expect(JSON.parse(payload as string)).toEqual({
      title: 'Assigned to you',
      body: 'Login bug',
      url: '/?task=abc',
    });
  });

  it('prunes endpoints that return 410 Gone', async () => {
    b.pushSub.findMany.mockResolvedValueOnce([
      { id: 's-live', endpoint: 'live', p256dh: 'p', auth: 'a' },
      { id: 's-dead', endpoint: 'dead', p256dh: 'p', auth: 'a' },
    ]);
    b.driver.send.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === 'dead') {
        const err = new Error('gone') as Error & { statusCode?: number };
        err.statusCode = 410;
        throw err;
      }
    });
    b.pushSub.delete.mockResolvedValue({});

    const out = await b.service.dispatch(USER_ID, {
      title: 't',
      body: 'b',
    });

    expect(out.sent).toBe(1);
    expect(out.pruned).toBe(1);
    expect(b.pushSub.delete).toHaveBeenCalledWith({ where: { id: 's-dead' } });
  });

  it('also prunes on 404 (some push services use 404 instead of 410)', async () => {
    b.pushSub.findMany.mockResolvedValueOnce([
      { id: 's-dead', endpoint: 'dead', p256dh: 'p', auth: 'a' },
    ]);
    b.driver.send.mockImplementation(async () => {
      const err = new Error('not found') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    });
    b.pushSub.delete.mockResolvedValue({});

    const out = await b.service.dispatch(USER_ID, { title: 't', body: 'b' });

    expect(out.pruned).toBe(1);
    expect(b.pushSub.delete).toHaveBeenCalledWith({ where: { id: 's-dead' } });
  });

  it('tolerates a transient (non-410) failure on one endpoint without aborting the rest', async () => {
    b.pushSub.findMany.mockResolvedValueOnce([
      { id: 's1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
      { id: 's2', endpoint: 'e2', p256dh: 'p', auth: 'a' },
      { id: 's3', endpoint: 'e3', p256dh: 'p', auth: 'a' },
    ]);
    b.driver.send
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error('5xx'), { statusCode: 502 }),
      )
      .mockResolvedValueOnce(undefined);

    const out = await b.service.dispatch(USER_ID, { title: 't', body: 'b' });
    expect(out.sent).toBe(2);
    expect(out.pruned).toBe(0);
    expect(b.pushSub.delete).not.toHaveBeenCalled();
  });

  it('returns 0/0 when the user has no subscriptions (no driver calls)', async () => {
    b.pushSub.findMany.mockResolvedValueOnce([]);
    const out = await b.service.dispatch(USER_ID, { title: 't', body: 'b' });
    expect(out).toEqual({ sent: 0, pruned: 0 });
    expect(b.driver.send).not.toHaveBeenCalled();
  });

  it('short-circuits when push is not configured', async () => {
    const prisma = makePrismaMock();
    const pushSub = { upsert: vi.fn(), findMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() };
    (prisma as unknown as { pushSubscription: typeof pushSub }).pushSubscription = pushSub;
    const driver: PushDriver = {
      send: vi.fn(),
      setVapidDetails: vi.fn(),
    };
    const service = new TestableWebPushService(prisma, driver);
    service.forceConfigured(false);

    const out = await service.dispatch(USER_ID, { title: 't', body: 'b' });
    expect(out).toEqual({ sent: 0, pruned: 0 });
    expect(pushSub.findMany).not.toHaveBeenCalled();
    expect(driver.send).not.toHaveBeenCalled();
  });
});
