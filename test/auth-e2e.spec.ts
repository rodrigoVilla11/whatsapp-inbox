/**
 * E2E de la fase 8 con la app Nest real (middleware de sesión + guards +
 * controllers), DB fake y supertest manejando cookies. Cubre la lista del
 * brief: login (mensaje único, rate limit), 401 sin cookie, tenant cruzado
 * invisible, media por <img> con cookie, matriz de roles, usuario
 * desactivado, logout, y el webhook que NUNCA pide sesión.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';
import { SESSION_COOKIE } from '../src/auth/cookies';
import { LoginRateLimiter } from '../src/auth/login-rate-limit';
import { hashPassword } from '../src/auth/passwords';
import { RolesGuard } from '../src/auth/roles';
import { SessionAuthMiddleware } from '../src/auth/session-auth.middleware';
import { SessionsService } from '../src/auth/sessions.service';
import { UsersController } from '../src/auth/users.controller';
import { UsersService } from '../src/auth/users.service';
import { DOMAIN_EVENT_PUBLISHER } from '../src/events/domain-events';
import { GourmetifyOrdersService } from '../src/gourmetify/orders.service';
import { ConversationsService } from '../src/inbox/conversations.service';
import { InboxController } from '../src/inbox/inbox.controller';
import { QuickRepliesService } from '../src/inbox/quick-replies.service';
import { MediaAccessService } from '../src/media/media-access.service';
import { MediaController } from '../src/media/media.controller';
import { OutboundMediaService } from '../src/media/outbound-media.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { GraphApiClient } from '../src/whatsapp/graph-api.client';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT_A = 'ten_A';
const TENANT_B = 'ten_B';
const OWNER_PASSWORD = 'owner-secreta-123';
const AGENT_PASSWORD = 'agente-secreta-123';

let app: NestExpressApplication;
let db: FakeDb;
let sessions: SessionsService;

const cookieOf = (res: request.Response): string => {
  const setCookie = res.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(header).toContain(`${SESSION_COOKIE}=`);
  return header.split(';')[0];
};

async function login(email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200);
  return cookieOf(res);
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  db = createFakeDb();
  const prisma = { db } as unknown as PrismaService;

  db.tenant.seed({ id: TENANT_A, slug: 'nova', name: 'Nova Sushi' });
  db.tenant.seed({ id: TENANT_B, slug: 'otro', name: 'Otro Resto' });
  db.user.seed({
    id: 'u_owner', tenantId: TENANT_A, email: 'owner@nova.test', name: 'Dueño',
    role: 'OWNER', passwordHash: await hashPassword(OWNER_PASSWORD),
  });
  db.user.seed({
    id: 'u_agent', tenantId: TENANT_A, email: 'caja@nova.test', name: 'Cajera',
    role: 'AGENT', passwordHash: await hashPassword(AGENT_PASSWORD),
  });
  // conversación del tenant B — para el test de invisibilidad cruzada
  db.contact.seed({ id: 'ct_B', tenantId: TENANT_B, waId: '549999' });
  db.conversation.seed({
    id: 'conv_B', tenantId: TENANT_B, whatsappAccountId: 'acc_B', contactId: 'ct_B',
  });
  // mensaje con media del tenant A (para el test del <img>)
  db.contact.seed({ id: 'ct_A', tenantId: TENANT_A, waId: '549341' });
  db.conversation.seed({
    id: 'conv_A', tenantId: TENANT_A, whatsappAccountId: 'acc_A', contactId: 'ct_A',
  });
  db.message.seed({
    id: 'msg_media', tenantId: TENANT_A, conversationId: 'conv_A',
    whatsappAccountId: 'acc_A', direction: 'INBOUND', type: 'IMAGE',
    mediaStatus: 'DOWNLOADED', mediaUrl: 'ten_A/conv_A/msg_media/foto.jpg',
    mediaMimeType: 'image/jpeg', timestamp: new Date(),
  });

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController, UsersController, InboxController, MediaController],
    providers: [
      SessionsService,
      LoginRateLimiter,
      SessionAuthMiddleware,
      RolesGuard,
      UsersService,
      ConversationsService,
      QuickRepliesService,
      GourmetifyOrdersService, // InboxController lo inyecta (pedidos en el chat)
      { provide: PrismaService, useValue: prisma },
      {
        // rate limiter sobre el Redis del compose (integración real)
        provide: ConfigService,
        useValue: {
          get: (key: string) =>
            key === 'REDIS_URL'
              ? (process.env.REDIS_URL ?? 'redis://localhost:6380')
              : undefined,
        },
      },
      { provide: GraphApiClient, useValue: { markMessageRead: vi.fn() } },
      { provide: DOMAIN_EVENT_PUBLISHER, useValue: { publish: vi.fn().mockResolvedValue(undefined) } },
      {
        provide: MediaAccessService,
        useValue: {
          // firma stub: el contrato que importa acá es cookie→302 / sin cookie→401
          resolve: vi.fn(async (tenantId: string, messageId: string) => {
            const row = db.message.findFirst({ where: { id: messageId, tenantId } });
            if (!row) return { kind: 'conflict', mediaStatus: 'FAILED' };
            return { kind: 'redirect', url: 'https://r2.example/firmada?sig=abc' };
          }),
        },
      },
      { provide: OutboundMediaService, useValue: { sendMedia: vi.fn() } },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useLogger(false);
  app.setGlobalPrefix('api'); // fase 10b: mismo prefijo que producción
  // mismo wiring de middleware que los módulos reales
  const middleware = app.get(SessionAuthMiddleware);
  app.use((req: never, res: never, next: never) => {
    const path = (req as { path: string }).path;
    const noSession =
      path === '/api/auth/login' || path === '/api/auth/logout' || path.startsWith('/api/webhooks');
    if (noSession) return (next as () => void)();
    return middleware.use(req, res, next);
  });
  sessions = moduleRef.get(SessionsService);
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('POST /auth/login', () => {
  it('login OK: setea cookie httpOnly y devuelve el user sin hash', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'Owner@nova.test', password: OWNER_PASSWORD }) // case-insensitive
      .expect(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(res.body.user).toMatchObject({ email: 'owner@nova.test', role: 'OWNER' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('password mal y email inexistente → MISMO mensaje 401', async () => {
    const wrong = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'owner@nova.test', password: 'incorrecta-123' })
      .expect(401);
    // email único por corrida: los fallos ahora persisten en Redis y un
    // fantasma fijo acumularía hasta chocar con el rate limit entre corridas
    const ghost = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: `no-existe-${Date.now()}@nova.test`, password: 'incorrecta-123' })
      .expect(401);
    expect(wrong.body.message).toBe(ghost.body.message);
  });

  it('rate limit (sobre Redis): al 6º intento fallido del mismo email+IP → 429 con Retry-After', async () => {
    const email = `victima-${Date.now()}@nova.test`; // único: Redis persiste entre corridas
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email, password: 'mala-mala-1' })
        .expect(401);
    }
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'mala-mala-1' })
      .expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('sesión obligatoria en el dominio', () => {
  it('endpoint de dominio sin cookie → 401', async () => {
    await request(app.getHttpServer()).get('/api/conversations').expect(401);
  });

  it('con sesión: 200; recurso de OTRO tenant: invisible (404)', async () => {
    const cookie = await login('caja@nova.test', AGENT_PASSWORD);
    const list = await request(app.getHttpServer())
      .get('/api/conversations')
      .set('Cookie', cookie)
      .expect(200);
    const ids = (list.body.conversations as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain('conv_A');
    expect(ids).not.toContain('conv_B');

    await request(app.getHttpServer())
      .get('/api/conversations/conv_B/messages')
      .set('Cookie', cookie)
      .expect(404); // indistinguible de inexistente
  });

  it('MEDIA (la razón de la arquitectura): GET estilo <img> con cookie → 302; sin cookie → 401', async () => {
    const cookie = await login('caja@nova.test', AGENT_PASSWORD);
    const res = await request(app.getHttpServer())
      .get('/api/messages/msg_media/media')
      .set('Cookie', cookie)
      .expect(302);
    expect(res.headers.location).toContain('https://r2.example/firmada');

    await request(app.getHttpServer()).get('/api/messages/msg_media/media').expect(401);
  });

  it('usuario desactivado → su sesión muere en el PRÓXIMO request', async () => {
    db.user.seed({
      id: 'u_baja', tenantId: TENANT_A, email: 'baja@nova.test', name: 'Se Va',
      role: 'AGENT', passwordHash: await hashPassword('password-de-baja'),
    });
    const cookie = await login('baja@nova.test', 'password-de-baja');
    await request(app.getHttpServer()).get('/api/conversations').set('Cookie', cookie).expect(200);

    db.user.updateMany({ where: { id: 'u_baja' }, data: { isActive: false } });
    await request(app.getHttpServer()).get('/api/conversations').set('Cookie', cookie).expect(401);
    expect(db.session.findFirst({ where: { userId: 'u_baja' } })).toBeNull(); // limpiada
  });

  it('logout: la cookie queda inválida para requests posteriores', async () => {
    const cookie = await login('caja@nova.test', AGENT_PASSWORD);
    await request(app.getHttpServer()).get('/api/conversations').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).post('/api/auth/logout').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).get('/api/conversations').set('Cookie', cookie).expect(401);
  });

  it('sesión vencida → 401 y la fila se limpia', async () => {
    const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const { token } = await sessions.create({ id: 'u_agent', tenantId: TENANT_A }, null, past);
    await request(app.getHttpServer())
      .get('/api/conversations')
      .set('Cookie', `${SESSION_COOKIE}=${token}`)
      .expect(401);
  });
});

describe('SessionsService.inspect (el diagnóstico distingue la falla)', () => {
  it('sin token / token desconocido / vencida / usuario inactivo → razones distintas', async () => {
    expect(await sessions.inspect(undefined)).toEqual({ ok: false, reason: 'no-token' });
    expect(await sessions.inspect('token-inventado')).toEqual({
      ok: false,
      reason: 'unknown-token',
    });

    const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const expired = await sessions.create({ id: 'u_agent', tenantId: TENANT_A }, null, past);
    expect(await sessions.inspect(expired.token)).toEqual({ ok: false, reason: 'expired' });

    db.user.seed({
      id: 'u_inspect', tenantId: TENANT_A, email: 'inspect@nova.test', name: 'I',
      role: 'AGENT', isActive: false,
    });
    const inactive = await sessions.create({ id: 'u_inspect', tenantId: TENANT_A }, null);
    expect(await sessions.inspect(inactive.token)).toEqual({
      ok: false,
      reason: 'user-inactive',
    });
  });
});

describe('matriz de roles', () => {
  it('AGENT intenta crear usuario → 403 aunque llame al endpoint directo', async () => {
    const cookie = await login('caja@nova.test', AGENT_PASSWORD);
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Cookie', cookie)
      .send({ email: 'x@nova.test', name: 'X', role: 'AGENT', password: 'una-password-1' })
      .expect(403);
  });

  it('ADMIN/OWNER crea AGENTs (con mustChangePassword); solo OWNER crea ADMINs', async () => {
    const owner = await login('owner@nova.test', OWNER_PASSWORD);
    const created = await request(app.getHttpServer())
      .post('/api/users')
      .set('Cookie', owner)
      .send({ email: 'nueva@nova.test', name: 'Cajera 2', role: 'AGENT', password: 'inicial-123456' })
      .expect(201);
    expect(created.body).toMatchObject({ role: 'AGENT', mustChangePassword: true });

    const admin = await request(app.getHttpServer())
      .post('/api/users')
      .set('Cookie', owner)
      .send({ email: 'admin@nova.test', name: 'Encargado', role: 'ADMIN', password: 'inicial-123456' })
      .expect(201);
    expect(admin.body.role).toBe('ADMIN');

    // el ADMIN recién creado NO puede crear otro ADMIN
    const adminCookie = await login('admin@nova.test', 'inicial-123456');
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Cookie', adminCookie)
      .send({ email: 'admin2@nova.test', name: 'Otro', role: 'ADMIN', password: 'inicial-123456' })
      .expect(403);
  });

  it('nadie modifica al OWNER (ni un ADMIN); el rol del OWNER no se toca', async () => {
    const adminCookie = await login('admin@nova.test', 'inicial-123456');
    await request(app.getHttpServer())
      .patch('/api/users/u_owner')
      .set('Cookie', adminCookie)
      .send({ name: 'Hackeado' })
      .expect(403);

    const ownerCookie = await login('owner@nova.test', OWNER_PASSWORD);
    await request(app.getHttpServer())
      .patch('/api/users/u_owner')
      .set('Cookie', ownerCookie)
      .send({ isActive: false })
      .expect(403); // el dueño no se desactiva, ni él mismo
  });

  it('AGENT no puede asignar a otros; sí asignarse y liberar', async () => {
    const cookie = await login('caja@nova.test', AGENT_PASSWORD);
    await request(app.getHttpServer())
      .post('/api/conversations/conv_A/assign')
      .set('Cookie', cookie)
      .send({ userId: 'u_owner' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/conversations/conv_A/assign')
      .set('Cookie', cookie)
      .send({ userId: 'u_agent' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/conversations/conv_A/assign')
      .set('Cookie', cookie)
      .send({ userId: null })
      .expect(201);
  });

  it('quick replies: AGENT lee pero no crea (403); ADMIN sí', async () => {
    const agent = await login('caja@nova.test', AGENT_PASSWORD);
    await request(app.getHttpServer()).get('/api/quick-replies').set('Cookie', agent).expect(200);
    await request(app.getHttpServer())
      .post('/api/quick-replies')
      .set('Cookie', agent)
      .send({ shortcut: '/no', title: 'No', body: 'no' })
      .expect(403);

    const admin = await login('admin@nova.test', 'inicial-123456');
    await request(app.getHttpServer())
      .post('/api/quick-replies')
      .set('Cookie', admin)
      .send({ shortcut: '/si', title: 'Sí', body: 'sí' })
      .expect(201);
  });

  it('desactivar un AGENT (ADMIN puede) mata sus sesiones', async () => {
    const victimCookie = await login('nueva@nova.test', 'inicial-123456');
    await request(app.getHttpServer()).get('/api/conversations').set('Cookie', victimCookie).expect(200);

    const admin = await login('admin@nova.test', 'inicial-123456');
    const target = db.user.findFirst({ where: { email: 'nueva@nova.test' } })!;
    await request(app.getHttpServer())
      .patch(`/api/users/${target.id}`)
      .set('Cookie', admin)
      .send({ isActive: false })
      .expect(200);

    await request(app.getHttpServer()).get('/api/conversations').set('Cookie', victimCookie).expect(401);
  });
});

describe('POST /auth/change-password', () => {
  it('flujo forzado: cambia, apaga mustChangePassword y la password vieja deja de servir', async () => {
    const owner = await login('owner@nova.test', OWNER_PASSWORD);
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Cookie', owner)
      .send({ email: 'forzada@nova.test', name: 'Forzada', role: 'AGENT', password: 'inicial-999999' })
      .expect(201);

    const cookie = await login('forzada@nova.test', 'inicial-999999');
    const me = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body.user.mustChangePassword).toBe(true);

    await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'inicial-999999', newPassword: 'corta' })
      .expect(400); // política: mínimo 10

    await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'inicial-999999', newPassword: 'mi-nueva-definitiva' })
      .expect(200);

    // la sesión actual sigue viva y el flag quedó apagado
    const after = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(after.body.user.mustChangePassword).toBe(false);

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'forzada@nova.test', password: 'inicial-999999' })
      .expect(401);
    await login('forzada@nova.test', 'mi-nueva-definitiva');
  });
});
