import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Healthchecks (fase 10) — sin auth, sin datos sensibles:
 * - /health/live: el proceso responde. NO toca dependencias — un Redis
 *   caído no debe hacer que el orquestador mate un proceso sano.
 * - /health/ready: ping real a Postgres y Redis con timeout corto; 503
 *   con el detalle de QUÉ falló (nombre y motivo, jamás URLs/credenciales).
 * Viven bajo el global prefix (/api/health/*): una sola regla de ruteo.
 */

export const HEALTH_REDIS_PING = Symbol('HEALTH_REDIS_PING');
export type RedisPing = () => Promise<void>;

const CHECK_TIMEOUT_MS = 1500;

async function check(run: () => Promise<unknown>): Promise<string> {
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS),
      ),
    ]);
    return 'ok';
  } catch (error) {
    return error instanceof Error && error.message === 'timeout' ? 'timeout' : 'down';
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(HEALTH_REDIS_PING) private readonly redisPing: RedisPing,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const [postgres, redis] = await Promise.all([
      check(() => this.prisma.db.$queryRaw`SELECT 1`),
      check(() => this.redisPing()),
    ]);
    const healthy = postgres === 'ok' && redis === 'ok';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'error',
      checks: { postgres, redis },
    });
  }
}
