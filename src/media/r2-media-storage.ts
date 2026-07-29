import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '@nestjs/common';
import type { MediaStorage } from './media-storage';

export interface R2Config {
  endpoint: string; // https://<account_id>.r2.cloudflarestorage.com
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Endpoint de la API S3 de R2 a partir del Account ID — la MISMA convención
 * que el resto de Gourmetify (que configura `R2_ACCOUNT_ID`, no una URL).
 *
 * Ojo con el dominio público del bucket (`https://pub-<hash>.r2.dev`): sirve
 * objetos por HTTP pero NO habla la API S3 (rechaza el handshake TLS del
 * SDK), así que no es un endpoint válido acá. Además el bucket de media es
 * privado a propósito: se sirve con URLs firmadas de TTL corto.
 */
export function r2EndpointForAccount(accountId: string): string {
  return `https://${accountId.trim()}.r2.cloudflarestorage.com`;
}

const DELETE_BATCH_SIZE = 1000; // límite de DeleteObjects en S3/R2

/**
 * Cloudflare R2 vía API S3-compatible. El bucket es PRIVADO: el contenido
 * de conversaciones se sirve únicamente con URLs firmadas de TTL corto.
 */
export class R2MediaStorage implements MediaStorage {
  private readonly logger = new Logger(R2MediaStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
      try {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      } catch (error) {
        // Best-effort: huérfanos en R2 > fantasmas en la DB.
        this.logger.error(`No se pudieron borrar ${batch.length} objeto(s): ${String(error)}`);
      }
    }
  }

  async getPresignedUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }
}
