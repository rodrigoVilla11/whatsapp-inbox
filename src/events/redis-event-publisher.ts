import { Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { DOMAIN_EVENTS_CHANNEL, DomainEvent, DomainEventPublisher } from './domain-events';

/**
 * PUBLISH al canal global de Redis. Best-effort por contrato: si Redis está
 * caído se loguea y se sigue — jamás rompe la transacción de dominio que ya
 * commiteó. La UI se recupera por el contrato de reconexión (refetch REST).
 */
export class RedisEventPublisher implements DomainEventPublisher, OnModuleDestroy {
  private readonly logger = new Logger(RedisEventPublisher.name);
  private readonly client: IORedis;

  constructor(redisUrl: string) {
    this.client = new IORedis(redisUrl, {
      // Publisher no puede bloquear al dominio reintentando para siempre.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.client.on('error', (error) => {
      this.logger.warn(`Redis publisher: ${error.message}`);
    });
  }

  async publish(event: Omit<DomainEvent, 'occurredAt'>): Promise<void> {
    const envelope: DomainEvent = { ...event, occurredAt: new Date().toISOString() };
    try {
      await this.client.publish(DOMAIN_EVENTS_CHANNEL, JSON.stringify(envelope));
    } catch (error) {
      this.logger.error(
        `publish(${event.type}) falló — evento perdido (la UI se recupera por REST): ${String(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
