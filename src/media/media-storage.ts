import { Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Puerto de storage de media (reemplaza al de fase 1, ahora con contrato
 * completo). En Message.mediaUrl se guarda la KEY del objeto, nunca una
 * URL: las URLs se generan firmadas al momento de servir, con TTL corto.
 */
export interface MediaStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Best-effort: loguea fallos, no tira (la DB ya quedó consistente). */
  delete(keys: string[]): Promise<void>;
  getPresignedUrl(key: string, ttlSeconds: number): Promise<string>;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

/**
 * Implementación para dev SIN credenciales R2 (R2_* vacías). put/delete son
 * no-op con warning; servir media falla explícito con 503 — nunca finge una
 * URL. Con R2_* configuradas el módulo registra R2MediaStorage.
 */
export class NoopMediaStorage implements MediaStorage {
  private readonly logger = new Logger(NoopMediaStorage.name);

  async put(key: string): Promise<void> {
    this.logger.warn(`MediaStorage noop: put(${key}) descartado — configurá R2_* en .env`);
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length > 0) {
      this.logger.warn(`MediaStorage noop: ${keys.length} objeto(s) sin borrar — configurá R2_*`);
    }
  }

  async getPresignedUrl(): Promise<string> {
    throw new ServiceUnavailableException('Storage de media no configurado (faltan R2_* en env)');
  }
}
