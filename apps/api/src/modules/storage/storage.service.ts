import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { Env } from '../../config/env';

/**
 * Object-storage abstraction. Two backends behind the same 7-method surface:
 *
 *   - `s3`   → any S3-compatible service (MinIO locally, R2 / AWS in prod).
 *             Presigned PUT / GET URLs go directly to the bucket.
 *   - `disk` → local filesystem under STORAGE_DISK_ROOT, intended to be
 *             paired with a Railway Volume so uploads survive redeploys.
 *             `signedPutUrl` / `signedGetUrl` return short-lived
 *             API-self URLs (`/attachments/_blob/<token>`); the API itself
 *             receives the upload and streams downloads. No third-party
 *             credential, fixed monthly cost.
 *
 * When neither backend is configured the service is in no-op mode — the API
 * still boots, but any attachment route throws 503.
 */
type Backend = 's3' | 'disk' | 'noop';

const DISK_TOKEN_TTL_DEFAULT_SECONDS = 900;
// Internal route prefix the disk backend signs URLs against. Matches the
// controller below at AttachmentsController._blob_*; centralised here so a
// rename in one place doesn't silently break signed URL generation.
const DISK_BLOB_ROUTE = '/attachments/_blob';

interface DiskTokenPayload {
  k: string; // storage key
  op: 'put' | 'get';
  ct?: string; // content type (put only — preserves what the browser declared)
  exp: number; // unix ms
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly backend: Backend;
  private readonly client: S3Client | null;
  readonly bucket: string;
  readonly quarantineBucket: string;
  private readonly diskRoot: string;
  private readonly diskQuarantineRoot: string;

  constructor() {
    this.diskRoot = resolve(Env.STORAGE_DISK_ROOT);
    this.diskQuarantineRoot = join(this.diskRoot, '_quarantine');

    if (Env.STORAGE_KIND === 'disk') {
      this.backend = 'disk';
      this.client = null;
      this.bucket = 'disk';
      this.quarantineBucket = 'disk-quarantine';
      // mkdir sync so the service is usable on the first request; missing
      // directory under a Volume mount would otherwise surface as a
      // confusing ENOENT in the upload path.
      mkdirSync(this.diskRoot, { recursive: true });
      mkdirSync(this.diskQuarantineRoot, { recursive: true });
      this.logger.log(
        `StorageService: disk backend (root=${this.diskRoot}). Attach a Railway Volume here so files survive redeploys.`,
      );
      return;
    }

    if (
      Env.STORAGE_KIND === 's3' ||
      // back-compat: if S3_* are all set but STORAGE_KIND isn't, infer s3.
      (Env.S3_ENDPOINT &&
        Env.S3_ACCESS_KEY &&
        Env.S3_SECRET_KEY &&
        Env.S3_BUCKET &&
        Env.S3_QUARANTINE_BUCKET)
    ) {
      if (
        !Env.S3_ENDPOINT ||
        !Env.S3_ACCESS_KEY ||
        !Env.S3_SECRET_KEY ||
        !Env.S3_BUCKET ||
        !Env.S3_QUARANTINE_BUCKET
      ) {
        this.backend = 'noop';
        this.client = null;
        this.bucket = '';
        this.quarantineBucket = '';
        this.logger.warn(
          'STORAGE_KIND=s3 but one or more S3_* env vars are missing — attachment routes will 503. ' +
            'Required: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_QUARANTINE_BUCKET.',
        );
        return;
      }
      this.backend = 's3';
      this.client = new S3Client({
        endpoint: Env.S3_ENDPOINT,
        region: Env.S3_REGION,
        credentials: {
          accessKeyId: Env.S3_ACCESS_KEY,
          secretAccessKey: Env.S3_SECRET_KEY,
        },
        forcePathStyle: Env.S3_FORCE_PATH_STYLE,
      });
      this.bucket = Env.S3_BUCKET;
      this.quarantineBucket = Env.S3_QUARANTINE_BUCKET;
      this.logger.log('StorageService: s3 backend.');
      return;
    }

    this.backend = 'noop';
    this.client = null;
    this.bucket = '';
    this.quarantineBucket = '';
    this.logger.warn(
      'Storage backend not configured (set STORAGE_KIND=disk or =s3). Attachment routes will return 503.',
    );
  }

  // ----- backend introspection -----

  /** Used by the controller to know whether to expose `_blob` routes. */
  isDisk(): boolean {
    return this.backend === 'disk';
  }

  // ----- public API (same surface for both backends) -----

  async signedPutUrl(key: string, contentType: string, expiresInSeconds = 300): Promise<string> {
    if (this.backend === 'disk') {
      return this.makeDiskTokenUrl(key, 'put', expiresInSeconds, contentType);
    }
    const client = this.requireS3Client();
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
  }

  async signedGetUrl(key: string, expiresInSeconds = DISK_TOKEN_TTL_DEFAULT_SECONDS): Promise<string> {
    if (this.backend === 'disk') {
      return this.makeDiskTokenUrl(key, 'get', expiresInSeconds);
    }
    const client = this.requireS3Client();
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
  }

  async exists(key: string): Promise<boolean> {
    if (this.backend === 'disk') {
      try {
        await stat(this.diskPath(key));
        return true;
      } catch {
        return false;
      }
    }
    const client = this.requireS3Client();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    if (this.backend === 'disk') {
      return readFile(this.diskPath(key));
    }
    const client = this.requireS3Client();
    const result = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = result.Body as NodeJS.ReadableStream | undefined;
    if (!body) throw new InternalServerErrorException(`No body for object ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    if (this.backend === 'disk') {
      const path = this.diskPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      // contentType is not stored on disk — callers that need mime info read
      // it from the Attachment row in Postgres.
      void contentType;
      return;
    }
    const client = this.requireS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    if (this.backend === 'disk') {
      try {
        await unlink(this.diskPath(key));
      } catch (err) {
        // Already-gone is fine — same shape as S3 deleting a missing key.
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw err;
      }
      return;
    }
    const client = this.requireS3Client();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async moveToQuarantine(key: string): Promise<void> {
    if (this.backend === 'disk') {
      const from = this.diskPath(key);
      const to = this.diskPath(key, /* quarantine */ true);
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      this.logger.warn(`moved ${key} to disk quarantine`);
      return;
    }
    const client = this.requireS3Client();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.quarantineBucket,
        Key: key,
        CopySource: `/${this.bucket}/${encodeURIComponent(key)}`,
      }),
    );
    await this.deleteObject(key);
    this.logger.warn(`moved ${key} to s3 quarantine`);
  }

  // ----- disk-backend internals (exposed for the controller) -----

  /**
   * Verify a disk-blob token and return the decoded payload. Throws if the
   * token is malformed, the signature doesn't match, or it has expired.
   * The controller calls this on every `_blob/:token` hit before touching
   * the filesystem, so a stolen-but-expired URL can't replay.
   */
  verifyDiskToken(token: string, expectedOp: 'put' | 'get'): DiskTokenPayload {
    if (this.backend !== 'disk') {
      throw new InternalServerErrorException('Disk token verification on non-disk backend');
    }
    const parts = token.split('.');
    if (parts.length !== 2) throw new InternalServerErrorException('Malformed token');
    const [payloadB64, sigHex] = parts;
    if (!payloadB64 || !sigHex) throw new InternalServerErrorException('Malformed token');
    const expectedSig = this.signDiskPayload(payloadB64);
    const a = Buffer.from(sigHex, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new InternalServerErrorException('Bad token signature');
    }
    let payload: DiskTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as DiskTokenPayload;
    } catch {
      throw new InternalServerErrorException('Token payload not JSON');
    }
    if (payload.op !== expectedOp) {
      throw new InternalServerErrorException(`Token op mismatch (want ${expectedOp})`);
    }
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
      throw new InternalServerErrorException('Token expired');
    }
    return payload;
  }

  /** Filesystem path for a storage key. Guards against path traversal —
   *  callers route through this so a key like `../../etc/passwd` can't
   *  escape the root. */
  diskPath(key: string, quarantine = false): string {
    const root = quarantine ? this.diskQuarantineRoot : this.diskRoot;
    const safeKey = key.split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
    const full = normalize(join(root, safeKey));
    if (!full.startsWith(root + sep) && full !== root) {
      throw new InternalServerErrorException('Storage key escapes root');
    }
    return full;
  }

  // ----- internal helpers -----

  private requireS3Client(): S3Client {
    if (this.backend === 'disk') {
      throw new InternalServerErrorException(
        'Storage is disk-backed; this method is for S3 only. Check the controller wiring.',
      );
    }
    if (!this.client) {
      throw new InternalServerErrorException(
        'Object storage is not configured on this deployment.',
      );
    }
    return this.client;
  }

  private makeDiskTokenUrl(
    key: string,
    op: 'put' | 'get',
    expiresInSeconds: number,
    contentType?: string,
  ): string {
    const payload: DiskTokenPayload = {
      k: key,
      op,
      exp: Date.now() + expiresInSeconds * 1000,
      ...(op === 'put' && contentType ? { ct: contentType } : {}),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = this.signDiskPayload(payloadB64);
    const token = `${payloadB64}.${sig}`;
    const base = Env.APP_URL_API.replace(/\/+$/, '');
    return `${base}/api/v1${DISK_BLOB_ROUTE}/${token}`;
  }

  private signDiskPayload(payloadB64: string): string {
    // HMAC-SHA256 with the JWT secret. Reusing JWT_ACCESS_SECRET avoids
    // introducing a new secret to manage; rotating it would invalidate
    // in-flight upload URLs but that's a 5-minute window and recoverable
    // (the client re-fetches /attachments/sign).
    return createHmac('sha256', Env.JWT_ACCESS_SECRET).update(payloadB64).digest('hex');
  }

}
