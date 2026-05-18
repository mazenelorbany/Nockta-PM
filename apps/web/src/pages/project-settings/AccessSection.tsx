import { Layers, ShieldCheck, Sparkles, Users } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';

import { Section } from './shared';
import { AccessChip } from './access-section/AccessChip';
import { GuestSharingMode } from './access-section/GuestSharingMode';
import { ProjectAccessManager } from './access-section/ProjectAccessManager';
import type { Access, Project } from './types';

export function AccessSection({
  draft,
  setDraft,
  updateMutation,
  projectId,
  grants,
  loading,
  grantSummary,
}: {
  draft: Project;
  setDraft: (next: Project) => void;
  updateMutation: UseMutationResult<Project, unknown, Partial<Project>, unknown>;
  projectId: string;
  grants: Access[];
  loading: boolean;
  grantSummary: { members: number; teams: number; guests: number; total: number };
}): JSX.Element {
  return (
    <Section
      id="access"
      icon={<ShieldCheck className="h-4 w-4" />}
      title="Access"
      hint="Who can see this project, and at what level. Members are internal teammates. Teams roll up everyone on the team. Guests use the client portal and only see what's marked client-visible."
    >
      {/* Chips strip — quick read on the shape of access. Clickable
          to scroll to the relevant subsection below. */}
      <div className="flex flex-wrap gap-2 mb-1">
        <AccessChip
          label="Members"
          count={grantSummary.members}
          icon={<Users className="h-3 w-3" />}
          href="#access-members"
        />
        <AccessChip
          label="Teams"
          count={grantSummary.teams}
          icon={<Layers className="h-3 w-3" />}
          href="#access-teams"
        />
        <AccessChip
          label="Guests"
          count={grantSummary.guests}
          icon={<Sparkles className="h-3 w-3" />}
          tone="guest"
          href="#access-guests"
        />
      </div>

      {/* Guest sharing mode — sits ABOVE the grant manager so it's the
          first decision a Manager makes when configuring access. The
          default ("Per-task") matches the legacy strict behavior; the
          Open option is what most client engagements want. */}
      <GuestSharingMode
        value={draft.defaultTaskVisibility}
        onChange={(v) => {
          setDraft({ ...draft, defaultTaskVisibility: v });
          updateMutation.mutate({ defaultTaskVisibility: v });
        }}
        hasGuests={grantSummary.guests > 0}
      />

      <ProjectAccessManager
        projectId={projectId}
        grants={grants}
        loading={loading}
      />
    </Section>
  );
}
