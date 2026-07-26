/**
 * Fase 10a: healthchecks, validación de entorno y drain del shutdown.
 * (El rate limit sobre Redis real tiene su propio spec.)
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { envProblems, validateEnv } from '../src/config/env-validation';
import { HEALTH_REDIS_PING, HealthController } from '../src/health/health.controller';
import { closeWithTimeout } from '../src/http/shutdown';
import { PrismaService } from '../src/prisma/prisma.service';

beforeAll(() => Logger.overrideLogger(false));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Healthchecks ──────────────────────────────────────────────────────────

describe('GET /health', () => {
  let app: NestExpressApplication;

  async function buildApp(options: { postgresOk: boolean; redisOk: boolean }): Promise<void> {
    const db = {
      $queryRaw: options.postgresOk
        ? vi.fn().mockResolvedValue([{ '?column?': 1 }])
        : vi.fn().mockRejectedValue(new Error('conexión rechazada')),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { db } as unknown as PrismaService },
        {
          provide: HEALTH_REDIS_PING,
          useValue: options.redisOk
            ? vi.fn().mockResolvedValue(undefined)
            : vi.fn().mockRejectedValue(new Error('redis caído')),
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useLogger(false);
    await app.init();
  }

  afterEach(async () => {
    await app?.close();
  });

  it('live: siempre 200 sin tocar dependencias', async () => {
    await buildApp({ postgresOk: false, redisOk: false }); // deps rotas a propósito
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('ready con dependencias vivas → 200 con ambos checks ok', async () => {
    await buildApp({ postgresOk: true, redisOk: true });
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('ready con Redis caído → 503 identificando QUÉ falló (sin datos sensibles)', async () => {
    await buildApp({ postgresOk: true, redisOk: false });
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks).toEqual({ postgres: 'ok', redis: 'down' });
    expect(JSON.stringify(res.body)).not.toMatch(/redis:\/\/|postgres(ql)?:\/\//);
  });

  it('ready con Postgres caído → 503 señalando a postgres', async () => {
    await buildApp({ postgresOk: false, redisOk: true });
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body.checks).toEqual({ postgres: 'down', redis: 'ok' });
  });
});

// ── Validación de entorno ─────────────────────────────────────────────────

describe('validación de env al boot', () => {
  const PROD_OK = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://x',
    REDIS_URL: 'redis://x',
    ENCRYPTION_KEY: 'k',
    R2_ENDPOINT: 'e',
    R2_ACCESS_KEY_ID: 'a',
    R2_SECRET_ACCESS_KEY: 's',
    R2_BUCKET: 'b',
  };

  it('producción completa → arranca', () => {
    expect(envProblems(PROD_OK)).toEqual([]);
    expect(() => validateEnv(PROD_OK)).not.toThrow();
  });

  it('falta una crítica en producción → NO arranca y la NOMBRA', () => {
    const { REDIS_URL: _omitted, ...sinRedis } = PROD_OK;
    expect(() => validateEnv(sinRedis)).toThrow(/REDIS_URL/);

    const { ENCRYPTION_KEY: _k, ...sinKey } = PROD_OK;
    expect(() => validateEnv(sinKey)).toThrow(/ENCRYPTION_KEY/);
  });

  it('dev mínimo (DATABASE_URL + key) → arranca; R2 y REDIS_URL son opcionales', () => {
    expect(
      envProblems({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://x', ENCRYPTION_KEY: 'k' }),
    ).toEqual([]);
  });

  it('grupo R2 incompleto → error nombrando las faltantes (aunque sea dev)', () => {
    const problems = envProblems({
      DATABASE_URL: 'postgresql://x',
      ENCRYPTION_KEY: 'k',
      R2_ENDPOINT: 'e',
    });
    expect(problems.join(' ')).toMatch(/R2 incompleto/);
    expect(problems.join(' ')).toMatch(/R2_BUCKET/);
  });
});

// ── Graceful shutdown: el drain espera al job en curso ────────────────────

describe('closeWithTimeout (drain de workers)', () => {
  it('un job en curso que termina ANTES del timeout se espera COMPLETO', async () => {
    let jobFinished = false;
    const close = async (): Promise<void> => {
      await sleep(150); // fake job lento en curso
      jobFinished = true;
    };
    const outcome = await closeWithTimeout(close, 5_000);
    expect(jobFinished).toBe(true); // no lo mató a mitad de camino
    expect(outcome).toMatchObject({ ok: true, timedOut: false });
    expect(outcome.ms).toBeGreaterThanOrEqual(140);
  });

  it('un close colgado más allá del timeout → timedOut (el watchdog decide)', async () => {
    const never = (): Promise<void> => new Promise(() => undefined);
    const outcome = await closeWithTimeout(never, 200);
    expect(outcome).toMatchObject({ ok: false, timedOut: true });
  });
});
