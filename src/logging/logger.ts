import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import type { TenantContext } from '../tenant/tenant-context';

/**
 * Logs estructurados (fase 10): pino — JSON por línea en producción,
 * pretty en dev. Todo el logging de dominio existente (Logger de Nest)
 * fluye por acá vía app.useLogger(new PinoNestLogger(root)).
 *
 * Qué NUNCA se loguea: cookies, tokens, bodies, querystrings (una búsqueda
 * puede llevar un teléfono). Sí: método, path, status, duración y el
 * userId/tenantId de la sesión si la hay.
 */
export function createRootLogger(): pino.Logger {
  const production = process.env.NODE_ENV === 'production';
  return pino({
    level: process.env.LOG_LEVEL ?? (production ? 'info' : 'debug'),
    base: undefined, // sin pid/hostname: el orquestador ya etiqueta
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(production
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'ctx' },
          },
        }),
  });
}

/** Puente Logger de Nest → pino (el último parámetro de Nest es el contexto). */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: pino.Logger) {}

  private emit(level: 'info' | 'warn' | 'error' | 'debug' | 'trace', args: unknown[]): void {
    const context = typeof args[args.length - 1] === 'string' && args.length > 1
      ? (args.pop() as string)
      : undefined;
    const [message, ...rest] = args;
    this.logger[level](
      { ctx: context, ...(rest.length ? { extra: rest.map(String) } : {}) },
      typeof message === 'string' ? message : JSON.stringify(message),
    );
  }

  log(...args: unknown[]): void {
    this.emit('info', args);
  }
  error(...args: unknown[]): void {
    this.emit('error', args);
  }
  warn(...args: unknown[]): void {
    this.emit('warn', args);
  }
  debug(...args: unknown[]): void {
    this.emit('debug', args);
  }
  verbose(...args: unknown[]): void {
    this.emit('trace', args);
  }
}

/** Request logging propio (sin pino-http): chico y sin nada sensible. */
export function requestLogger(logger: pino.Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path.includes('/health/')) return next(); // ruido de orquestador
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      // el contexto lo dejó el SessionAuthMiddleware si hubo sesión
      const context = (req as Request & { tenantContext?: TenantContext }).tenantContext;
      const line = {
        method: req.method,
        path: req.path, // path SIN querystring a propósito
        status: res.statusCode,
        durMs: Math.round(durationMs * 10) / 10,
        ...(context ? { userId: context.userId, tenantId: context.tenantId } : {}),
      };
      if (res.statusCode >= 500) logger.error(line, 'http');
      else logger.info(line, 'http');
    });
    next();
  };
}
