/**
 * Rate limit de login sobre REDIS REAL (el del compose, :6380) — fase 10.
 * Misma semántica que el viejo de memoria: 5 fallos por email+IP en 15
 * minutos, con la ventana simulada vía el parámetro `now` (los timestamps
 * viejos se podan del sorted set).
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../src/auth/login-rate-limit';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const IP = '203.0.113.7';
const WINDOW_MS = 15 * 60 * 1000;

// email único por corrida: Redis persiste entre corridas de la suite
const email = (tag: string): string => `${tag}-${Date.now()}@rl.test`;

let limiter: LoginRateLimiter;

beforeAll(() => {
  Logger.overrideLogger(false);
  limiter = new LoginRateLimiter({
    get: (key: string) => (key === 'REDIS_URL' ? REDIS_URL : undefined),
  } as unknown as ConfigService);
});

afterAll(async () => {
  await limiter.onModuleDestroy();
});

describe('LoginRateLimiter (Redis real)', () => {
  it('4 fallos → puede intentar; el 5º bloquea con Retry-After acotado a la ventana', async () => {
    const mail = email('cinco');
    const now = Date.now();
    for (let i = 0; i < 4; i++) await limiter.recordFailure(mail, IP, now + i);
    expect(await limiter.retryAfterMs(mail, IP, now + 10)).toBeNull();

    await limiter.recordFailure(mail, IP, now + 4);
    const wait = await limiter.retryAfterMs(mail, IP, now + 10);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThan(0);
    expect(wait!).toBeLessThanOrEqual(WINDOW_MS);
  });

  it('los fallos fuera de la ventana de 15 min se descartan (se libera solo)', async () => {
    const mail = email('ventana');
    const past = Date.now() - WINDOW_MS - 60_000; // hace 16 minutos
    for (let i = 0; i < 5; i++) await limiter.recordFailure(mail, IP, past + i);
    expect(await limiter.retryAfterMs(mail, IP, Date.now())).toBeNull();
  });

  it('un login exitoso resetea el contador', async () => {
    const mail = email('reset');
    const now = Date.now();
    for (let i = 0; i < 5; i++) await limiter.recordFailure(mail, IP, now + i);
    expect(await limiter.retryAfterMs(mail, IP, now + 10)).not.toBeNull();

    await limiter.reset(mail, IP);
    expect(await limiter.retryAfterMs(mail, IP, now + 20)).toBeNull();
  });

  it('la clave distingue IP: otra IP con el mismo email no está bloqueada', async () => {
    const mail = email('por-ip');
    const now = Date.now();
    for (let i = 0; i < 5; i++) await limiter.recordFailure(mail, IP, now + i);
    expect(await limiter.retryAfterMs(mail, IP, now + 10)).not.toBeNull();
    expect(await limiter.retryAfterMs(mail, '198.51.100.9', now + 10)).toBeNull();
  });
});
