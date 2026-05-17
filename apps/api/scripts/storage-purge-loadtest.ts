/* eslint-disable no-console */
// =============================================================================
// scripts/storage-purge-loadtest.ts
//
// Load-test the attachment purge path that MaintenanceScheduler runs every
// hour. Seeds N fake Attachment rows (with corresponding S3 stub objects),
// pre-dates them so the 30-day cutoff matches, then invokes the scheduler's
// purge method directly and verifies:
//   1. All DB rows are gone afterwards.
//   2. All S3 keys (primary + thumbs) are gone afterwards.
//   3. Reports throughput (rows/sec) so we know how the production hourly
//      tick will scale.
//
// Run locally against the docker-compose stack:
//   pnpm --filter @nockta/api exec tsx scripts/storage-purge-loadtest.ts 500
//
// The script is destructive — it deletes whatever Attachments it creates and
// is safe to re-run, but don't point it at production. It refuses to run when
// NODE_ENV=production for that reason.
// =============================================================================

import '../src/bootstrap-env';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { MaintenanceScheduler } from '../src/modules/maintenance/maintenance.scheduler';
import { randomUUID } from 'crypto';

interface LoadTestOptions {
  count: number;
  withThumbs: boolean;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the load test against production');
  }
  const count = Number(process.argv[2] ?? 500);
  const opts: LoadTestOptions = {
    count: Number.isFinite(count) && count > 0 ? count : 500,
    withThumbs: process.argv.includes('--thumbs'),
  };
  const log = new Logger('purge-loadtest');

  log.log(`Booting test app context (count=${opts.count}, thumbs=${opts.withThumbs})…`);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);
  const scheduler = app.get(MaintenanceScheduler);

  // 1. Pick a real project + user to satisfy the FK constraints. We're not
  //    creating tasks — attachments can attach to any Task; we use a synthetic
  //    parentId that exists. The cheap option: find one real task.
  const task = await prisma.task.findFirst({ select: { id: true, projectId: true } });
  const uploader = await prisma.user.findFirst({ select: { id: true } });
  if (!task || !uploader) {
    log.error('Need at least one Task + one User in the DB to seed attachments. Aborting.');
    await app.close();
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago — past the 30-day window

  // 2. Seed N attachment rows. Each gets a small stub blob in S3 so the purge
  //    actually exercises the storage path. Thumbnail keys are optional via flag.
  log.log(`Seeding ${opts.count} stale Attachment row(s) with S3 stubs…`);
  const seededIds: string[] = [];
  const seededKeys: string[] = [];
  const seedStart = Date.now();

  for (let i = 0; i < opts.count; i += 1) {
    const id = randomUUID();
    const storageKey = `loadtest/${id}/payload.bin`;
    const thumb200Key = opts.withThumbs ? `loadtest/${id}/thumb-200.webp` : null;
    const thumb800Key = opts.withThumbs ? `loadtest/${id}/thumb-800.webp` : null;

    // Tiny stub uploads so the storage.delete actually has something to remove.
    const stubBody = Buffer.from(`stub ${id}`);
    await storage.putBuffer(storageKey, stubBody, 'application/octet-stream');
    if (thumb200Key) await storage.putBuffer(thumb200Key, stubBody, 'image/webp');
    if (thumb800Key) await storage.putBuffer(thumb800Key, stubBody, 'image/webp');

    await prisma.attachment.create({
      data: {
        id,
        parentType: 'Task',
        parentId: task.id,
        projectId: task.projectId,
        uploaderUserId: uploader.id,
        originalFilename: `loadtest-${i}.bin`,
        mimeType: 'application/octet-stream',
        sizeBytes: BigInt(stubBody.length),
        storageKey,
        thumb200Key,
        thumb800Key,
        visibility: 'internal',
        scanStatus: 'clean',
        deletedAt: cutoff,
        createdAt: cutoff,
      },
    });
    seededIds.push(id);
    seededKeys.push(storageKey);
    if (thumb200Key) seededKeys.push(thumb200Key);
    if (thumb800Key) seededKeys.push(thumb800Key);
    if ((i + 1) % 100 === 0) log.log(`  seeded ${i + 1}/${opts.count}`);
  }
  const seedMs = Date.now() - seedStart;
  log.log(`Seeded ${opts.count} rows in ${seedMs}ms (${((opts.count / seedMs) * 1000).toFixed(1)} rows/s).`);

  // 3. Invoke the actual maintenance tick. MaintenanceScheduler.tick is private
  //    but the scheduler is instantiated; we cast to access. In a real test
  //    setup we'd expose a public test hook — for a one-off load script this
  //    is acceptable.
  log.log('Running maintenance tick (purges in batches of 100)…');
  const purgeStart = Date.now();
  // The scheduler does at most 100 rows per tick; loop until nothing's left.
  let remaining = opts.count;
  let ticks = 0;
  while (remaining > 0) {
    ticks += 1;
    await (scheduler as unknown as { tick: () => Promise<void> }).tick();
    // After one tick, count how many of OUR ids remain.
    const left = await prisma.attachment.count({ where: { id: { in: seededIds } } });
    if (left === remaining) {
      log.warn(`Tick ${ticks} made no progress — bailing. ${remaining} row(s) left.`);
      break;
    }
    remaining = left;
    log.log(`  tick ${ticks}: ${opts.count - remaining}/${opts.count} purged`);
  }
  const purgeMs = Date.now() - purgeStart;
  const purged = opts.count - remaining;
  log.log(
    `Purge complete: ${purged}/${opts.count} rows in ${purgeMs}ms ` +
    `(${((purged / purgeMs) * 1000).toFixed(1)} rows/s, ${ticks} tick(s))`,
  );

  // 4. Verify: DB rows gone + S3 keys gone.
  const dbRemaining = await prisma.attachment.count({ where: { id: { in: seededIds } } });
  let s3Remaining = 0;
  for (const k of seededKeys) {
    const exists = await storage.exists(k);
    if (exists) s3Remaining += 1;
  }

  log.log('--- RESULTS ---');
  log.log(`  DB rows remaining: ${dbRemaining} (expected 0)`);
  log.log(`  S3 keys remaining: ${s3Remaining} / ${seededKeys.length} (expected 0)`);
  log.log(`  Seed throughput:   ${((opts.count / seedMs) * 1000).toFixed(1)} rows/s`);
  log.log(`  Purge throughput:  ${((purged / purgeMs) * 1000).toFixed(1)} rows/s`);
  log.log(`  Total ticks needed: ${ticks} (batch size 100 → ${Math.ceil(opts.count / 100)} expected)`);

  await app.close();

  if (dbRemaining > 0 || s3Remaining > 0) {
    log.error('FAILED: leftover state detected. Inspect manually.');
    process.exit(1);
  }
  log.log('OK: all rows + S3 stubs cleared.');
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
