import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { useLocation } from 'react-router-dom';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';

import { SectionTitle, apiErrorMessage } from './primitives';

// =============================================================================
// IntegrationsTab — connect external services to the workspace. Each integration
// is rendered through IntegrationCard so the user gets a consistent layout
// (logo, description, status chip, action button).
// =============================================================================

interface ChatBinding {
  userId: string;
  googleChatSpaceId: string;
  connectedAt: string;
  lastSeenAt: string;
}

interface GithubInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
  suspendedAt: string | null;
  reposCount?: number;
}

export function IntegrationsTab(): JSX.Element {
  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-3xl space-y-6">
      <SectionTitle
        title={'Integrations'}
        hint={'Connect Nockta Flow to the rest of your stack.'}
      />
      <div className="grid grid-cols-1 gap-4">
        <GithubCard />
        <ChatCard />
        <DeploymentCard />
      </div>
    </div>
  );
}

function GithubCard(): JSX.Element {
  const location = useLocation();
  const queryClient = useQueryClient();
  const installationsQuery = useQuery({
    queryKey: ['github-installations'],
    queryFn: () =>
      api.get<GithubInstallation[]>('/github/installations').catch(() => null),
    retry: false,
  });
  const configQuery = useQuery({
    queryKey: ['app-config'],
    queryFn: () =>
      api.get<{ githubAppSlug: string | null }>('/config').catch(() => null),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const installations = installationsQuery.data;
  const connected = Array.isArray(installations) && installations.length > 0;
  const githubAppSlug = configQuery.data?.githubAppSlug ?? null;

  // Handle the post-install redirect. GitHub bounces the user back to
  // /settings/integrations?installed=1&installation_id=...&account=...
  // We refetch the installations list a few times in case the webhook row
  // hasn't landed yet (it almost always has, but we don't want a race).
  const installParams = new URLSearchParams(location.search);
  const justInstalled = installParams.get('installed') === '1';
  const installError = installParams.get('error');
  useEffect(() => {
    if (!justInstalled) return;
    let cancelled = false;
    let attempts = 0;
    function poll(): void {
      if (cancelled || attempts >= 5) return;
      attempts += 1;
      void queryClient.invalidateQueries({ queryKey: ['github-installations'] });
      setTimeout(poll, 1500);
    }
    poll();
    toast.success('GitHub App installed');
    // Clear the query params so a refresh doesn't replay the toast.
    const url = new URL(window.location.href);
    url.search = '';
    window.history.replaceState({}, '', url.toString());
    return () => {
      cancelled = true;
    };
  }, [justInstalled, queryClient]);
  useEffect(() => {
    if (installError) {
      toast.error(`Install failed (${installError}). Try again.`);
      const url = new URL(window.location.href);
      url.search = '';
      window.history.replaceState({}, '', url.toString());
    }
  }, [installError]);

  const begin = useMutation({
    mutationFn: () => api.post<{ url: string }>('/github/install/begin', {}),
    onSuccess: ({ url }) => {
      // Top-level navigate — GitHub will bounce us back to /settings/integrations.
      window.location.href = url;
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not start install')),
  });

  return (
    <IntegrationCard
      title="GitHub"
      logo={<GithubLogo />}
      description="Auto-link PRs and commits to tasks via the task key (e.g. ENG-42). Open/merge/deploy events transition status."
      status={connected ? 'connected' : 'not-connected'}
      details={
        connected ? (
          <ul className="space-y-1.5 mt-3">
            {installations!.map((inst) => (
              <li
                key={inst.id}
                className="flex items-center justify-between rounded-md bg-background/40 px-3 py-2 text-xs"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{inst.accountLogin}</span>
                  <span className="text-muted-foreground">· {inst.accountType}</span>
                  {inst.suspendedAt && (
                    <span className="text-status-blocked">suspended</span>
                  )}
                </span>
                <span className="text-muted-foreground">
                  {inst.reposCount ?? '?'} repos
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-xs text-muted-foreground mt-3">
            No GitHub App installation detected yet. Install the Nockta Flow GitHub App
            on your org to start linking PRs and commits to tasks automatically.
          </div>
        )
      }
      action={
        githubAppSlug ? (
          connected ? (
            <a
              href={`https://github.com/apps/${githubAppSlug}/installations/new`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border bg-background/60 px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
            >
              Manage on GitHub
            </a>
          ) : (
            <button
              type="button"
              onClick={() => begin.mutate()}
              disabled={begin.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-60"
            >
              {begin.isPending ? 'Redirecting…' : 'Install GitHub App'}
            </button>
          )
        ) : (
          <span
            className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
            title="Set GITHUB_APP_SLUG on the API to enable installation from here."
          >
            Not configured
          </span>
        )
      }
    />
  );
}

function ChatCard(): JSX.Element {
  const bindingQuery = useQuery({
    queryKey: ['chat-binding'],
    queryFn: () => api.get<ChatBinding | null>('/chat/binding').catch(() => null),
    retry: false,
  });
  const binding = bindingQuery.data;
  const connected = Boolean(binding && binding.googleChatSpaceId);

  const disconnect = useMutation({
    mutationFn: () => api.delete('/chat/binding'),
    onSuccess: () => {
      toast.success('Disconnected');
      void bindingQuery.refetch();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not disconnect')),
  });

  return (
    <IntegrationCard
      title="Google Chat"
      logo={<ChatLogo />}
      description="Receive task assignments, blockers, and @mentions as DMs. Reply / accept / mark-done inline."
      status={connected ? 'connected' : 'not-connected'}
      details={
        connected ? (
          <div className="text-xs text-muted-foreground mt-3 space-y-1">
            <div>
              Connected since{' '}
              <span className="text-foreground">
                {new Date(binding!.connectedAt).toLocaleDateString()}
              </span>
            </div>
            <div className="font-mono text-[10px] truncate">{binding!.googleChatSpaceId}</div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground mt-3 space-y-2">
            <div>
              Connect by adding the <span className="text-foreground">Nockta Flow</span> bot
              in Google Chat and sending it any message. We'll match your email automatically.
            </div>
            <a
              href="https://chat.google.com/"
              target="_blank"
              rel="noreferrer"
              className="text-brand hover:underline underline-offset-2"
            >
              Open Google Chat →
            </a>
          </div>
        )
      }
      action={
        connected ? (
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Disconnect from Google Chat?')) disconnect.mutate();
            }}
            disabled={disconnect.isPending}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors disabled:opacity-50"
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : null
      }
      footer={<ChatSlashCommandsList />}
    />
  );
}

// Sub-section that documents the slash commands the bot understands. Rendered
// at the bottom of the Chat integration card so the user discovers them in
// the same place they connect / disconnect the integration.
function ChatSlashCommandsList(): JSX.Element {
  const commands: Array<{ cmd: string; usage: string }> = [
    { cmd: '/assign', usage: '<task-key> @user — reassign a task (e.g. /assign ENG-42 @alice)' },
    { cmd: '/status', usage: '<task-key> <new-status> — transition a task' },
    { cmd: '/comment', usage: '<task-key> <text> — post a comment as you' },
    { cmd: '/my-tasks', usage: 'list your open assigned tasks with inline actions' },
    { cmd: '/standup', usage: 'your personal yesterday / today / blockers' },
    { cmd: '/sprint', usage: 'active sprint summary for your most recent project' },
    { cmd: '/help', usage: 'show this list' },
  ];
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-2">
        Slash commands
      </div>
      <ul className="space-y-1">
        {commands.map((c) => (
          <li key={c.cmd} className="text-xs flex gap-2 flex-wrap">
            <code className="font-mono text-brand">{c.cmd}</code>
            <span className="text-muted-foreground">{c.usage}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeploymentCard(): JSX.Element {
  const apiUrl = window.location.origin.replace(/:\d+$/, ':3000');
  return (
    <IntegrationCard
      title="Deployment webhooks"
      logo={<DeployLogo />}
      description="Vercel, Railway, GitHub Actions, and Docker pipelines can POST to per-project webhook URLs to attach deploy events to tasks."
      status="ready"
      details={
        <div className="text-xs text-muted-foreground mt-3 space-y-2">
          <div>
            Each project gets its own signed webhook URL. Generate one in{' '}
            <span className="text-foreground">Project · Settings · Deployments</span>.
          </div>
          <div className="rounded-md bg-background/40 border border-border p-2 font-mono text-[10px]">
            <div>POST {apiUrl}/api/v1/webhooks/deploy/&lt;project&gt;</div>
            <div className="text-muted-foreground">X-Signature: hmac-sha256(secret, body)</div>
          </div>
        </div>
      }
      action={null}
    />
  );
}

function IntegrationCard({
  title,
  logo,
  description,
  status,
  details,
  action,
  footer,
}: {
  title: string;
  logo: React.ReactNode;
  description: string;
  status: 'connected' | 'not-connected' | 'ready';
  details: React.ReactNode;
  action: React.ReactNode;
  footer?: React.ReactNode;
}): JSX.Element {
  const statusTone =
    status === 'connected' ? 'bg-status-done/20 text-status-done' :
    status === 'ready' ? 'bg-brand/15 text-brand' :
    'bg-muted text-muted-foreground';
  const statusLabel =
    status === 'connected' ? 'Connected' : status === 'ready' ? 'Ready' : 'Not connected';

  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 rounded-md bg-background flex items-center justify-center shrink-0">
            {logo}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{title}</h3>
              <span
                className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide',
                  statusTone,
                )}
              >
                {statusLabel}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
            {details}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {footer}
    </div>
  );
}

// Tiny inline brand glyphs — currentColor on the foreground so they tint to context.
function GithubLogo(): JSX.Element {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.77.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.31-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.87.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}
function ChatLogo(): JSX.Element {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21 6h-3V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v14a1 1 0 0 0 1.55.83L6 16h7a1 1 0 0 0 1-1v-3h3l2.45 1.83A1 1 0 0 0 21 13V7a1 1 0 0 0 0-1z"/>
    </svg>
  );
}
function DeployLogo(): JSX.Element {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414l-1.828-1.828a2 2 0 0 1-.586-1.414V11"/><path d="M7 22v-4.172a2 2 0 0 1 .586-1.414l1.828-1.828A2 2 0 0 0 10 13.172V11"/><rect x="7" y="2" width="10" height="9" rx="1"/>
    </svg>
  );
}
