import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as signS3Url } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

export type StorageDriver = 'local' | 's3';

export type PutObjectInput = {
  key: string;
  body: Buffer | Uint8Array | string | Readable;
  contentType?: string;
};

export type StorageClient = {
  driver: StorageDriver;
  bucket: string;
  putObject(input: PutObjectInput): Promise<{ key: string; url?: string }>;
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
};

export type StorageConfig = {
  driver?: StorageDriver;
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  localRoot?: string;
  publicBaseUrl?: string;
};

function cleanPrefix(value = '') {
  return value.replace(/^\/+|\/+$/g, '');
}

function safeKey(key: string) {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) throw new Error(`Invalid object key: ${key}`);
  return normalized;
}

async function readableToBuffer(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function bodyToBuffer(body: PutObjectInput['body']) {
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return readableToBuffer(body);
}

export function storageConfigFromEnv(): StorageConfig {
  return {
    driver: (process.env.OBJECT_STORAGE_DRIVER as StorageDriver | undefined) || 'local',
    bucket: process.env.OBJECT_STORAGE_BUCKET || process.env.MINIO_BUCKET || 'aigc-video-hub',
    region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
    endpoint:
      process.env.OBJECT_STORAGE_ENDPOINT ||
      (process.env.MINIO_ENDPOINT ? `http://${process.env.MINIO_ENDPOINT.replace(/^https?:\/\//, '')}` : undefined),
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || process.env.MINIO_SECRET_KEY,
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false',
    localRoot: process.env.OBJECT_STORAGE_LOCAL_ROOT || path.resolve(process.cwd(), 'storage'),
    publicBaseUrl: process.env.OBJECT_STORAGE_PUBLIC_BASE_URL,
  };
}

export function createStorageClient(config: StorageConfig = storageConfigFromEnv()): StorageClient {
  const driver = config.driver || 'local';
  const bucket = config.bucket || 'aigc-video-hub';

  if (driver === 'local') {
    const root = path.resolve(config.localRoot || path.resolve(process.cwd(), 'storage'));
    const publicBaseUrl = config.publicBaseUrl?.replace(/\/$/, '');

    return {
      driver,
      bucket,
      async putObject(input) {
        const key = safeKey(input.key);
        const filePath = path.join(root, key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, await bodyToBuffer(input.body));
        return {
          key,
          url: publicBaseUrl ? `${publicBaseUrl}/${cleanPrefix(key)}` : filePath,
        };
      },
      async getSignedUrl(key) {
        const normalized = safeKey(key);
        return publicBaseUrl ? `${publicBaseUrl}/${cleanPrefix(normalized)}` : path.join(root, normalized);
      },
      async deleteObject(key) {
        const filePath = path.join(root, safeKey(key));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      },
    };
  }

  const s3 = new S3Client({
    region: config.region || 'us-east-1',
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? true,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined,
  });

  return {
    driver,
    bucket,
    async putObject(input) {
      const key = safeKey(input.key);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
      return { key };
    },
    async getSignedUrl(key, expiresInSeconds = 900) {
      return signS3Url(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: safeKey(key),
        }),
        { expiresIn: expiresInSeconds },
      );
    },
    async deleteObject(key) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: safeKey(key),
        }),
      );
    },
  };
}
