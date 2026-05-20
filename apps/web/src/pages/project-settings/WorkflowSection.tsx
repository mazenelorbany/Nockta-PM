import type { UseMutationResult } from '@tanstack/react-query';
import { Workflow } from 'lucide-react';

import { Section, Field, ToggleRow } from './shared';
import { WorkflowTransitionsMatrix } from './WorkflowTransitionsMatrix';
import type { Project } from './types';

export function WorkflowSection({
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
      id="workflow"
      icon={<Workflow className="h-4 w-4" />}
      title="Workflow"
      hint="How work flows through this project — sprints, GitHub automation, file sizes."
    >
      <ToggleRow
        label="Sprints"
        hint="Turn on Scrum-style sprint planning. Adds the Sprints UI to the Backlog tab."
        checked={draft.sprintsEnabled}
        onChange={(v) => {
          setDraft({ ...draft, sprintsEnabled: v });
          updateMutation.mutate({ sprintsEnabled: v });
        }}
      />
      <ToggleRow
        label="GitHub auto-status"
        hint="PR / commit events transition linked tasks automatically (e.g. PR merged → Testing)."
        checked={draft.githubAutoStatus}
        onChange={(v) => {
          setDraft({ ...draft, githubAutoStatus: v });
          updateMutation.mutate({ githubAutoStatus: v });
        }}
      />
      <Field
        label="Per-file upload cap (MB)"
        hint="1..500. Default 100. Enforced on every attachment uploaded into this project."
      >
        <input
          type="number"
          min={1}
          max={500}
          value={draft.maxAttachmentMb}
          onChange={(e) =>
            patch('maxAttachmentMb', Math.max(1, Math.min(500, Number(e.target.value) || 1)))
          }
          onBlur={() => commit('maxAttachmentMb')}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm w-32"
        />
      </Field>

      <Field
        label="Allowed transitions"
        hint="The board and task drawer use this matrix to decide which status flips are legal. Blocks Todo → Done unless an admin opts in."
      >
        <WorkflowTransitionsMatrix
          projectId={draft.id}
          workflowPreset={draft.workflowPreset}
        />
      </Field>
    </Section>
  );
}
