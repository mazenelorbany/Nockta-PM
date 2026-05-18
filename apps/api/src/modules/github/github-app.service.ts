import { Injectable, Logger } from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

import { Env } from '../../config/env';

/**
 * Thin facade over Octokit. Handles GitHub App JWT → installation token exchange,
 * returns a per-installation client. The actual webhook ingest is handled in
 * github-webhook.controller.ts; this service is used for outbound API calls.
 */
@Injectable()
export class GithubAppService {
  private readonly logger = new Logger(GithubAppService.name);

  private get configured(): boolean {
    return Boolean(Env.GITHUB_APP_ID && Env.GITHUB_APP_PRIVATE_KEY);
  }

  /** Get an Octokit instance scoped to one GitHub installation. */
  async forInstallation(installationId: number | bigint): Promise<Octokit | null> {
    if (!this.configured) {
      this.logger.warn('GitHub App not configured — skipping outbound call');
      return null;
    }
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: Number(Env.GITHUB_APP_ID),
        privateKey: Env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        installationId: Number(installationId),
      },
    });
  }

  /** Post a comment on a PR linking back to a Nockta Flow task. Best-effort. */
  async commentOnPullRequest(input: {
    installationId: number | bigint;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    const octo = await this.forInstallation(input.installationId);
    if (!octo) return;
    try {
      await octo.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.prNumber,
        body: input.body,
      });
    } catch (err) {
      this.logger.warn({ err }, 'failed to post PR comment');
    }
  }
}
