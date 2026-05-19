/* eslint-disable no-console */
// =============================================================================
// Jira → Nockta Flow CLI — thin wrapper around JiraImportService.
//
// All import logic lives in apps/api/src/modules/import/jira-import.service.ts
// so the UI flow (Import Center) and the CLI share the same code path. That
// service handles: project + task creation, ADF → Markdown for descriptions
// AND comment bodies AND worklog notes, labels + components, parent/Epic
// links, comments, worklogs, and createdAt + updatedAt preservation. It is
// always active-users-only (deactivated atlassian accounts are remapped to
// the admin user).
//
// Env vars:
//   JIRA_DOMAIN          e.g. nockta.atlassian.net
//   JIRA_EMAIL           e.g. you@nockta.com
//   JIRA_API_TOKEN       https://id.atlassian.com/manage-profile/security/api-tokens
//   IMPORT_ADMIN_EMAIL   defaults to admin@nockta.com
//   IMPORT_PROJECT_KEYS  optional comma-separated subset
//   IMPORT_DRY_RUN       set to "1" to log without writing
//   IMPORT_USER_MAP      optional path to CSV mapping Jira accountId → real
//                        Nockta email + display name. Format:
//                          accountId,email,name
//                        Atlassian hides emails by default; without this map
//                        every imported user gets a `${accountId}@jira-imported.local`
//                        stub and won't be picked up on Google OAuth login.
//
// Run:
//   pnpm --filter @nockta/api import:jira
//   pnpm --filter @nockta/api import:jira:dry
//   IMPORT_USER_MAP=./users.csv pnpm --filter @nockta/api import:jira
// =============================================================================

import '../src/bootstrap-env';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ImportRunsService } from '../src/modules/import/import-runs.service';
import {
  JiraImportService,
  type JiraImportMapping,
} from '../src/modules/import/jira-import.service';
import { loadUserMapFile } from '../src/modules/import/user-map';

const JIRA_DOMAIN = requireEnv('JIRA_DOMAIN');
const JIRA_EMAIL = requireEnv('JIRA_EMAIL');
const JIRA_API_TOKEN = requireEnv('JIRA_API_TOKEN');
const ADMIN_EMAIL = process.env['IMPORT_ADMIN_EMAIL'] ?? 'admin@nockta.com';
const PROJECT_FILTER = (process.env['IMPORT_PROJECT_KEYS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DRY_RUN = process.env['IMPORT_DRY_RUN'] === '1';
const USER_MAP_PATH = process.env['IMPORT_USER_MAP'] ?? null;
const USER_MAP = loadUserMapFile(USER_MAP_PATH);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  console.log(`→ Jira → Nockta Flow import (service-backed)`);
  console.log(`  domain          ${JIRA_DOMAIN}`);
  console.log(`  user            ${JIRA_EMAIL}`);
  console.log(`  admin           ${ADMIN_EMAIL}`);
  console.log(
    `  filter          ${PROJECT_FILTER.length > 0 ? PROJECT_FILTER.join(', ') : '(all visible projects)'}`,
  );
  console.log(`  dry run         ${DRY_RUN ? 'YES' : 'no'}`);
  console.log(
    `  user map        ${USER_MAP_PATH ? `${USER_MAP_PATH} (${USER_MAP.size} overrides)` : '(none — falls back to atlassian visibility)'}`,
  );
  console.log();

  const prisma = new PrismaClient();
  const runs = new ImportRunsService(prisma as unknown as PrismaService);
  const service = new JiraImportService(prisma as unknown as PrismaService, runs);

  await prisma.workspace.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default', name: 'Default', slug: 'default' },
  });

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
      name: 'Admin',
      kind: 'internal',
      companyRole: 'Admin',
      workspaceId: 'default',
    },
    select: { id: true },
  });

  const creds = { domain: JIRA_DOMAIN, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN };
  const allProjects = await service.listProjects(creds);
  const filtered = PROJECT_FILTER.length
    ? allProjects.filter((p) => PROJECT_FILTER.includes(p.key))
    : allProjects;
  console.log(`   ${filtered.length} project(s) to import (of ${allProjects.length})\n`);

  for (const jp of filtered) {
    console.log(`→ ${jp.key} (${jp.name})`);
    const runId = await runs.start({
      source: 'jira',
      actorUserId: admin.id,
      sourceRef: jp.key,
      mappingSnapshot: { projectKey: jp.key, mapping: {} as JiraImportMapping },
    });
    try {
      await service.executeRun(prisma, runId, creds, jp, {}, {
        actorUserId: admin.id,
        dryRun: DRY_RUN,
        ...(USER_MAP.size > 0 ? { userMap: USER_MAP } : {}),
      });
      const final = await runs.get(runId);
      const f = final as { createdRows: number; skippedRows: number; erroredRows: number } | null;
      console.log(
        `   ✓ done — created ${f?.createdRows ?? 0}, skipped ${f?.skippedRows ?? 0}, errors ${f?.erroredRows ?? 0}`,
      );
    } catch (err) {
      console.error(`   ❌ failed:`, err instanceof Error ? err.message : err);
      await runs.finish({
        runId,
        status: 'failed',
        errorSummary: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await prisma.$disconnect();
  console.log('\n🏁 Jira import complete.');
}

main().catch((err) => {
  console.error('\n❌ Import failed:', err);
  process.exit(1);
});
