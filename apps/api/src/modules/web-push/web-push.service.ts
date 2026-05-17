import { Injectable, Logger, Optional } from '@nestjs/common';
import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// WebPushService — server-side Web Push.
//
// Wraps the `web-push` npm package (loaded lazily so the API still boots if
// the dep isn't installed yet — tests inject their own driver). Responsibilities:
//
//   - subscribe(userId, sub)   upsert a PushSubscription row by endpoint.
//   - unsubscribe(userId, ep)  delete the row (no-op if not present).
//   - dispatch(userId, payload) fan out one push per subscription. Any 410
//     (Gone) response from the push service prunes that endpoint — this is
//     the standard cleanup path for stale subscriptions.
//
// The actual `web-push.sendNotification` call goes through a small driver
// indirection (PushDriver) so tests can swap in a fake and assert calls.
// =============================================================================

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Optional human label, e.g. user-agent string. */
  label?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
  /** Coalesce key — same tag replaces a previous toast. */
  tag?: string;
}

export interface PushDriver {
  /** Send one push. Resolves on success; rejects with `{ statusCode }` on failure. */
  send(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<void>;
  /** Configure VAPID identity. Called once at module init. */
  setVapidDetails(contact: string, publicKey: string, privateKey: string): void;
}

/**
 * Default driver — lazy `require('web-push')`. If the package isn't
 * installed (e.g. fresh checkout where pnpm install hasn't run yet) we
 * return a no-op driver and log a warning so the rest of the app still
 * boots. Tests use `createTestDriver` below.
 */
type WebPushLib = {
  setVapidDetails: (c: string, pub: string, priv: string) => void;
  sendNotification: (s: unknown, p: string) => Promise<unknown>;
};

export function createDefaultDriver(logger: Logger): PushDriver {
  // Lazy-require keeps the dep optional. `as typeof wp` would resolve to
  // `WebPushLib | null` (because we initialise to null), which then narrows
  // method lookups to `never` — cast against the non-null shape instead.
  let wp: WebPushLib | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    wp = require('web-push') as WebPushLib;
  } catch {
    logger.warn(
      'web-push package not installed — push dispatch will be a no-op. ' +
        "Run `pnpm add web-push @types/web-push` in apps/api to enable.",
    );
  }
  return {
    setVapidDetails(contact, publicKey, privateKey) {
      if (!wp) return;
      wp.setVapidDetails(contact, publicKey, privateKey);
    },
    async send(subscription, payload) {
      if (!wp) return;
      try {
        await wp.sendNotification(subscription, payload);
      } catch (err: unknown) {
        // web-push throws a WebPushError with .statusCode. Re-throw with a
        // stable shape the service consumes for 410 cleanup.
        const e = err as { statusCode?: number; message?: string };
        const wrapped = new Error(e?.message ?? 'web-push send failed') as Error & {
          statusCode?: number;
        };
        wrapped.statusCode = e?.statusCode;
        throw wrapped;
      }
    },
  };
}

@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private readonly driver: PushDriver;
  private readonly configured: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() driver?: PushDriver,
  ) {
    this.driver = driver ?? createDefaultDriver(this.logger);
    const hasKeys = Boolean(Env.VAPID_PUBLIC_KEY && Env.VAPID_PRIVATE_KEY);
    this.configured = hasKeys;
    if (!hasKeys) {
      this.logger.warn(
        'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web push dispatch is disabled. ' +
          'Generate keys with `npx web-push generate-vapid-keys` and set both env vars to enable.',
      );
      return;
    }
    try {
      this.driver.setVapidDetails(
        Env.VAPID_CONTACT_EMAIL,
        Env.VAPID_PUBLIC_KEY!,
        Env.VAPID_PRIVATE_KEY!,
      );
    } catch (err) {
      this.logger.error(
        `Failed to configure VAPID details — push will be disabled: ${(err as Error).message}`,
      );
    }
  }

  /** Is push fully configured (VAPID keys present + driver available)? */
  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Persist a subscription for the given user. Idempotent — re-subscribing
   * the same endpoint updates p256dh/auth + bumps lastSeenAt rather than
   * creating a duplicate row.
   */
  async subscribe(userId: string, sub: SubscriptionInput): Promise<{ id: string }> {
    const row = await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        ...(sub.label ? { label: sub.label } : {}),
        lastSeenAt: new Date(),
      },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        label: sub.label ?? null,
      },
      select: { id: true },
    });
    return row;
  }

  /** Remove a subscription. Silent if no row matches. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    // deleteMany so a missing row doesn't throw; we also pin to userId so a
    // user can't unsubscribe someone else's endpoint by guessing it.
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /**
   * Fan out a payload to every subscription belonging to the user. Endpoints
   * that come back 404 / 410 are pruned. Other errors are logged and the
   * fan-out continues — a flaky single device shouldn't take down the rest.
   *
   * Returns the count of subscriptions that were successfully POSTed to the
   * push service. Tests assert on this + the prune side-effect.
   */
  async dispatch(userId: string, payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    if (!this.configured) return { sent: 0, pruned: 0 };
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subs.length === 0) return { sent: 0, pruned: 0 };

    const serialized = JSON.stringify(payload);
    let sent = 0;
    let pruned = 0;
    for (const s of subs) {
      try {
        await this.driver.send(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          serialized,
        );
        sent += 1;
      } catch (err) {
        const code = (err as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          // Endpoint is dead — push service tells us so. Prune.
          await this.prisma.pushSubscription
            .delete({ where: { id: s.id } })
            .catch(() => undefined);
          pruned += 1;
        } else {
          this.logger.warn(
            `web push send failed for user=${userId} endpoint=${s.endpoint} status=${code ?? 'n/a'}: ${(err as Error).message}`,
          );
        }
      }
    }
    return { sent, pruned };
  }

  /** Return the VAPID public key so the client can call PushManager.subscribe. */
  getPublicKey(): string | null {
    return Env.VAPID_PUBLIC_KEY ?? null;
  }
}
