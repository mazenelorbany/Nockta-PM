import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TasksModule } from '../tasks/tasks.module';
import { GithubIssuesImportService } from './github-issues-import.service';
import { ImportRunsService } from './import-runs.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { ImportsDryRunService } from './imports-dry-run.service';
import { JiraImportService } from './jira-import.service';
import { JiraCsvImporter } from './jira-csv/jira-csv.importer';
import { LinearImportService } from './linear-import.service';

/**
 * Bulk-import module. CSV is the end-to-end-tested path; Jira/Linear/GitHub
 * Issues live behind the same gateway and stream progress through
 * ImportRunsService (Socket.IO room `import:<runId>`).
 *
 * Pass D adds:
 *   - ImportsDryRunService: unified /import/dry-run endpoint for the mapper UI.
 *   - JiraCsvImporter:      new adapter for Jira's standard CSV export.
 */
@Module({
  imports: [PermissionsModule, TasksModule, RealtimeModule, GithubModule],
  controllers: [ImportController],
  providers: [
    ImportService,
    ImportRunsService,
    ImportsDryRunService,
    JiraImportService,
    JiraCsvImporter,
    LinearImportService,
    GithubIssuesImportService,
  ],
  exports: [
    ImportService,
    ImportRunsService,
    ImportsDryRunService,
    JiraImportService,
    JiraCsvImporter,
    LinearImportService,
  ],
})
export class ImportModule {}
