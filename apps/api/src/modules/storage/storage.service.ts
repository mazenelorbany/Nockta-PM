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

/** S3-compatible storage abstraction. Same code path drives MinIO (local) and R2/S3 (prod). */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  /** Null when S3 env vars are unset — the API still boots, but any
   *  attachment-related route throws InternalServerErrorException. */
  private readonly client: S3Client | null;
  readonly bucket: string;
  readonly quarantineBucket: string;

  constructor() {
    if (
      !Env.S3_ENDPOINT ||
      !Env.S3_ACCESS_KEY ||
      !Env.S3_SECRET_KEY ||
      !Env.S3_BUCKET ||
      !Env.S3_QUARANTINE_BUCKET
    ) {
      this.client = null;
      this.bucket = '';
      this.quarantineBucket = '';
      this.logger.warn(
        'S3 env vars missing — StorageService is in no-op mode. Attachment ' +
          'routes will return 503 until S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, ' +
          'S3_BUCKET, S3_QUARANTINE_BUCKET are configured.',
      );
      return;
    }
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
  }

  /** Asserts S3 is configured. Called by every method that touches the
   *  client — produces a single, consistent 503 instead of a cryptic
   *  "Cannot read properties of null" downstream. */
  private requireClient(): S3Client {
    if (!this.client) {
      throw new InternalServerErrorException(
        'Object storage is not configured on this deployment.',
      );
    }
    return this.client;
  }

  async signedPutUrl(key: string, contentType: string, expiresInSeconds = 300): Promise<string> {
    const client = this.requireClient();
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
  }

  async signedGetUrl(key: string, expiresInSeconds = 900): Promise<string> {
    const client = this.requireClient();
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
  }

  async exists(key: string): Promise<boolean> {
    const client = this.requireClient();
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const client = this.requireClient();
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
    const client = this.requireClient();
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
    const client = this.requireClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async moveToQuarantine(key: string): Promise<void> {
    const client = this.requireClient();
    await client.send(
      new CopyObjectCommand({
        Bucket: this.quarantineBucket,
        Key: key,
        CopySource: `/${this.bucket}/${encodeURIComponent(key)}`,
      }),
    );
    await this.deleteObject(key);
    this.logger.warn(`moved ${key} to quarantine`);
  }
}
