import type { Preset } from './types';

export const PRESET_STATUSES: Record<Preset, string[]> = {
  engineering: ['Todo', 'In Progress', 'In Review', 'Testing', 'Done'],
  design:      ['Todo', 'In Progress', 'In Review', 'Approved', 'Done'],
  generic:     ['Todo', 'In Progress', 'Done'],
};
