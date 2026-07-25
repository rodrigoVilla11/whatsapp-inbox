import type { ConnectionOptions } from 'bullmq';

/**
 * REDIS_URL → opciones de conexión de BullMQ/ioredis.
 * Soporta redis:// y rediss:// (TLS), user/password y db por path.
 */
export function redisConnectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname !== '/' ? Number(parsed.pathname.slice(1)) : 0,
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    // Requerido por los workers de BullMQ (fase 3); inocuo para el producer.
    // Se fija acá para que no haya dos configs de conexión distintas.
    maxRetriesPerRequest: null,
  };
}
