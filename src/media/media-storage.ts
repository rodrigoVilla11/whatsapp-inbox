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
 * Implementación para dev SIN credenciales R2 (R2_* vacías). Nunca finge:
 * put y getPresignedUrl fallan explícito con 503; delete sí es no-op con
 * warning (su contrato ya es best-effort). Con R2_* configuradas el módulo
 * registra R2MediaStorage.
 *
 * put TIENE que tirar: si devolviera ok, el mensaje quedaría marcado
 * DOWNLOADED sin bytes guardados y la UI mostraría media roto (503 al
 * pedir la URL firmada) en vez de un "Archivo no disponible" honesto.
 */
export class NoopMediaStorage implements MediaStorage {
  private readonly logger = new Logger(NoopMediaStorage.name);

  async put(key: string): Promise<void> {
    this.logger.warn(`MediaStorage noop: put(${key}) imposible — configurá R2_* en .env`);
    throw new ServiceUnavailableException(
      'Storage de media no configurado (faltan R2_* en env)',
    );
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
