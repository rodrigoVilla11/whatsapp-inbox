import type { INestApplication } from '@nestjs/common';
import type pino from 'pino';

/**
 * Graceful shutdown (fase 10). Orden y porqué:
 *
 * 1. Se deja de aceptar tráfico: app.close() cierra el HTTP server primero
 *    (requests en vuelo terminan; nuevos, rechazados).
 * 2. Gateway WS: onModuleDestroy desconecta a los clientes (disparan su
 *    reconexión, y al volver refetchean por REST — contrato de fase 6) y
 *    cierra el suscriptor Redis.
 * 3. Workers de BullMQ (@nestjs/bullmq): close() espera los jobs EN CURSO —
 *    una descarga de media a mitad de camino no se mata; los jobs
 *    pendientes quedan en Redis (con AOF) para la próxima instancia.
 * 4. Prisma y Redis (publisher, health) cierran al final: los pasos
 *    anteriores todavía los necesitan.
 * 5. Watchdog: si TODO eso no terminó en DRAIN_TIMEOUT_MS (un job colgado,
 *    un socket zombie), salida forzada con código 1 — el orquestador
 *    prefiere un restart sucio a un contenedor que nunca muere.
 *
 * 1–4 los ordena Nest solo (app.close() recorre los hooks de módulos en
 * orden inverso de inicialización); acá se agrega el watchdog y el logging.
 */

export const DRAIN_TIMEOUT_MS = 30_000;

export interface CloseOutcome {
  ok: boolean;
  timedOut: boolean;
  ms: number;
}

/**
 * Espera un close() hasta timeoutMs. Si el close termina antes (job en
 * curso que finaliza), se espera COMPLETO — el timeout es techo, no apuro.
 */
export async function closeWithTimeout(
  close: () => Promise<void>,
  timeoutMs: number,
): Promise<CloseOutcome> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([close().then(() => 'done' as const), timeout]);
    return { ok: result === 'done', timedOut: result === 'timeout', ms: Date.now() - start };
  } catch {
    return { ok: false, timedOut: false, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

export function registerGracefulShutdown(app: INestApplication, logger: pino.Logger): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown: drenando (HTTP → WS → workers → DB/Redis)');
    // watchdog aparte del race: aunque close() cuelgue, el proceso muere
    const watchdog = setTimeout(() => {
      logger.error({ timeoutMs: DRAIN_TIMEOUT_MS }, 'shutdown: drain colgado — salida forzada');
      process.exit(1);
    }, DRAIN_TIMEOUT_MS + 5_000);
    watchdog.unref();

    void closeWithTimeout(() => app.close(), DRAIN_TIMEOUT_MS).then((outcome) => {
      if (outcome.ok) {
        logger.info({ ms: outcome.ms }, 'shutdown: limpio');
        process.exit(0);
      }
      logger.error({ outcome }, 'shutdown: no cerró limpio — salida forzada');
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
