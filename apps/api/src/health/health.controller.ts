import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type Redis from 'ioredis';
import { Env } from '../config/env';
import { Public } from '../modules/auth/decorators/public.decorator';
import { REDIS_CLIENT } from '../modules/redis/redis.module';
import { StorageService } from '../modules/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';

interface HealthStatus {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  checks: Record<string, { status: 'up' | 'down' | 'skipped'; error?: string; latencyMs?: number }>;
}

/** Time a probe with a hard ceiling so a frozen dep doesn't hang the endpoint. */
async function timed<T>(fn: () => Promise<T>, timeoutMs = 2_000): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    @Optional() private readonly storage: StorageService | null,
  ) {}

  /** Shallow check — only verifies the API process is up + Postgres reachable.
   *  Kept fast for load balancers. */
  @Public()
  @Get()
  async check(): Promise<HealthStatus> {
    const checks: HealthStatus['checks'] = {};
    const db = await timed(() => this.prisma.$queryRaw`SELECT 1`);
    checks['database'] = db.ok
      ? { status: 'up', latencyMs: db.latencyMs }
      : { status: 'down', latencyMs: db.latencyMs, error: db.error };
    return {
      status: db.ok ? 'ok' : 'degraded',
      service: 'nockta-api',
      version: '0.1.0',
      checks,
    };
  }

  /** Deep check — probes every hard dependency. Used by ops dashboards and the
   *  manual "is everything green" command. Slower than `/health`; do not point
   *  load balancers at this. */
  @Public()
  @Get('deep')
  async deep(): Promise<HealthStatus> {
    const checks: HealthStatus['checks'] = {};

    const db = await timed(() => this.prisma.$queryRaw`SELECT 1`);
    checks['database'] = db.ok
      ? { status: 'up', latencyMs: db.latencyMs }
      : { status: 'down', latencyMs: db.latencyMs, error: db.error };

    if (this.redis) {
      const r = await timed(async () => {
        await this.redis!.ping();
      });
      checks['redis'] = r.ok
        ? { status: 'up', latencyMs: r.latencyMs }
        : { status: 'down', latencyMs: r.latencyMs, error: r.error };
    } else {
      checks['redis'] = { status: 'skipped' };
    }

    if (this.storage && typeof (this.storage as unknown as { headBucket?: () => Promise<unknown> }).headBucket === 'function') {
      const s = await timed(() => (this.storage as unknown as { headBucket: () => Promise<unknown> }).headBucket());
      checks['storage'] = s.ok
        ? { status: 'up', latencyMs: s.latencyMs }
        : { status: 'down', latencyMs: s.latencyMs, error: s.error };
    } else {
      checks['storage'] = { status: 'skipped' };
    }

    if (Env.QDRANT_URL) {
      const q = await timed(async () => {
        const res = await fetch(`${Env.QDRANT_URL}/healthz`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      });
      checks['qdrant'] = q.ok
        ? { status: 'up', latencyMs: q.latencyMs }
        : { status: 'down', latencyMs: q.latencyMs, error: q.error };
    } else {
      checks['qdrant'] = { status: 'skipped' };
    }

    if (Env.OLLAMA_URL) {
      const o = await timed(async () => {
        const res = await fetch(`${Env.OLLAMA_URL}/api/tags`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      });
      checks['ollama'] = o.ok
        ? { status: 'up', latencyMs: o.latencyMs }
        : { status: 'down', latencyMs: o.latencyMs, error: o.error };
    } else {
      checks['ollama'] = { status: 'skipped' };
    }

    const allActiveUp = Object.values(checks).every((c) => c.status !== 'down');
    return {
      status: allActiveUp ? 'ok' : 'degraded',
      service: 'nockta-api',
      version: '0.1.0',
      checks,
    };
  }

  /**
   * AI-specific health check. Probes Qdrant + the configured LLM provider
   * (Ollama or Anthropic) and returns per-component latency + status. Used
   * by the AI Grafana dashboard's "is the AI layer responsive?" panel and
   * by humans triaging "why are AI suggestions slow?" — separate from the
   * deep check so an LLM blip doesn't fail the broader probe.
   *
   * Doesn't run an actual completion (that would be expensive + flaky); it
   * verifies the provider's listing endpoint, which is the equivalent of a
   * "your API is reachable" handshake.
   */
  @Public()
  @Get('ai')
  async ai(): Promise<HealthStatus> {
    const checks: HealthStatus['checks'] = {};

    if (Env.QDRANT_URL) {
      const q = await timed(async () => {
        const res = await fetch(`${Env.QDRANT_URL}/healthz`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      });
      checks['qdrant'] = q.ok
        ? { status: 'up', latencyMs: q.latencyMs }
        : { status: 'down', latencyMs: q.latencyMs, error: q.error };
    } else {
      checks['qdrant'] = { status: 'skipped' };
    }

    if (Env.LLM_PROVIDER === 'anthropic') {
      // Anthropic doesn't expose a cheap unauthenticated health endpoint, so
      // we settle for "did the env declare an API key". A real check would
      // burn a token on every probe — not worth it for a status page.
      checks['llm_anthropic'] = Env.ANTHROPIC_API_KEY
        ? { status: 'up' }
        : { status: 'down', error: 'ANTHROPIC_API_KEY not set' };
    } else {
      const o = await timed(async () => {
        const res = await fetch(`${Env.OLLAMA_URL}/api/tags`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      });
      checks['llm_ollama'] = o.ok
        ? { status: 'up', latencyMs: o.latencyMs }
        : { status: 'down', latencyMs: o.latencyMs, error: o.error };
    }

    const allUp = Object.values(checks).every((c) => c.status !== 'down');
    return {
      status: allUp ? 'ok' : 'degraded',
      service: 'nockta-api',
      version: '0.1.0',
      checks,
    };
  }
}
