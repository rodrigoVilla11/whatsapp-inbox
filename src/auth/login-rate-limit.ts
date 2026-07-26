import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

/**
 * Rate limit de login sobre REDIS (fase 10): 5 intentos fallidos por
 * email+IP en 15 minutos. En Redis porque el contador debe sobrevivir un
 * deploy y compartirse entre réplicas — el de memoria moría con cada
 * restart.
 *
 * Implementación: sorted set por clave con timestamp como score; se podan
 * los viejos y se cuenta la ventana. Miembros únicos (ts+nonce) para que
 * dos fallos en el mismo ms no colisionen.
 *
 * Si Redis está caído: FAIL-OPEN con warning — un Redis caído no puede
 * dejar al restaurante sin login; la protección vuelve sola con Redis.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

@Injectable()
export class LoginRateLimiter implements OnModuleDestroy {
  private readonly logger = new Logger(LoginRateLimiter.name);
  private client: IORedis | null = null;

  constructor(private readonly config: ConfigService) {}

  private redis(): IORedis {
    if (!this.client) {
      const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6380';
      // offline queue ON: los comandos esperan el connect inicial (si no,
      // los primeros logins post-boot caerían al fail-open). Con Redis
      // caído, maxRetriesPerRequest:1 los falla rápido igual.
      this.client = new IORedis(url, { maxRetriesPerRequest: 1 });
      this.client.on('error', (error) =>
        this.logger.warn(`Redis rate-limit: ${error.message} (fail-open)`),
      );
    }
    return this.client;
  }

  private key(email: string, ip: string): string {
    return `login:rl:${email.trim().toLowerCase()}|${ip}`;
  }

  /** null = puede intentar; número = ms hasta poder reintentar (429). */
  async retryAfterMs(email: string, ip: string, now: number = Date.now()): Promise<number | null> {
    try {
      const key = this.key(email, ip);
      const redis = this.redis();
      await redis.zremrangebyscore(key, 0, now - WINDOW_MS);
      const count = await redis.zcard(key);
      if (count < MAX_FAILURES) return null;
      // score del 5º más reciente: cuando ESE salga de la ventana, se libera
      const anchor = await redis.zrange(key, -MAX_FAILURES, -MAX_FAILURES, 'WITHSCORES');
      const anchorTs = Number(anchor[1] ?? now);
      return Math.max(0, WINDOW_MS - (now - anchorTs));
    } catch {
      return null; // fail-open (ya avisado por el listener de error)
    }
  }

  async recordFailure(email: string, ip: string, now: number = Date.now()): Promise<void> {
    try {
      const key = this.key(email, ip);
      const redis = this.redis();
      await redis
        .multi()
        .zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 10)}`)
        .zremrangebyscore(key, 0, now - WINDOW_MS)
        .pexpire(key, WINDOW_MS)
        .exec();
    } catch {
      // fail-open
    }
  }

  async reset(email: string, ip: string): Promise<void> {
    try {
      await this.redis().del(this.key(email, ip));
    } catch {
      // fail-open
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => this.client?.disconnect());
  }
}
