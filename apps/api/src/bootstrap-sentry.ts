// =============================================================================
// Optional Sentry bootstrap. Imported AFTER bootstrap-env in main.ts so the
// DSN env var is loaded by the time we read it.
//
// Sentry is opt-in: when SENTRY_DSN is unset we no-op. When it is set, we
// initialize @sentry/node and let its global error handlers attach. If the
// `@sentry/node` package isn't installed in this environment we log and
// continue — the API stays up either way.
// =============================================================================

export async function maybeInitSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    // @sentry/node is an intentionally optional runtime dep — see file header.
    // TS doesn't see types for it, but the dynamic import + try/catch is the
    // contract. Cast the imported namespace to the minimal shape we use.
     
    // @ts-expect-error — optional dependency, types not installed
    const Sentry = (await import('@sentry/node')) as {
      init: (opts: {
        dsn: string;
        environment?: string;
        tracesSampleRate?: number;
        release?: string;
        beforeSend?: (event: { tags?: Record<string, unknown> }) => unknown;
      }) => void;
    };
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
      ...(process.env.SENTRY_RELEASE ? { release: process.env.SENTRY_RELEASE } : {}),
      // Don't double-capture validation failures — class-validator rejections
      // are 400s and not actionable bugs.
      beforeSend(event: { tags?: Record<string, unknown> }) {
        const status = (event.tags?.['statusCode'] as string | undefined) ?? '';
        if (status.startsWith('4')) return null;
        return event;
      },
    });
    // intentional — boot log
    // eslint-disable-next-line no-console
    console.log('[sentry] initialized');
  } catch (err) {
    // intentional — boot log
     
    console.warn(`[sentry] not initialized: ${err instanceof Error ? err.message : err}`);
  }
}
