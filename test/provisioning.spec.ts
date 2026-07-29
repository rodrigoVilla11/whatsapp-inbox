/**
 * Provisioning Gourmetify → inbox (puente pre-Embedded-Signup):
 * guard por secreto compartido, alta idempotente de tenant + OWNER, y
 * conexión de WhatsApp con validación en vivo (mockeada) y cifrado real.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '../src/auth/passwords';
import { Encryption } from '../src/crypto/encryption';
import { EncryptionService } from '../src/crypto/encryption.service';
import { GRAPH_CREDENTIALS_CHECK } from '../src/provisioning/graph-credentials';
import { ProvisioningAuthMiddleware } from '../src/provisioning/provisioning-auth.middleware';
import { ProvisioningController } from '../src/provisioning/provisioning.controller';
import { ProvisioningService } from '../src/provisioning/provisioning.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createFakeDb, type FakeDb } from './support/fake-db';

const SECRET = 'clave-provisioning-de-test';
const encryption = new Encryption({ keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 });

let app: NestExpressApplication;
let db: FakeDb;
let graphCheck: ReturnType<typeof vi.fn>;

const post = (path: string, body: unknown, key: string | null = SECRET) => {
  let req = request(app.getHttpServer()).post(path);
  if (key !== null) req = req.set('x-provisioning-key', key);
  return req.send(body as object);
};

beforeAll(async () => {
  Logger.overrideLogger(false);
  process.env.PROVISIONING_SECRET = SECRET;
  db = createFakeDb();
  graphCheck = vi
    .fn()
    .mockResolvedValue({ ok: true, displayPhoneNumber: '+54 9 341 555-0000', verifiedName: 'Test' });

  const moduleRef = await Test.createTestingModule({
    controllers: [ProvisioningController],
    providers: [
      ProvisioningService,
      { provide: PrismaService, useValue: { db } as unknown as PrismaService },
      { provide: EncryptionService, useValue: encryption },
      { provide: GRAPH_CREDENTIALS_CHECK, useValue: (...args: unknown[]) => graphCheck(...args) },
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useLogger(false);
  const middleware = new ProvisioningAuthMiddleware();
  app.use((req: never, res: never, next: never) => middleware.use(req, res, next));
  await app.init();
});

afterAll(async () => {
  await app.close();
  delete process.env.PROVISIONING_SECRET;
});

afterEach(() => {
  graphCheck.mockClear();
  graphCheck.mockResolvedValue({ ok: true, displayPhoneNumber: '+54 9 341 555-0000', verifiedName: 'Test' });
});

describe('guard del provisioning', () => {
  it('sin header → 401; clave incorrecta → 401', async () => {
    await post('/provisioning/tenants', {}, null).expect(401);
    await post('/provisioning/tenants', {}, 'clave-equivocada').expect(401);
  });

  it('sin PROVISIONING_SECRET en el entorno → 503 (deshabilitado, nunca abierto)', async () => {
    const saved = process.env.PROVISIONING_SECRET;
    delete process.env.PROVISIONING_SECRET;
    await post('/provisioning/tenants', {}, 'lo-que-sea').expect(503);
    process.env.PROVISIONING_SECRET = saved;
  });
});

describe('POST /provisioning/tenants', () => {
  it('crea tenant + OWNER con password generada (hasheada, mustChangePassword)', async () => {
    const res = await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_100',
      name: 'La Parrilla de Ana',
      timezone: 'Europe/Madrid',
      owner: { email: 'Ana@parrilla.es', name: 'Ana' },
    }).expect(201);

    expect(res.body.created).toBe(true);
    expect(res.body.tenant).toMatchObject({
      slug: 'la-parrilla-de-ana',
      timezone: 'Europe/Madrid',
      gourmetifyTenantId: 'gfy_100',
    });
    expect(res.body.owner.email).toBe('ana@parrilla.es');
    expect(res.body.owner.initialPassword).toHaveLength(12);

    const user = db.user.findFirst({ where: { email: 'ana@parrilla.es' } })!;
    expect(user.mustChangePassword).toBe(true);
    expect(String(user.passwordHash)).toMatch(/^\$argon2/);
    const verdict = await verifyPassword(
      user.passwordHash as string,
      res.body.owner.initialPassword,
    );
    expect(verdict.ok).toBe(true); // la password devuelta ES la hasheada
  });

  it('idempotente: mismo gourmetifyTenantId → mismo tenant, sin password nueva', async () => {
    const again = await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_100',
      name: 'La Parrilla de Ana (renombrada)',
    }).expect(201);
    expect(again.body.created).toBe(false);
    expect(again.body.tenant.slug).toBe('la-parrilla-de-ana'); // el slug no cambia
    expect(again.body.owner).not.toHaveProperty('initialPassword');
    expect(db.tenant.findMany({ where: { gourmetifyTenantId: 'gfy_100' } })).toHaveLength(1);
  });

  it('nombres que chocan generan slugs distintos', async () => {
    await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_101',
      name: 'La Parrilla de Ana',
      owner: { email: 'otra@parrilla.es', name: 'Otra' },
    }).expect(201);
    const slugs = db.tenant.findMany({}).map((t) => t.slug);
    expect(slugs).toContain('la-parrilla-de-ana');
    expect(slugs).toContain('la-parrilla-de-ana-2');
  });

  it('password provista corta → 400 con la política', async () => {
    await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_102',
      name: 'Otro Resto',
      owner: { email: 'x@y.es', name: 'X', password: 'corta' },
    }).expect(400);
  });
});

describe('adopción de un tenant existente (adoptSlug)', () => {
  it('GET /provisioning/tenants muestra el estado (vinculado, número, si tiene datos)', async () => {
    const res = await request(app.getHttpServer())
      .get('/provisioning/tenants')
      .set('x-provisioning-key', SECRET)
      .expect(200);
    const slugs = (res.body as Array<{ slug: string }>).map((t) => t.slug);
    expect(slugs).toContain('la-parrilla-de-ana');
    const one = (res.body as Array<{ slug: string; linkedToGourmetify: boolean }>).find(
      (t) => t.slug === 'la-parrilla-de-ana',
    )!;
    expect(one.linkedToGourmetify).toBe(true);
  });

  it('EL CASO REAL: el número ya está en el tenant del seed → adoptar lo destraba', async () => {
    // Tenant "viejo" (seed) con su número y su historial, SIN vincular.
    db.tenant.seed({ id: 'ten_seed', slug: 'nova-sushi', name: 'Nova Sushi' });
    db.metaApp.seed({
      id: 'app_seed', ref: 'default', name: 'App', appId: 'APP_SEED',
      appSecretEnc: encryption.encrypt('secreto-seed'),
      verifyTokenEnc: encryption.encrypt('verify-del-seed'),
      keyVersion: 1,
    });
    db.whatsappAccount.seed({
      id: 'acc_seed', tenantId: 'ten_seed', metaAppId: 'app_seed',
      phoneNumberId: 'PN_SEED', wabaId: 'WABA', displayPhoneNumber: '+1555', accessTokenEnc: 'z',
    });
    db.conversation.seed({ id: 'conv_hist', tenantId: 'ten_seed', whatsappAccountId: 'acc_seed', contactId: 'ct' });

    const CREDS = {
      metaAppId: 'APP_SEED', metaAppSecret: 's', phoneNumberId: 'PN_SEED',
      wabaId: 'WABA', accessToken: 't',
    };

    // 1. Gourmetify crea su tenant nuevo y conectar rebota (el síntoma).
    await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_real',
      name: 'Nova Sushi',
      owner: { email: 'dueno@nova.test', name: 'Dueño' },
    }).expect(201);
    await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_real/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send(CREDS)
      .expect(409);

    // 2. Adoptar el tenant del seed: el tenant nuevo estaba VACÍO → se libera.
    const adopted = await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_real',
      name: 'Nova Sushi',
      adoptSlug: 'nova-sushi',
    }).expect(201);
    expect(adopted.body).toMatchObject({ adopted: true, created: false });
    expect(adopted.body.tenant.slug).toBe('nova-sushi');

    // 3. Ahora la misma conexión funciona (mismo tenant) y el historial sigue.
    const connected = await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_real/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send(CREDS)
      .expect(200);
    expect(connected.body.connected).toBe(true);
    expect(db.conversation.findFirst({ where: { id: 'conv_hist' } })).toBeTruthy();
    expect(db.tenant.findFirst({ where: { slug: 'nova-sushi' } })!.gourmetifyTenantId).toBe('gfy_real');
    // La MetaApp del seed se REUSA: mismo ref → la Callback URL configurada
    // en Meta sigue sirviendo, y el verify token no se regeneró.
    expect(connected.body.webhook.path).toBe('/webhooks/whatsapp/default');
    expect(db.metaApp.findMany({ where: { appId: 'APP_SEED' } })).toHaveLength(1);
  });

  it('reusar la MetaApp conserva el verify token (no hay que re-verificar en Meta)', async () => {
    db.tenant.seed({ id: 'ten_vt', slug: 'vt-resto', name: 'VT', gourmetifyTenantId: 'gfy_vt' });
    db.metaApp.seed({
      id: 'app_vt', ref: 'default-vt', name: 'App VT', appId: 'APP_VT',
      appSecretEnc: encryption.encrypt('viejo'),
      verifyTokenEnc: encryption.encrypt('token-ya-configurado-en-meta'), keyVersion: 1,
    });

    const res = await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_vt/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send({
        metaAppId: 'APP_VT', metaAppSecret: 'nuevo-secreto',
        phoneNumberId: 'PN_VT', wabaId: 'W', accessToken: 't',
      })
      .expect(200);

    expect(res.body.webhook.verifyToken).toBe('token-ya-configurado-en-meta');
    // el secret SÍ se actualizó
    expect(encryption.decrypt(db.metaApp.findFirst({ where: { id: 'app_vt' } })!.appSecretEnc as string)).toBe(
      'nuevo-secreto',
    );
  });

  it('si el tenant vinculado YA tiene datos, no se pisa nada → 409 accionable', async () => {
    db.tenant.seed({ id: 'ten_otro', slug: 'otro-resto', name: 'Otro' });
    db.tenant.seed({ id: 'ten_ocupado', slug: 'ocupado', name: 'Ocupado', gourmetifyTenantId: 'gfy_ocupado' });
    db.conversation.seed({ id: 'c_x', tenantId: 'ten_ocupado', whatsappAccountId: 'a', contactId: 'c' });

    const res = await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_ocupado',
      name: 'X',
      adoptSlug: 'otro-resto',
    }).expect(409);
    expect(res.body.message).toMatch(/tiene datos propios/);
  });

  it('slug inexistente → 404; tenant de otro cliente → 409', async () => {
    await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_x', name: 'X', adoptSlug: 'no-existe',
    }).expect(404);

    db.tenant.seed({ id: 'ten_ajeno', slug: 'ajeno', name: 'Ajeno', gourmetifyTenantId: 'gfy_dueno' });
    await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_intruso', name: 'X', adoptSlug: 'ajeno',
    }).expect(409);
  });
});

describe('PUT /provisioning/tenants/:id/whatsapp', () => {
  const CREDS = {
    metaAppId: '111222333',
    metaAppSecret: 'secreto-de-app',
    phoneNumberId: 'PN_GFY_1',
    wabaId: 'WABA_GFY_1',
    accessToken: 'token-del-cliente',
  };

  it('valida contra Meta ANTES de guardar; credenciales malas → 400 con el motivo de Meta', async () => {
    graphCheck.mockResolvedValueOnce({ ok: false, reason: 'Invalid OAuth access token' });
    const bad = await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_100/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send(CREDS)
      .expect(400);
    expect(bad.body.message).toMatch(/Invalid OAuth access token/);
    expect(db.whatsappAccount.findFirst({ where: { phoneNumberId: 'PN_GFY_1' } })).toBeNull();
  });

  it('conecta: MetaApp + cuenta cifradas, devuelve webhook path + verify token y NINGÚN secreto', async () => {
    const res = await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_100/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send(CREDS)
      .expect(200);

    expect(graphCheck).toHaveBeenCalledWith('PN_GFY_1', 'token-del-cliente');
    expect(res.body.connected).toBe(true);
    expect(res.body.account).toMatchObject({
      phoneNumberId: 'PN_GFY_1',
      displayPhoneNumber: '+54 9 341 555-0000', // vino del check de Meta
      status: 'ACTIVE',
    });
    expect(res.body.webhook.path).toBe('/webhooks/whatsapp/gfy-gfy_100');
    expect(res.body.webhook.verifyToken).toBeTruthy();

    // los secretos JAMÁS viajan de vuelta
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('secreto-de-app');
    expect(raw).not.toContain('token-del-cliente');

    // y en la base están CIFRADOS (roundtrip real)
    const account = db.whatsappAccount.findFirst({ where: { phoneNumberId: 'PN_GFY_1' } })!;
    expect(account.accessTokenEnc).not.toContain('token-del-cliente');
    expect(encryption.decrypt(account.accessTokenEnc as string)).toBe('token-del-cliente');
  });

  it('re-conectar el mismo tenant actualiza el token (idempotente)', async () => {
    await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_100/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send({ ...CREDS, accessToken: 'token-rotado' })
      .expect(200);
    const account = db.whatsappAccount.findFirst({ where: { phoneNumberId: 'PN_GFY_1' } })!;
    expect(encryption.decrypt(account.accessTokenEnc as string)).toBe('token-rotado');
    expect(db.whatsappAccount.findMany({ where: { phoneNumberId: 'PN_GFY_1' } })).toHaveLength(1);
  });

  it('un número ya conectado a OTRO tenant → 409', async () => {
    await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_101/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send({ ...CREDS, metaAppId: '999888777' })
      .expect(409);
  });

  it('dos restaurantes COMPARTEN la misma App de Meta con números distintos (Tech Provider)', async () => {
    const shared = { metaAppId: 'APP_COMPARTIDA', metaAppSecret: 's', wabaId: 'W', accessToken: 't' };
    for (const [id, phone] of [
      ['gfy_share_a', 'PN_SHARE_A'],
      ['gfy_share_b', 'PN_SHARE_B'],
    ]) {
      await post('/provisioning/tenants', {
        gourmetifyTenantId: id,
        name: `Resto ${id}`,
        owner: { email: `${id}@x.com`, name: 'X' },
      }).expect(201);
      await request(app.getHttpServer())
        .put(`/provisioning/tenants/${id}/whatsapp`)
        .set('x-provisioning-key', SECRET)
        .send({ ...shared, phoneNumberId: phone })
        .expect(200);
    }
    // UNA sola MetaApp para los dos: el tenant lo resuelve el phone_number_id
    expect(db.metaApp.findMany({ where: { appId: 'APP_COMPARTIDA' } })).toHaveLength(1);
  });

  it('número nuevo en el MISMO tenant desconecta el anterior (prueba → real)', async () => {
    const creds = { metaAppId: 'APP_SWAP', metaAppSecret: 's', wabaId: 'W', accessToken: 't' };
    await post('/provisioning/tenants', {
      gourmetifyTenantId: 'gfy_swap',
      name: 'Swap',
      owner: { email: 'swap@x.com', name: 'S' },
    }).expect(201);

    await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_swap/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send({ ...creds, phoneNumberId: 'PN_PRUEBA' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_swap/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send({ ...creds, phoneNumberId: 'PN_REAL' })
      .expect(200);

    expect(res.body.replacedNumbers).toBe(1);
    expect(res.body.account.phoneNumberId).toBe('PN_REAL');
    expect(db.whatsappAccount.findFirst({ where: { phoneNumberId: 'PN_PRUEBA' } })!.status).toBe(
      'DISCONNECTED',
    );

    // el estado devuelve el VIGENTE, no el viejo
    const status = await request(app.getHttpServer())
      .get('/provisioning/tenants/gfy_swap/whatsapp')
      .set('x-provisioning-key', SECRET)
      .expect(200);
    expect(status.body.account.phoneNumberId).toBe('PN_REAL');
  });

  it('tenant inexistente → 404', async () => {
    await request(app.getHttpServer())
      .put('/provisioning/tenants/gfy_nope/whatsapp')
      .set('x-provisioning-key', SECRET)
      .send(CREDS)
      .expect(404);
  });

  it('GET devuelve el estado con verify token pero sin secretos', async () => {
    const res = await request(app.getHttpServer())
      .get('/provisioning/tenants/gfy_100/whatsapp')
      .set('x-provisioning-key', SECRET)
      .expect(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.webhook.verifyToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('token-rotado');
  });
});
