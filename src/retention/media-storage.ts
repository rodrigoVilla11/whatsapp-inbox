import { Injectable, Logger } from '@nestjs/common';

/**
 * Puerto de storage de media. La implementación real (Cloudflare R2) llega
 * en la fase 5; el purgado de datos no puede esperarla, así que el servicio
 * de retención depende de esta interfaz y hoy recibe el noop.
 */
export interface MediaStorage {
  /** Borra los objetos referenciados por estas URLs. Best-effort: loguea fallos, no tira. */
  deleteByUrls(urls: string[]): Promise<void>;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

@Injectable()
export class NoopMediaStorage implements MediaStorage {
  private readonly logger = new Logger(NoopMediaStorage.name);

  async deleteByUrls(urls: string[]): Promise<void> {
    if (urls.length > 0) {
      this.logger.warn(
        `MediaStorage noop: ${urls.length} objeto(s) de media quedaron sin borrar (R2 llega en fase 5)`,
      );
    }
  }
}
