"use strict";
/* eslint-disable no-console */
// =============================================================================
// Local-data wipe — DESTRUCTIVE.
//
// Truncates every Prisma model table (CASCADE) so a fresh import can land in
// a clean DB. Also clears the Redis cache, the Qdrant collection used by the
// AI module, and the MinIO/S3 bucket the API writes to. Schema and migrations
// are untouched — `prisma migrate deploy` does not need to re-run.
//
// Refuses to run unless WIPE_CONFIRM=YES is set, and refuses outright when
// NODE_ENV === 'production'. Run:
//
//   WIPE_CONFIRM=YES pnpm --filter @nockta/api wipe:local
//
// =============================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
require("../src/bootstrap-env");
const client_1 = require("@prisma/client");
const env_1 = require("../src/config/env");
const client_s3_1 = require("@aws-sdk/client-s3");
const CONFIRM = process.env['WIPE_CONFIRM'] === 'YES';
// Tables are TRUNCATE-CASCADEd as a single batch. Order doesn't matter when
// CASCADE is set, but listing them is the safety check — if a new model is
// added to schema.prisma and not added here, we'll log it as a warning so the
// operator knows to extend the list.
const ALL_TABLES = [
    // auth / identity
    'RefreshToken', 'MagicLink', 'ChatBinding',
    // org
    'TeamMember', 'Team',
    // projects
    'ProjectAccess', 'ProjectRepo', 'ProjectDeploymentSecret', 'ProjectTemplate',
    // tasks
    'TaskLabel', 'Label',
    'TaskWatcher', 'TaskReporter', 'TaskMute', 'TaskLink',
    'TaskGithubLink', 'TaskDeployment', 'TaskEmbeddingMeta', 'TaskRecurrence',
    'TaskTemplate',
    'Worklog',
    'CommentMention', 'Comment',
    'Attachment',
    'Task',
    'Sprint',
    // docs / goals
    'DocComment', 'DocTask', 'DocRevision', 'Doc',
    'GoalTask', 'KeyResult', 'Goal',
    // automations / templates
    'AutomationRun', 'AutomationStep', 'Automation',
    'CustomFieldValue', 'CustomFieldDefinition',
    // events / notifications / dashboards
    'Notification', 'NotificationPreference',
    'DashboardAccess', 'Dashboard',
    'SavedSearch',
    'Event',
    // integrations
    'GithubRepo', 'GithubInstallation',
    'Deployment',
    // misc
    'IdempotencyKey',
    // projects + users last (everything else points at them)
    'Project',
    'User',
];
async function main() {
    console.log('→ Local-data wipe');
    if (env_1.Env.NODE_ENV === 'production') {
        console.error('❌ NODE_ENV=production — refusing to wipe.');
        process.exit(1);
    }
    if (!CONFIRM) {
        console.error('❌ WIPE_CONFIRM=YES is required. Re-run with the env var set.');
        process.exit(1);
    }
    const prisma = new client_1.PrismaClient();
    try {
        await wipePostgres(prisma);
        await wipeS3();
        await wipeQdrant();
        await wipeRedis();
        console.log('\n✅ Wipe complete. Run `pnpm --filter @nockta/api import:jira` to re-populate.');
    }
    finally {
        await prisma.$disconnect();
    }
}
// ---------------- Postgres ----------------
async function wipePostgres(prisma) {
    console.log('\n→ Postgres');
    // Warn on any model that exists in schema.prisma but isn't in our truncate
    // list — the operator should add it before the next wipe.
    const rows = await prisma.$queryRaw `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
    const unknown = rows
        .map((r) => r.table_name)
        .filter((t) => !ALL_TABLES.includes(t))
        .filter((t) => !t.startsWith('_prisma') && !t.startsWith('Event_'));
    if (unknown.length > 0) {
        console.warn(`   ⚠  ${unknown.length} unknown table(s) skipped: ${unknown.join(', ')}`);
        console.warn('       Add them to ALL_TABLES in wipe-local-data.ts if they should be wiped.');
    }
    // RESTART IDENTITY is harmless on UUID-only tables; it covers any future
    // serial columns. CASCADE handles any FK we might've missed in the manual
    // ordering above.
    const ident = ALL_TABLES.map((t) => `"${t}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${ident} RESTART IDENTITY CASCADE`);
    console.log(`   truncated ${ALL_TABLES.length} table(s)`);
    // Also blow away Event_YYYY_MM monthly partitions. They re-seed via the
    // maintenance scheduler on next boot of the API; if companion.sql was
    // applied, the parent "Event" partitioned table stays in place.
    const partitions = rows
        .map((r) => r.table_name)
        .filter((t) => /^Event_\d{4}_\d{2}$/.test(t));
    for (const p of partitions) {
        await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${p}" CASCADE`);
    }
    if (partitions.length > 0) {
        console.log(`   dropped ${partitions.length} Event_YYYY_MM partition(s)`);
    }
}
// ---------------- S3 / MinIO ----------------
async function wipeS3() {
    console.log('\n→ Object storage');
    try {
        const s3 = new client_s3_1.S3Client({
            region: env_1.Env.S3_REGION,
            endpoint: env_1.Env.S3_ENDPOINT,
            credentials: { accessKeyId: env_1.Env.S3_ACCESS_KEY, secretAccessKey: env_1.Env.S3_SECRET_KEY },
            forcePathStyle: true,
        });
        let purged = 0;
        let continuationToken;
        do {
            const list = await s3.send(new client_s3_1.ListObjectsV2Command({
                Bucket: env_1.Env.S3_BUCKET,
                ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
            }));
            const objects = (list.Contents ?? [])
                .filter((o) => !!o.Key)
                .map((o) => ({ Key: o.Key }));
            if (objects.length > 0) {
                await s3.send(new client_s3_1.DeleteObjectsCommand({
                    Bucket: env_1.Env.S3_BUCKET,
                    Delete: { Objects: objects, Quiet: true },
                }));
                purged += objects.length;
            }
            continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (continuationToken);
        console.log(`   bucket ${env_1.Env.S3_BUCKET}: purged ${purged} object(s)`);
    }
    catch (err) {
        console.warn(`   ⚠  could not wipe bucket: ${err instanceof Error ? err.message : err}`);
    }
}
// ---------------- Qdrant ----------------
async function wipeQdrant() {
    console.log('\n→ Qdrant');
    const base = env_1.Env.QDRANT_URL;
    if (!base) {
        console.log('   QDRANT_URL not set — skipping');
        return;
    }
    // Hardcoded to match TASKS_COLLECTION in apps/api/src/modules/ai/qdrant.service.ts.
    const collection = 'tasks';
    try {
        const res = await fetch(`${base}/collections/${collection}`, { method: 'DELETE' });
        if (res.ok || res.status === 404) {
            console.log(`   collection ${collection}: deleted (will be recreated on next AI run)`);
        }
        else {
            const body = await res.text().catch(() => '');
            console.warn(`   ⚠  delete failed ${res.status}: ${body.slice(0, 200)}`);
        }
    }
    catch (err) {
        console.warn(`   ⚠  Qdrant unreachable: ${err instanceof Error ? err.message : err}`);
    }
}
// ---------------- Redis ----------------
async function wipeRedis() {
    console.log('\n→ Redis');
    // Run FLUSHDB via a one-shot HTTP through the Redis CLI is non-trivial; the
    // pragmatic call is `redis-cli FLUSHDB` from outside this script. We at
    // least drop the session-tracking keys via a SCAN.
    const url = new URL(env_1.Env.REDIS_URL);
    try {
        const { Redis } = await Promise.resolve().then(() => __importStar(require('ioredis')));
        const redis = new Redis(env_1.Env.REDIS_URL);
        const flushed = await redis.flushdb();
        console.log(`   flushdb on ${url.hostname}:${url.port}: ${flushed}`);
        await redis.quit();
    }
    catch (err) {
        console.warn(`   ⚠  Redis unreachable: ${err instanceof Error ? err.message : err}`);
    }
}
main().catch((err) => {
    console.error('\n❌ Wipe failed:', err);
    process.exit(1);
});
//# sourceMappingURL=wipe-local-data.js.map