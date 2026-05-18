// =============================================================================
// Shared types for the Layout sub-components.
// =============================================================================

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  workflowPreset: 'engineering' | 'design' | 'generic';
  sprintsEnabled: boolean;
  archivedAt: string | null;
}
