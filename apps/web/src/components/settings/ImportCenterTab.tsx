import { useState } from 'react';
import {
  FileSpreadsheet,
  GitBranch,
  Zap,
} from 'lucide-react';
import { cn } from '@nockta/ui';

import { GithubIcon } from '../icons/GithubIcon';

import { AdminGate, SectionTitle } from './primitives';
import { CsvImporter } from './import-center/CsvImporter';
import { GitHubIssuesImporter } from './import-center/GitHubIssuesImporter';
import { ImportRunsTable } from './import-center/ImportRunsTable';
import { JiraCsvImporter } from './import-center/JiraCsvImporter';
import { JiraImporter } from './import-center/JiraImporter';
import { LinearImporter } from './import-center/LinearImporter';
import type { ImportRunSummary, ImportTabKey } from './import-center/types';

// =============================================================================
// ImportCenterTab — admin-only multi-source import wizard.
//
// Four source tabs share the same shape: paste credentials → list source
// projects → pick one → preview the first 20 rows → commit. Progress streams
// over Socket.IO room `import:<runId>` so the UI advances row-by-row. Below
// the tabs an ImportRunsTable shows the last 20 runs and offers a "re-run"
// affordance that re-opens the source tab with the prior mapping pre-filled.
//
// API key / token entry is NEVER persisted — credentials live in component
// state for the duration of the wizard.
// =============================================================================

export function ImportCenterTab({ isAdmin }: { isAdmin: boolean }): JSX.Element {
  const [tab, setTab] = useState<ImportTabKey>('csv');
  /** When set, opens the corresponding source tab with a mapping snapshot
   *  pre-filled. Sourced from the runs table's "re-run" button. */
  const [rerunSnapshot, setRerunSnapshot] = useState<{
    tab: ImportTabKey;
    snapshot: unknown;
  } | null>(null);

  if (!isAdmin) return <AdminGate />;

  const tabs: { key: ImportTabKey; label: string; icon: JSX.Element }[] = [
    { key: 'csv', label: 'CSV', icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
    { key: 'linear', label: 'Linear', icon: <Zap className="h-3.5 w-3.5" /> },
    { key: 'github', label: 'GitHub Issues', icon: <GithubIcon className="h-3.5 w-3.5" /> },
    { key: 'jira', label: 'Jira (API)', icon: <GitBranch className="h-3.5 w-3.5" /> },
    { key: 'jira-csv', label: 'Jira (CSV)', icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
  ];

  const handleRerun = (run: ImportRunSummary): void => {
    const sourceToTab: Record<ImportRunSummary['source'], ImportTabKey> = {
      csv: 'csv',
      linear: 'linear',
      github_issues: 'github',
      jira: 'jira',
    };
    const target = sourceToTab[run.source];
    setTab(target);
    setRerunSnapshot({ tab: target, snapshot: run.mappingSnapshot });
  };

  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-5xl space-y-6 sm:space-y-8">
      <SectionTitle
        title={'Import center'}
        hint={'Bring existing tasks in from CSV, Linear, GitHub Issues, or Jira. Per-row progress streams live; runs are tracked below.'}
      />

      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'csv' && <CsvImporter />}
      {tab === 'linear' && (
        <LinearImporter
          rerunSnapshot={rerunSnapshot?.tab === 'linear' ? rerunSnapshot.snapshot : null}
        />
      )}
      {tab === 'github' && (
        <GitHubIssuesImporter
          rerunSnapshot={rerunSnapshot?.tab === 'github' ? rerunSnapshot.snapshot : null}
        />
      )}
      {tab === 'jira' && (
        <JiraImporter
          rerunSnapshot={rerunSnapshot?.tab === 'jira' ? rerunSnapshot.snapshot : null}
        />
      )}
      {tab === 'jira-csv' && <JiraCsvImporter />}

      <ImportRunsTable onRerun={handleRerun} />
    </div>
  );
}
