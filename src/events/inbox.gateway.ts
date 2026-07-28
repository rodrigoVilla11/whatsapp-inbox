import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import IORedis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { parseCookies, SESSION_COOKIE } from '../auth/cookies';
import { SessionsService } from '../auth/sessions.service';
import { corsOrigins } from '../http/cors';
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
  // El handshake de socket.io vive bajo /inbox/api: el upgrade NO pasa por
  // el shim de Express (socket.io intercepta a nivel del server HTTP), así
  // que el path del server debe ser EXACTAMENTE el que manda el browser a
  // través del proxy — sin depender de rewrites de Easypanel.
  path: '/inbox/api/socket.io',
  // corsOrigins() lee env al evaluar el decorador — main.ts importa
  // dotenv/config antes que AppModule para que ya esté cargado.
  cors: { origin: corsOrigins(), credentials: true },
})
export class InboxGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboxGateway.name);

  @WebSocketServer()
  server!: Namespace;

  private subscriber: IORedis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionsService,
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
    // Shutdown (paso 2 de http/shutdown.ts): echar a los clientes AVISANDO
    // (disparan su reconexión y refetch REST al volver) y cerrar el sub.
    try {
      this.server?.disconnectSockets?.(true);
    } catch {
      // el server puede no existir en tests unitarios — nada que cerrar
    }
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
   * Auth del handshake (fase 8): la MISMA cookie de sesión que REST — llega
   * en los headers del upgrade. Sin sesión válida → desconexión antes de
   * unirse a ningún room. El room sale SIEMPRE del tenant de la sesión,
   * jamás de un parámetro que el cliente elige; socket.io no permite joins
   * desde el cliente y este gateway no expone ningún mensaje de join.
   */
  async handleConnection(socket: Socket): Promise<void> {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      const token = parseCookies(cookieHeader)[SESSION_COOKIE];
      const result = await this.sessions.inspect(token);
      if (!result.ok) {
        // DIAGNÓSTICO temporal (fase 8): distinguir QUÉ falló, no adivinar.
        // - 'no-token' y el header ni siquiera llegó → el cliente no manda
        //   cookies (withCredentials del cliente socket.io, o un proxy que
        //   se come el header Cookie en el upgrade).
        // - 'no-token' con header presente → llega Cookie pero no la nuestra
        //   (nombre/dominio/SameSite).
        // - 'unknown-token' / 'expired' / 'user-inactive' → la cookie llega
        //   bien y es la sesión la que no sirve.
        const detail =
          result.reason === 'no-token'
            ? cookieHeader
              ? `cookie header presente pero SIN "${SESSION_COOKIE}" (nombres: ${Object.keys(parseCookies(cookieHeader)).join(', ') || 'ninguno'})`
              : 'header Cookie AUSENTE en el upgrade (¿withCredentials del cliente? ¿proxy?)'
            : `cookie presente, sesión rechazada: ${result.reason}`;
        this.logger.warn(`Handshake rechazado [${socket.id}]: ${detail}`);
        socket.disconnect(true);
        return;
      }
      await socket.join(tenantRoom(result.session.tenantId));
    } catch (error) {
      this.logger.error(`handleConnection: ${String(error)}`);
      socket.disconnect(true);
    }
  }
}
