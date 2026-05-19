import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the env module before importing StorageService so the constructor
// reads the disk-backend values instead of the s3 defaults baked in by
// test-utils/env-setup. tempRoot is a holder that the mock reads at
// construction time — we reassign it inside beforeEach so each test has
// its own isolated filesystem root.
const envHolder: { kind: 's3' | 'disk'; root: string } = {
  kind: 'disk',
  root: '/tmp/initial-placeholder',
};

vi.mock('../../config/env', async () => {
  const actual = (await vi.importActual('../../config/env')) as typeof import('../../config/env');
  return {
    ...actual,
    Env: new Proxy(actual.Env, {
      get(target, prop) {
        if (prop === 'STORAGE_KIND') return envHolder.kind;
        if (prop === 'STORAGE_DISK_ROOT') return envHolder.root;
        return (target as Record<string | symbol, unknown>)[prop];
      },
    }),
  };
});

// Import AFTER the mock is registered so StorageService picks up the
// proxied Env. Top-level await isn't needed because vi.mock is hoisted.
import { StorageService } from './storage.service';

describe('StorageService (disk backend)', () => {
  let tempRoot: string;
  let service: StorageService;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'nockta-storage-test-'));
    envHolder.root = tempRoot;
    envHolder.kind = 'disk';
    service = new StorageService();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe('signed token URLs', () => {
    it('round-trips a PUT token through verifyDiskToken', async () => {
      const url = await service.signedPutUrl('projects/p/Task/t/abc-file.png', 'image/png', 300);
      const token = url.split('/_blob/')[1] ?? '';
      const payload = service.verifyDiskToken(token, 'put');
      expect(payload.k).toBe('projects/p/Task/t/abc-file.png');
      expect(payload.op).toBe('put');
      expect(payload.ct).toBe('image/png');
      expect(payload.exp).toBeGreaterThan(Date.now());
    });

    it('rejects a GET token used as PUT (op confusion)', async () => {
      const url = await service.signedGetUrl('k', 300);
      const token = url.split('/_blob/')[1] ?? '';
      expect(() => service.verifyDiskToken(token, 'put')).toThrow(/op mismatch/i);
    });

    it('rejects an expired token', async () => {
      const url = await service.signedGetUrl('k', -1);
      const token = url.split('/_blob/')[1] ?? '';
      expect(() => service.verifyDiskToken(token, 'get')).toThrow(/expired/i);
    });

    it('rejects a tampered signature', async () => {
      const url = await service.signedGetUrl('k', 300);
      const token = url.split('/_blob/')[1] ?? '';
      const [payload, sig] = token.split('.');
      const bad = `${payload}.${'0'.repeat(sig?.length ?? 64)}`;
      expect(() => service.verifyDiskToken(bad, 'get')).toThrow(/signature/i);
    });

    it('rejects a tampered payload (signature no longer matches)', async () => {
      const url = await service.signedGetUrl('k', 300);
      const token = url.split('/_blob/')[1] ?? '';
      const [, sig] = token.split('.');
      const evil = Buffer.from(JSON.stringify({ k: 'other', op: 'get', exp: Date.now() + 60_000 })).toString(
        'base64url',
      );
      const bad = `${evil}.${sig}`;
      expect(() => service.verifyDiskToken(bad, 'get')).toThrow(/signature/i);
    });
  });

  describe('diskPath path traversal', () => {
    it('contains traversal segments — file lands under root, not at /etc/passwd', () => {
      const p = service.diskPath('../../../etc/passwd');
      // The security property is "cannot escape tempRoot". The `..`
      // segments are stripped so the path resolves to <tempRoot>/etc/passwd,
      // which is harmless even though it visually contains "etc/passwd".
      expect(p.startsWith(tempRoot + '/')).toBe(true);
      expect(p).toBe(join(tempRoot, 'etc/passwd'));
    });

    it('preserves nested paths inside the root', () => {
      const p = service.diskPath('projects/abc/Task/def/file.png');
      expect(p).toBe(join(tempRoot, 'projects/abc/Task/def/file.png'));
    });
  });

  describe('object lifecycle', () => {
    const KEY = 'projects/test/Task/test/some-file.txt';

    it('putBuffer + exists + getBuffer round-trip', async () => {
      const body = Buffer.from('hello disk backend');
      await service.putBuffer(KEY, body, 'text/plain');
      expect(await service.exists(KEY)).toBe(true);
      const got = await service.getBuffer(KEY);
      expect(got.equals(body)).toBe(true);
    });

    it('exists returns false for a missing key', async () => {
      expect(await service.exists('does/not/exist')).toBe(false);
    });

    it('deleteObject is idempotent on missing keys (matches S3 semantics)', async () => {
      await expect(service.deleteObject('does/not/exist')).resolves.toBeUndefined();
    });

    it('moveToQuarantine relocates the file', async () => {
      await service.putBuffer(KEY, Buffer.from('infected'), 'text/plain');
      await service.moveToQuarantine(KEY);
      expect(await service.exists(KEY)).toBe(false);
      expect(service.diskPath(KEY, true)).toContain('_quarantine');
    });
  });

  it('isDisk() reports the active backend', () => {
    expect(service.isDisk()).toBe(true);
  });
});
