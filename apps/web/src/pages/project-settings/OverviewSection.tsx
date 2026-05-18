import type { UseMutationResult } from '@tanstack/react-query';
import { Settings as SettingsIcon } from 'lucide-react';

import { Section, Field } from './shared';
import type { Project } from './types';

export function OverviewSection({
  draft,
  setDraft,
  patch,
  commit,
  updateMutation,
}: {
  draft: Project;
  setDraft: (next: Project) => void;
  patch: <K extends keyof Project>(key: K, value: Project[K]) => void;
  commit: <K extends keyof Project>(key: K) => void;
  updateMutation: UseMutationResult<Project, unknown, Partial<Project>, unknown>;
}): JSX.Element {
  return (
    <Section
      id="overview"
      icon={<SettingsIcon className="h-4 w-4" />}
      title="Overview"
      hint="The basics — name, description, visibility, workflow."
    >
      <Field label="Name">
        <input
          value={draft.name}
          onChange={(e) => patch('name', e.target.value)}
          onBlur={() => commit('name')}
          maxLength={120}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </Field>
      <Field label="Description">
        <textarea
          rows={3}
          value={draft.description ?? ''}
          onChange={(e) => patch('description', e.target.value)}
          onBlur={() => commit('description')}
          maxLength={2000}
          placeholder="What this project is about — visible to everyone with access."
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
        />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field
          label="Visibility"
          hint={
            draft.visibility === 'public'
              ? 'Every workspace member can see this project (read-only) without a grant.'
              : draft.visibility === 'teams'
                ? 'Only teams + people listed under Access can see it.'
                : 'Tightly locked — only people in the Access list can see it.'
          }
        >
          <select
            value={draft.visibility}
            onChange={(e) => {
              const v = e.target.value as Project['visibility'];
              setDraft({ ...draft, visibility: v });
              updateMutation.mutate({ visibility: v });
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="public">Public</option>
            <option value="teams">Teams only</option>
            <option value="private">Private</option>
          </select>
        </Field>
        <Field label="Workflow preset" hint="Immutable after project creation.">
          <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-sm text-muted-foreground capitalize">
            {draft.workflowPreset}
          </div>
        </Field>
      </div>
    </Section>
  );
}
