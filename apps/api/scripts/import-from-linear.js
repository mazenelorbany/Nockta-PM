"use strict";
/* eslint-disable no-console */
// =============================================================================
// Linear → Nockta Flow CLI — thin wrapper around LinearImportService.
//
// The original 480-line script has been refactored into
// apps/api/src/modules/import/linear-import.service.ts so the in-product UI
// flow and the CLI share the same code path. This wrapper:
//   1. Reads the same env vars the script used to.
//   2. Builds a standalone PrismaClient (no Nest context).
//   3. Constructs ImportRunsService + LinearImportService directly.
//   4. Calls executeRun() and prints a final summary.
//
// Env vars (unchanged):
//   LINEAR_API_KEY               personal API key, prefix `lin_api_…`
//   IMPORT_ADMIN_EMAIL           defaults to admin@nockta.com
//   IMPORT_LINEAR_TEAM_KEYS      optional comma-separated subset
//   IMPORT_DRY_RUN               set to "1" to log without writing
//   IMPORT_INCLUDE_ARCHIVED      set to "1" to also pull archived issues
//
// Run:
//   pnpm --filter @nockta/api tsx scripts/import-from-linear.ts
//   pnpm --filter @nockta/api tsx scripts/import-from-linear.ts --dry-run
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
require("../src/bootstrap-env");
const client_1 = require("@prisma/client");
const import_runs_service_1 = require("../src/modules/import/import-runs.service");
const linear_import_service_1 = require("../src/modules/import/linear-import.service");
const LINEAR_API_KEY = requireEnv('LINEAR_API_KEY');
const ADMIN_EMAIL = process.env['IMPORT_ADMIN_EMAIL'] ?? 'admin@nockta.com';
const TEAM_FILTER = (process.env['IMPORT_LINEAR_TEAM_KEYS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const DRY_RUN = process.env['IMPORT_DRY_RUN'] === '1' || process.argv.includes('--dry-run');
const INCLUDE_ARCHIVED = process.env['IMPORT_INCLUDE_ARCHIVED'] === '1';
function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`❌ Missing required env var: ${name}`);
        console.error('   Create a Personal API Key in Linear → Settings → API.');
        process.exit(1);
    }
    return v;
}
async function main() {
    const prisma = new client_1.PrismaClient();
    // ImportRunsService accepts PrismaService — PrismaClient is a structural match
    // since PrismaService extends PrismaClient. The optional `gateway` argument
    // is omitted, so progress emits are no-ops in the CLI (we print our own
    // progress to stdout below).
    const runs = new import_runs_service_1.ImportRunsService(prisma);
    const service = new linear_import_service_1.LinearImportService(prisma, runs);
    const admin = await prisma.user.upsert({
        where: { email: ADMIN_EMAIL },
        update: {},
        create: { email: ADMIN_EMAIL, name: 'Imported Admin', kind: 'internal', companyRole: 'Admin' },
        select: { id: true },
    });
    console.log('🔍 Fetching Linear teams…');
    const teams = await service.listTeams(LINEAR_API_KEY);
    const filtered = TEAM_FILTER.length
        ? teams.filter((t) => TEAM_FILTER.includes(t.key))
        : teams;
    console.log(`  ${filtered.length}/${teams.length} team(s) selected`);
    const mapping = {
        preset: 'engineering',
        includeArchived: INCLUDE_ARCHIVED,
    };
    for (const team of filtered) {
        console.log(`\n▶ Team ${team.key} (${team.name})`);
        // Create the run row up front, then call executeRun() synchronously so
        // the CLI awaits completion. (runImport() fires async — wrong shape for
        // the CLI.)
        const runId = await runs.start({
            source: 'linear',
            actorUserId: admin.id,
            sourceRef: team.key,
            mappingSnapshot: { teamId: team.id, teamKey: team.key, mapping },
        });
        try {
            await service.executeRun(prisma, runId, LINEAR_API_KEY, team, mapping, {
                actorUserId: admin.id,
                dryRun: DRY_RUN,
            });
            const final = await runs.get(runId);
            const f = final;
            console.log(`  ✓ done — created ${f?.createdRows ?? 0}, skipped ${f?.skippedRows ?? 0}, errors ${f?.erroredRows ?? 0}`);
        }
        catch (err) {
            console.error(`  ❌ failed:`, err instanceof Error ? err.message : err);
            await runs.finish({
                runId,
                status: 'failed',
                errorSummary: err instanceof Error ? err.message : String(err),
            });
        }
    }
    await prisma.$disconnect();
    console.log('\n🏁 Linear import complete.');
}
main().catch((err) => {
    console.error('\n❌ Import failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=import-from-linear.js.map