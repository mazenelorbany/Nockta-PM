import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { cn } from '@nockta/ui';

import { api } from '../../../lib/api';
import { Field, Fieldset, apiErrorMessage } from '../primitives';

import { isLikelyValidCron } from './cron';
import type {
  DeliveryKind,
  ExportKind,
  ExportSchedule,
  ProjectOption,
  SavedViewOption,
  SourceKind,
} from './types';

// =============================================================================
// Create form
// =============================================================================

const SCHEDULE_PRESETS: Array<{ label: string; cron: string | null }> = [
  { label: 'One-off (run now)', cron: null },
  { label: 'Daily at 09:00 UTC', cron: '0 9 * * *' },
  { label: 'Weekly Mon 09:00 UTC', cron: '0 9 * * 1' },
  { label: 'Custom cron…', cron: '__custom__' as unknown as string },
];

export function CreateExportForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ExportKind>('csv');
  const [sourceKind, setSourceKind] = useState<SourceKind>('all_tasks');
  const [sourceId, setSourceId] = useState<string>('');
  const [preset, setPreset] = useState<string>(SCHEDULE_PRESETS[0]!.label);
  const [customCron, setCustomCron] = useState<string>('');
  const [deliveryKind, setDeliveryKind] = useState<DeliveryKind>('download');
  const [deliveryEmail, setDeliveryEmail] = useState<string>('');

  const projectsQuery = useQuery({
    queryKey: ['projects-for-exports'],
    queryFn: () => api.get<ProjectOption[]>('/projects'),
    enabled: sourceKind === 'project',
  });
  const savedViewsQuery = useQuery({
    queryKey: ['saved-views-for-exports'],
    queryFn: () => api.get<SavedViewOption[]>('/saved-views'),
    enabled: sourceKind === 'saved_view',
  });

  const create = useMutation({
    mutationFn: (input: {
      name: string;
      kind: ExportKind;
      sourceKind: SourceKind;
      sourceId?: string;
      scheduleCron: string | null;
      deliveryKind: DeliveryKind;
      deliveryEmail?: string;
    }) => api.post<ExportSchedule>(`/exports/schedules`, input),
    onSuccess: () => {
      toast.success('Export scheduled');
      onCreated();
    },
    onError: (err) => toast.error(apiErrorMessage(err, 'Could not create export')),
  });

  const presetCron = SCHEDULE_PRESETS.find((p) => p.label === preset)?.cron ?? null;
  const isCustom = presetCron === '__custom__';
  const effectiveCron = isCustom ? customCron.trim() || null : presetCron;

  return (
    <Fieldset legend="New export" hint="Pick the source, the file kind, and the cadence.">
      <Field label="Name" htmlFor="ex-name">
        <input
          id="ex-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Weekly engineering roster"
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3 mt-3">
        <Field label="File kind" htmlFor="ex-kind">
          <select
            id="ex-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ExportKind)}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="csv">CSV</option>
            <option value="xlsx">XLSX (Excel)</option>
            <option value="pdf">PDF</option>
          </select>
        </Field>
        <Field label="Source" htmlFor="ex-source-kind">
          <select
            id="ex-source-kind"
            value={sourceKind}
            onChange={(e) => {
              setSourceKind(e.target.value as SourceKind);
              setSourceId('');
            }}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="all_tasks">All tasks</option>
            <option value="project">A single project</option>
            <option value="saved_view">A saved view</option>
          </select>
        </Field>
      </div>

      {sourceKind === 'project' && (
        <Field label="Project" htmlFor="ex-project">
          <select
            id="ex-project"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="">— pick a project —</option>
            {projectsQuery.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {sourceKind === 'saved_view' && (
        <Field label="Saved view" htmlFor="ex-saved-view">
          <select
            id="ex-saved-view"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          >
            <option value="">— pick a saved view —</option>
            {savedViewsQuery.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Schedule" htmlFor="ex-preset" hint="Cron expressions are evaluated in UTC.">
        <select
          id="ex-preset"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        >
          {SCHEDULE_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      {isCustom && (
        <Field
          label="Custom cron expression"
          htmlFor="ex-cron"
          hint="5-field standard syntax (minute hour dom month dow). Example: 0 9 * * 1 — every Monday at 09:00 UTC."
        >
          <input
            id="ex-cron"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="0 9 * * 1"
            className={cn(
              'w-full rounded-md border border-border bg-background/60 px-3 py-1.5 font-mono text-xs focus:outline-none focus:border-brand',
              customCron.trim() && !isLikelyValidCron(customCron) && 'border-destructive/60',
            )}
          />
          {customCron.trim() && !isLikelyValidCron(customCron) && (
            <div className="text-[10px] text-destructive mt-1">
              Cron must have exactly 5 fields. Try “0 9 * * 1”.
            </div>
          )}
        </Field>
      )}

      <Field label="Delivery" htmlFor="ex-delivery">
        <select
          id="ex-delivery"
          value={deliveryKind}
          onChange={(e) => setDeliveryKind(e.target.value as DeliveryKind)}
          className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        >
          <option value="download">Download link only</option>
          <option value="email">Email the link to a recipient</option>
        </select>
      </Field>

      {deliveryKind === 'email' && (
        <Field label="Recipient email" htmlFor="ex-email">
          <input
            id="ex-email"
            type="email"
            value={deliveryEmail}
            onChange={(e) => setDeliveryEmail(e.target.value)}
            placeholder="exports@your-company.com"
            className="w-full rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm focus:outline-none focus:border-brand"
          />
        </Field>
      )}

      <div className="flex justify-end gap-2 pt-4">
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
            if (!name.trim()) {
              toast.error('Name is required');
              return;
            }
            if ((sourceKind === 'project' || sourceKind === 'saved_view') && !sourceId) {
              toast.error('Pick the source row');
              return;
            }
            if (isCustom && !isLikelyValidCron(customCron)) {
              toast.error('Cron expression looks invalid');
              return;
            }
            if (deliveryKind === 'email' && !deliveryEmail.trim()) {
              toast.error('Recipient email is required for email delivery');
              return;
            }
            create.mutate({
              name: name.trim(),
              kind,
              sourceKind,
              ...(sourceId ? { sourceId } : {}),
              scheduleCron: effectiveCron,
              deliveryKind,
              ...(deliveryKind === 'email' ? { deliveryEmail: deliveryEmail.trim() } : {}),
            });
          }}
          disabled={create.isPending}
          className="rounded-md border border-border bg-brand text-brand-foreground px-3 py-1.5 text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create export'}
        </button>
      </div>
    </Fieldset>
  );
}
