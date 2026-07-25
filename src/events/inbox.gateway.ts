import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import IORedis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { TenantContextService } from '../tenant/tenant-context.service';
import { DOMAIN_EVENTS_CHANNEL, DomainEvent, tenantRoom } from './domain-events';

/**
 * Gateway del inbox. NO recibe emisiones directas de los servicios: se
 * suscribe UNA vez al canal de Redis y reenvía cada evento al room del
 * tenant del sobre. Con N réplicas de la API, cada una tiene su suscripción
 * y sus sockets — el pub/sub reparte a todas.
 *
 * Contrato de reconexión (fase 7): sin replay ni acks. Al reconectar, el
 * frontend refetchea el estado por REST (lista de conversaciones + hilo
 * abierto) y recién después confía en el stream.
 */
@WebSocketGateway({
  namespace: '/inbox',
  cors: { origin: true, credentials: true },
})
export class InboxGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboxGateway.name);

  @WebSocketServer()
  server!: Namespace;

  private subscriber: IORedis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6380';
    // Conexión dedicada: una conexión Redis en modo subscribe no puede
    // ejecutar otros comandos.
    this.subscriber = new IORedis(url, { maxRetriesPerRequest: null });
    this.subscriber.on('error', (error) => this.logger.warn(`Redis sub: ${error.message}`));
    await this.subscriber.subscribe(DOMAIN_EVENTS_CHANNEL);
    this.subscriber.on('message', (_channel, raw) => this.forward(raw));
    this.logger.log(`Suscripto a "${DOMAIN_EVENTS_CHANNEL}" — reenviando a rooms por tenant`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  /** Canal Redis → room del tenant del SOBRE (jamás un room global). */
  private forward(raw: string): void {
    let event: DomainEvent;
    try {
      event = JSON.parse(raw) as DomainEvent;
    } catch {
      this.logger.warn('Evento de dominio imparseable — descartado');
      return;
    }
    if (!event?.tenantId || !event?.type) return;
    this.server.to(tenantRoom(event.tenantId)).emit(event.type, event.payload);
  }

  /**
   * Auth del handshake. TODO(auth): mismo provisional que REST — cuando
   * entre auth real, acá se valida el token del handshake. El tenant sale
   * SIEMPRE de la resolución server-side, jamás de un parámetro que el
   * cliente elige; socket.io no permite joins desde el cliente y este
   * gateway no expone ningún mensaje de join.
   */
  async handleConnection(socket: Socket): Promise<void> {
    try {
      const context = await this.tenantContext.resolveDefault();
      if (!context) {
        this.logger.warn(`Conexión sin tenant resoluble: ${socket.id} — desconectado`);
        socket.disconnect(true);
        return;
      }
      await socket.join(tenantRoom(context.tenantId));
    } catch (error) {
      this.logger.error(`handleConnection: ${String(error)}`);
      socket.disconnect(true);
    }
  }
}
