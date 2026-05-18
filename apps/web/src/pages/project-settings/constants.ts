import type { ProjectRole } from './types';

export const BROADCAST_EVENTS = [
  'SprintStarted',
  'SprintCompleted',
  'DeploymentSucceeded',
  'DeploymentFailed',
  'ProductionReleaseTagged',
  'CriticalTaskBlocked',
  'ClientReportedBug',
];

export const ROLE_HINTS: Record<ProjectRole, string> = {
  Manager: 'Full control — settings, access, every task.',
  Contributor: 'Create + edit tasks, comment, log work.',
  Viewer: 'Read-only.',
  Client: 'Client portal access — only sees client-visible content.',
};
