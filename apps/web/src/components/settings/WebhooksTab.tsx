import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';

import { api } from '../../lib/api';

import { AdminGate, Field, Fieldset, SectionTitle, Toggle, apiErrorMessage } from './primitives';

// =============================================================================
// WebhooksTab — workspace-level outbound webhooks (Settings → Webhooks).
//
// Distinct from automation-rule send_webhook: this tab manages persistent
// SUBSCRIPTIONS to the workspace's event stream (task.created,
// comment.added, sprint.started, deploy.succeeded, ...). The user picks
// which events they care about, supplies a URL + a signing secret, and we
// HMAC-sign every delivery so the receiver can verify authenticity.
//
// Surface:
//   - List of webhooks with name, URL, last delivery, enabled toggle.
//   - Create form (name, URL, event types, generate-secret affordance).
//   - Detail view: recent 50 deliveries with status badges + re-deliver.
//
// The workspace scope is derived server-side from the JWT — there is no
// per-request workspace path parameter, so a client can never address a
// workspace it doesn't belong to. (See WorkspaceContextService on the API
// side.)
// =============================================================================

const ALL_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.deleted',
  'task.assigned',
  'comment.added',
  'sprint.started',
  'sprint.completed',
  'project.created',
  'project.archived',
  'deploy.succeeded',
  'automation.fired',
] as const;

interface OutboundWebhook {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  failureCount: number;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

interface CreatedWebhook extends OutboundWebhook {
  /** Returned ONCE on the create response so the user can copy it into their
   *  receiver's verifier. Subsequent reads omit this field. */
  secret: string;
}

interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  status: 'pending' | 'success' | 'failed' | 'dropped';
  attemptCount: number;
  responseCode: number | null;
  responseExcerpt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export function WebhooksTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  if (!isAdmin) return <AdminGate />;
  return <WebhooksTabAdmin />;
}

function WebhooksTabAdmin(): JSX.Element {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const listQuery = useQuery({
    queryKey: ['outbound-webhooks'],
    queryFn: () => api.get<OutboundWebhook[]>(`/outbound-webhooks`),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<OutboundWebhook>(`/outbound-webhooks/${id}`, { enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['outbound-webhooks'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not update webhook')),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: true }>(`/outbound-webhooks/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ['outbound-webhooks'] });
      toast.success('Webhook deleted');
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not delete webhook')),
  });

  const testFire = useMutation({
    mutationFn: (id: string) =>
      api.post<WebhookDelivery>(`/outbound-webhooks/${id}/test`, {}),
    onSuccess: () => {
      toast.success('Test delivery queued');
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not test webhook')),
  });

  const webhooks = listQuery.data ?? [];

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <SectionTitle
          title="Outbound webhooks"
          hint="Fire workspace events to your own HTTP endpoints. Signed with HMAC-SHA256."
        />
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded-md border border-border bg-brand text-brand-foreground px-3 py-1.5 text-xs font-medium hover:bg-brand/90 transition-colors"
        >
          New webhook
        </button>
      </div>

      {showCreate && (
        <CreateWebhookForm
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setShowCreate(false);
            void qc.invalidateQueries({ queryKey: ['outbound-webhooks'] });
            // Show the secret ONCE — it's redacted from subsequent reads.
            toast.success('Webhook created — copy the secret now, it won\'t be shown again');
            // Open the detail view so the user can grab the secret.
            setSelectedId(created.id);
          }}
        />
      )}

      {listQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading webhooks…</div>
      ) : webhooks.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2">
          {webhooks.map((w) => (
            <li
              key={w.id}
              className="rounded-md border border-border bg-card/40 px-4 py-3 hover:bg-card/60 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedId(w.id === selectedId ? null : w.id)}
                  className="text-left flex-1 min-w-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{w.name}</span>
                    {!w.enabled && (
                      <span className="text-[10px] uppercase tracking-wider rounded bg-destructive/15 text-destructive px-1.5 py-0.5">
                        Disabled
                      </span>
                    )}
                    {w.failureCount > 0 && (
                      <span className="text-[10px] rounded bg-status-blocked/15 text-status-blocked px-1.5 py-0.5">
                        {w.failureCount} consecutive failure{w.failureCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                    {w.url}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    {w.eventTypes.length} event type{w.eventTypes.length === 1 ? '' : 's'} ·{' '}
                    {w.lastDeliveryAt
                      ? `last delivery ${new Date(w.lastDeliveryAt).toLocaleString()}`
                      : 'no deliveries yet'}
                  </div>
                </button>
                <div className="flex items-center gap-2 shrink-0">
                  <Toggle
                    checked={w.enabled}
                    onChange={(next) => toggle.mutate({ id: w.id, enabled: next })}
                    ariaLabel={`Toggle ${w.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => testFire.mutate(w.id)}
                    disabled={testFire.isPending}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/40 transition-colors disabled:opacity-50"
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete webhook "${w.name}"?`)) remove.mutate(w.id);
                    }}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {selectedId === w.id && <WebhookDetail webhookId={w.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
      <div className="text-sm font-medium">No webhooks yet</div>
      <div className="text-xs text-muted-foreground mt-1">
        Subscribe an HTTPS endpoint to workspace events like task.created and sprint.completed.
      </div>
    </div>
  );
}

function CreateWebhookForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (w: CreatedWebhook) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [eventTypes, setEventTypes] = useState<string[]>(['task.created']);

  const create = useMutation({
    mutationFn: (input: {
      name: string;
      url: string;
      secret: string;
      eventTypes: string[];
    }) =>
      api.post<CreatedWebhook>(
        `/outbound-webhooks`,
        input,
      ),
    onSuccess: (created) => onCreated(created),
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create webhook')),
  });

  function generateSecret(): void {
    // Client-side generated — the API also validates server-side. Two
    // crypto.randomUUIDs concatenated gives 64 hex chars + 8 dashes;
    // strip the dashes for a clean 64-char hex secret.
    const a = crypto.randomUUID().replace(/-/g, '');
    const b = crypto.randomUUID().replace(/-/g, '');
    setSecret(a + b);
  }

  function toggleEvent(ev: string): void {
    setEventTypes((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));
  }

  return (
    <Fieldset legend="New webhook" hint="Pick the events you want forwarded to your endpoint.">
      <Field label="Name" htmlFor="wh-name">
        <input
          id="wh-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. PagerDuty bridge"
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        />
      </Field>
      <Field label="URL" htmlFor="wh-url" hint="Must be https in production.">
        <input
          id="wh-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.example.com/nockta"
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-brand"
        />
      </Field>
      <Field
        label="Signing secret"
        htmlFor="wh-secret"
        hint="Used to compute the X-Nockta-Signature header (sha256= prefix). At least 16 characters."
      >
        <div className="flex gap-2">
          <input
            id="wh-secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Generate or paste a strong secret"
            className="flex-1 rounded-md border border-border bg-background/60 px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-brand"
          />
          <button
            type="button"
            onClick={generateSecret}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent/40 transition-colors"
          >
            Generate
          </button>
        </div>
      </Field>
      <Field label="Event types" hint="The receiver gets exactly these events.">
        <div className="grid grid-cols-2 gap-2">
          {ALL_EVENT_TYPES.map((ev) => (
            <label
              key={ev}
              className="flex items-center gap-2 rounded border border-border bg-background/40 px-2.5 py-1.5 text-xs cursor-pointer hover:bg-background/70"
            >
              <input
                type="checkbox"
                checked={eventTypes.includes(ev)}
                onChange={() => toggleEvent(ev)}
                className="accent-brand"
              />
              <code className="font-mono">{ev}</code>
            </label>
          ))}
        </div>
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent/40 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (!name.trim() || !url.trim() || secret.length < 16 || eventTypes.length === 0) {
              toast.error('All fields required; secret needs at least 16 chars');
              return;
            }
            create.mutate({ name: name.trim(), url: url.trim(), secret, eventTypes });
          }}
          disabled={create.isPending}
          className="rounded-md border border-border bg-brand text-brand-foreground px-3 py-1.5 text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Fieldset>
  );
}

function WebhookDetail({ webhookId }: { webhookId: string }): JSX.Element {
  const qc = useQueryClient();
  const deliveriesQuery = useQuery({
    queryKey: ['webhook-deliveries', webhookId],
    queryFn: () =>
      api.get<WebhookDelivery[]>(
        `/outbound-webhooks/${webhookId}/deliveries`,
      ),
    refetchInterval: 5_000, // poll while the drawer is open
  });

  const redeliver = useMutation({
    mutationFn: (deliveryId: string) =>
      api.post<WebhookDelivery>(
        `/outbound-webhooks/${webhookId}/redeliver/${deliveryId}`,
        {},
      ),
    onSuccess: () => {
      toast.success('Re-delivery queued');
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries', webhookId] });
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not re-deliver')),
  });

  const deliveries = deliveriesQuery.data ?? [];

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <div className="nockta-eyebrow text-muted-foreground">Recent deliveries</div>
        <div className="text-[10px] text-muted-foreground">
          {deliveries.length === 50 ? 'showing latest 50' : `${deliveries.length} total`}
        </div>
      </div>
      {deliveries.length === 0 ? (
        <div className="text-xs text-muted-foreground mt-2">
          No deliveries yet — use the Test button above to fire a sample.
        </div>
      ) : (
        <ul className="mt-2 space-y-1">
          {deliveries.map((d) => (
            <DeliveryRow
              key={d.id}
              delivery={d}
              onRedeliver={() => redeliver.mutate(d.id)}
              redelivering={redeliver.isPending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DeliveryRow({
  delivery,
  onRedeliver,
  redelivering,
}: {
  delivery: WebhookDelivery;
  onRedeliver: () => void;
  redelivering: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const tone =
    delivery.status === 'success'
      ? 'bg-status-done/15 text-status-done'
      : delivery.status === 'failed'
        ? 'bg-destructive/15 text-destructive'
        : delivery.status === 'dropped'
          ? 'bg-muted text-muted-foreground'
          : 'bg-status-blocked/15 text-status-blocked';
  return (
    <li className="rounded border border-border bg-background/40 px-2.5 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <span className={cn('text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5', tone)}>
            {delivery.status}
          </span>
          <code className="font-mono truncate">{delivery.eventType}</code>
          {delivery.responseCode !== null && (
            <span className="text-muted-foreground font-mono text-[10px]">
              HTTP {delivery.responseCode}
            </span>
          )}
          <span className="text-muted-foreground text-[10px] ml-auto shrink-0">
            attempt {delivery.attemptCount} ·{' '}
            {new Date(delivery.createdAt).toLocaleTimeString()}
          </span>
        </button>
        <button
          type="button"
          onClick={onRedeliver}
          disabled={redelivering}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-[10px] hover:bg-accent/40 transition-colors disabled:opacity-50"
        >
          Re-deliver
        </button>
      </div>
      {expanded && delivery.responseExcerpt && (
        <pre className="mt-2 rounded bg-background/60 border border-border p-2 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap">
          {delivery.responseExcerpt}
        </pre>
      )}
    </li>
  );
}
