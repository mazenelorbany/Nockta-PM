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
  private readonly client: S3Client;
  readonly bucket: string;
  readonly quarantineBucket: string;

  constructor() {
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

  async signedPutUrl(key: string, contentType: string, expiresInSeconds = 300): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
  }

  async signedGetUrl(key: string, expiresInSeconds = 900): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = result.Body as NodeJS.ReadableStream | undefined;
    if (!body) throw new InternalServerErrorException(`No body for object ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async moveToQuarantine(key: string): Promise<void> {
    await this.client.send(
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
