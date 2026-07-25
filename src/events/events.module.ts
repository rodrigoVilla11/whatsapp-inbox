import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DOMAIN_EVENT_PUBLISHER } from './domain-events';
import { InboxGateway } from './inbox.gateway';
import { RedisEventPublisher } from './redis-event-publisher';

/**
 * Global: todo servicio de dominio puede inyectar DOMAIN_EVENT_PUBLISHER
 * sin importar módulos. El gateway vive acá también — es el único
 * consumidor del canal.
 */
@Global()
@Module({
  providers: [
    {
      provide: DOMAIN_EVENT_PUBLISHER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new RedisEventPublisher(config.get<string>('REDIS_URL') ?? 'redis://localhost:6380'),
    },
    InboxGateway,
  ],
  exports: [DOMAIN_EVENT_PUBLISHER],
})
export class EventsModule {}
