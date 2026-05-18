// =============================================================================
// Shared types for the ExportsTab sub-components.
// =============================================================================

export type ExportKind = 'csv' | 'xlsx' | 'pdf';
export type SourceKind = 'saved_view' | 'project' | 'all_tasks';
export type DeliveryKind = 'download' | 'email';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ExportSchedule {
  id: string;
  workspaceId: string;
  name: string;
  kind: ExportKind;
  sourceKind: SourceKind;
  sourceId: string | null;
  scheduleCron: string | null;
  deliveryKind: DeliveryKind;
  deliveryEmail: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface ExportRun {
  id: string;
  scheduleId: string | null;
  kind: ExportKind;
  sourceKind: SourceKind | null;
  sourceId: string | null;
  status: RunStatus;
  signedUrl: string | null;
  expiresAt: string | null;
  fileSize: number;
  rowCount: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SavedViewOption {
  id: string;
  name: string;
}
export interface ProjectOption {
  id: string;
  key: string;
  name: string;
}
