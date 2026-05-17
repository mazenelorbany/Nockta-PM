import type { DeploymentSource, DeploymentStatus } from '@prisma/client';

export interface NormalizedDeployment {
  externalId: string;
  status: DeploymentStatus;
  environment: string; // 'production' | 'staging' | etc.
  commitSha: string | null;
  commitMessage: string | null;
  url: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  source: DeploymentSource;
  raw: Record<string, unknown>;
}

/** Normalize a Vercel webhook payload. */
export function normalizeVercel(body: Record<string, unknown>): NormalizedDeployment | null {
  const deployment = body['payload'] as Record<string, unknown> | undefined;
  if (!deployment) return null;
  const stateRaw = (deployment['state'] as string | undefined) ?? (body['type'] as string | undefined);
  const status: DeploymentStatus =
    stateRaw === 'READY' || stateRaw === 'deployment.succeeded' ? 'succeeded' :
    stateRaw === 'ERROR' || stateRaw === 'CANCELED' || stateRaw === 'deployment.error' ? 'failed' :
    'started';
  const meta = (deployment['meta'] as Record<string, unknown> | undefined) ?? {};
  return {
    externalId: (deployment['id'] ?? deployment['uid']) as string,
    status,
    environment: (deployment['target'] as string | undefined) ?? 'preview',
    commitSha: (meta['githubCommitSha'] as string | undefined) ?? null,
    commitMessage: (meta['githubCommitMessage'] as string | undefined) ?? null,
    url: (deployment['url'] as string | undefined) ?? null,
    startedAt: new Date((deployment['createdAt'] as number) ?? Date.now()),
    finishedAt: status === 'succeeded' || status === 'failed' ? new Date() : null,
    source: 'vercel',
    raw: body,
  };
}

/** Railway webhook payload. */
export function normalizeRailway(body: Record<string, unknown>): NormalizedDeployment | null {
  const deployment = (body['deployment'] as Record<string, unknown> | undefined) ?? body;
  const statusRaw = deployment['status'] as string | undefined;
  const status: DeploymentStatus =
    statusRaw === 'SUCCESS' ? 'succeeded' :
    statusRaw === 'FAILED' || statusRaw === 'CRASHED' ? 'failed' :
    'started';
  return {
    externalId: (deployment['id'] as string) ?? `railway-${Date.now()}`,
    status,
    environment: (deployment['environment'] as { name?: string } | undefined)?.name ?? 'production',
    commitSha: (deployment['meta'] as { commitSha?: string } | undefined)?.commitSha ?? null,
    commitMessage: (deployment['meta'] as { commitMessage?: string } | undefined)?.commitMessage ?? null,
    url: (deployment['url'] as string | undefined) ?? null,
    startedAt: new Date((deployment['createdAt'] as string) ?? Date.now()),
    finishedAt: status === 'succeeded' || status === 'failed' ? new Date() : null,
    source: 'railway',
    raw: body,
  };
}

/** GitHub Actions deployment_status webhook (or workflow_run). */
export function normalizeGithubActions(body: Record<string, unknown>): NormalizedDeployment | null {
  const ds = body['deployment_status'] as Record<string, unknown> | undefined;
  const wr = body['workflow_run'] as Record<string, unknown> | undefined;
  if (ds) {
    const stateRaw = ds['state'] as string;
    const status: DeploymentStatus =
      stateRaw === 'success' ? 'succeeded' :
      stateRaw === 'failure' || stateRaw === 'error' ? 'failed' :
      'started';
    const deployment = body['deployment'] as Record<string, unknown> | undefined;
    return {
      externalId: String(ds['id']),
      status,
      environment: (deployment?.['environment'] as string | undefined) ?? 'production',
      commitSha: (deployment?.['sha'] as string | undefined) ?? null,
      commitMessage: null,
      url: (ds['target_url'] as string | undefined) ?? null,
      startedAt: new Date((ds['created_at'] as string | undefined) ?? Date.now()),
      finishedAt: status === 'succeeded' || status === 'failed' ? new Date() : null,
      source: 'github_actions',
      raw: body,
    };
  }
  if (wr) {
    const conclusion = wr['conclusion'] as string | undefined;
    const status: DeploymentStatus =
      conclusion === 'success' ? 'succeeded' :
      conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out' ? 'failed' :
      'started';
    return {
      externalId: String(wr['id']),
      status,
      environment: 'ci',
      commitSha: (wr['head_sha'] as string | undefined) ?? null,
      commitMessage: null,
      url: (wr['html_url'] as string | undefined) ?? null,
      startedAt: new Date((wr['created_at'] as string | undefined) ?? Date.now()),
      finishedAt: status === 'succeeded' || status === 'failed' ? new Date() : null,
      source: 'github_actions',
      raw: body,
    };
  }
  return null;
}

/** Generic / Docker pipeline format: documented as the canonical Nockta payload. */
export interface GenericPayload {
  externalId: string;
  status: 'started' | 'succeeded' | 'failed' | 'rolled_back';
  environment: string;
  commitSha?: string;
  commitMessage?: string;
  url?: string;
  startedAt?: string;
  finishedAt?: string;
}

export function normalizeGeneric(body: Record<string, unknown>): NormalizedDeployment | null {
  const p = body as Partial<GenericPayload>;
  if (!p.externalId || !p.status || !p.environment) return null;
  return {
    externalId: p.externalId,
    status: p.status as DeploymentStatus,
    environment: p.environment,
    commitSha: p.commitSha ?? null,
    commitMessage: p.commitMessage ?? null,
    url: p.url ?? null,
    startedAt: p.startedAt ? new Date(p.startedAt) : new Date(),
    finishedAt: p.finishedAt ? new Date(p.finishedAt) : null,
    source: 'generic',
    raw: body,
  };
}
