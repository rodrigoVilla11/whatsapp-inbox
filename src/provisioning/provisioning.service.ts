import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { MetaApp, Tenant, User, WhatsappAccount } from '@prisma/client';
import { hashPassword, passwordPolicyError } from '../auth/passwords';
import { EncryptionService } from '../crypto/encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  GRAPH_CREDENTIALS_CHECK,
  GraphCredentialsCheck,
} from './graph-credentials';

/**
 * Provisioning desde Gourmetify (puente pre-Embedded-Signup):
 * - Alta idempotente de tenant + su OWNER, por gourmetifyTenantId.
 * - Conexión de WhatsApp con credenciales PROPIAS del cliente (su Meta App
 *   + su número): se validan EN VIVO contra Graph antes de persistir, se
 *   cifran con la infraestructura existente, y se devuelve la Callback URL
 *   + verify token listos para pegar en el panel de Meta.
 * Los secretos (app secret, access token) JAMÁS vuelven en una respuesta.
 */

export interface TenantProvisionInput {
  gourmetifyTenantId?: unknown;
  name?: unknown;
  timezone?: unknown;
  owner?: { email?: unknown; name?: unknown; password?: unknown };
  /**
   * Vincula un tenant que YA existe (por slug) en vez de crear uno nuevo:
   * el caso del restaurante que usaba el inbox antes de conectarse a
   * Gourmetify (o del tenant del seed). Conserva conversaciones, contactos
   * y usuarios — y evita el 409 de "ese número ya está conectado a otro
   * restaurante" al reconectar las mismas credenciales de Meta.
   */
  adoptSlug?: unknown;
}

export interface WhatsappConnectInput {
  metaAppId?: unknown;
  metaAppSecret?: unknown;
  phoneNumberId?: unknown;
  wabaId?: unknown;
  displayPhone?: unknown;
  accessToken?: unknown;
  verifyToken?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`Falta ${field}`);
  }
  return value.trim();
}

/**
 * Credenciales de Meta: ningún id/secret/token válido lleva espacios, y el
 * copy-paste de un token largo desde el panel de Meta mete saltos de línea
 * con facilidad. Se limpian TODOS los blancos antes de validar.
 */
function requireCredential(value: unknown, field: string): string {
  return requireString(value, field).replace(/\s+/g, '');
}

/** Traduce los errores típicos de Meta a algo accionable para el cliente. */
function hintForMetaError(reason: string): string {
  if (/could not be decrypted|malformed|invalid oauth access token/i.test(reason)) {
    return ' — revisá que el token esté COMPLETO (los de System User son muy largos y se cortan al copiar) y que sea de la misma app del App ID';
  }
  if (/expired|session has expired/i.test(reason)) {
    return ' — ese token venció: generá uno de System User con expiración "Nunca"';
  }
  if (/unsupported get request|does not exist|cannot be loaded/i.test(reason)) {
    return ' — revisá el Phone Number ID (es el ID de la API, no el número de teléfono) y que el token tenga acceso a esa cuenta';
  }
  if (/permission|scope/i.test(reason)) {
    return ' — al token le faltan permisos: whatsapp_business_messaging y whatsapp_business_management';
  }
  return '';
}

function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // sin acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tenant'
  );
}

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    @Inject(GRAPH_CREDENTIALS_CHECK) private readonly checkCredentials: GraphCredentialsCheck,
  ) {}

  /** Estado de los tenants — diagnóstico para el operador (sin secretos). */
  async listTenants(): Promise<unknown[]> {
    const db = this.prisma.db;
    const tenants = (await db.tenant.findMany({ orderBy: [{ createdAt: 'asc' }] })) as Tenant[];
    return Promise.all(
      tenants.map(async (tenant) => {
        const account = ((await db.whatsappAccount.findFirst({
          where: { tenantId: tenant.id, status: 'ACTIVE' },
        })) ??
          (await db.whatsappAccount.findFirst({
            where: { tenantId: tenant.id },
          }))) as WhatsappAccount | null;
        const someConversation = await db.conversation.findFirst({
          where: { tenantId: tenant.id },
        });
        return {
          ...this.serializeTenant(tenant),
          linkedToGourmetify: !!tenant.gourmetifyTenantId,
          whatsapp: account
            ? {
                phoneNumberId: account.phoneNumberId,
                displayPhoneNumber: account.displayPhoneNumber,
                status: account.status,
              }
            : null,
          hasConversations: !!someConversation,
        };
      }),
    );
  }

  /** Alta/actualización idempotente por gourmetifyTenantId. */
  async upsertTenant(input: TenantProvisionInput): Promise<unknown> {
    const gourmetifyTenantId = requireString(input.gourmetifyTenantId, 'gourmetifyTenantId');
    const name = requireString(input.name, 'name');
    const timezone =
      typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : null;
    const adoptSlug =
      typeof input.adoptSlug === 'string' && input.adoptSlug.trim()
        ? input.adoptSlug.trim().toLowerCase()
        : null;
    const db = this.prisma.db;

    const existing = (await db.tenant.findUnique({
      where: { gourmetifyTenantId },
    })) as Tenant | null;

    if (adoptSlug) {
      return this.adoptTenant({ adoptSlug, gourmetifyTenantId, name, timezone, existing });
    }

    if (existing) {
      await db.tenant.update({
        where: { id: existing.id },
        data: { name, ...(timezone ? { timezone } : {}) },
      });
      const owner = (await db.user.findFirst({
        where: { tenantId: existing.id, role: 'OWNER' },
      })) as User | null;
      return {
        created: false,
        tenant: this.serializeTenant({ ...existing, name } as Tenant),
        owner: owner ? { email: owner.email, name: owner.name } : null,
      };
    }

    const ownerEmail = requireString(input.owner?.email, 'owner.email').toLowerCase();
    const ownerName = requireString(input.owner?.name, 'owner.name');
    let password: string;
    let generatedPassword = false;
    if (input.owner?.password !== undefined) {
      password = requireString(input.owner.password, 'owner.password');
      const policyError = passwordPolicyError(password);
      if (policyError) throw new BadRequestException(policyError);
    } else {
      password = randomBytes(9).toString('base64url'); // 12 chars
      generatedPassword = true;
    }

    const slug = await this.uniqueSlug(slugify(name));
    const tenant = (await db.tenant.create({
      data: { slug, name, gourmetifyTenantId, ...(timezone ? { timezone } : {}) },
    })) as Tenant;

    const owner = (await db.user.create({
      data: {
        tenantId: tenant.id,
        email: ownerEmail,
        name: ownerName,
        role: 'OWNER',
        passwordHash: await hashPassword(password),
        mustChangePassword: true, // la comunica Gourmetify; el primer login la cambia
      },
    })) as User;

    this.logger.log(`Tenant provisionado: ${tenant.slug} (gfy:${gourmetifyTenantId})`);
    return {
      created: true,
      tenant: this.serializeTenant(tenant),
      owner: {
        email: owner.email,
        name: owner.name,
        // SOLO cuando la generamos nosotros y SOLO en esta respuesta:
        // Gourmetify se la muestra al dueño una única vez.
        ...(generatedPassword ? { initialPassword: password } : {}),
      },
    };
  }

  /**
   * Vincula un tenant existente (por slug) al cliente de Gourmetify.
   * Si otro tenant VACÍO estaba ocupando ese gourmetifyTenantId (típico:
   * el que se creó en un intento anterior), se libera automáticamente;
   * si tenía datos, decide una persona.
   */
  private async adoptTenant(args: {
    adoptSlug: string;
    gourmetifyTenantId: string;
    name: string;
    timezone: string | null;
    existing: Tenant | null;
  }): Promise<unknown> {
    const { adoptSlug, gourmetifyTenantId, name, timezone, existing } = args;
    const db = this.prisma.db;

    const target = (await db.tenant.findUnique({ where: { slug: adoptSlug } })) as Tenant | null;
    if (!target) {
      throw new NotFoundException(`No existe un tenant con slug "${adoptSlug}"`);
    }
    if (target.gourmetifyTenantId && target.gourmetifyTenantId !== gourmetifyTenantId) {
      throw new ConflictException(
        `El tenant "${adoptSlug}" ya está vinculado a otro cliente de Gourmetify`,
      );
    }

    if (existing && existing.id !== target.id) {
      const [conversation, account] = await Promise.all([
        db.conversation.findFirst({ where: { tenantId: existing.id } }),
        db.whatsappAccount.findFirst({ where: { tenantId: existing.id } }),
      ]);
      if (conversation || account) {
        throw new ConflictException(
          `El cliente ya está vinculado al tenant "${existing.slug}", que tiene datos propios — ` +
            'unificalos a mano antes de adoptar otro',
        );
      }
      // Tenant vacío de un intento anterior: se libera para no chocar con
      // el unique de gourmetifyTenantId.
      await db.tenant.update({
        where: { id: existing.id },
        data: { gourmetifyTenantId: null },
      });
      this.logger.log(`Tenant vacío ${existing.slug} liberado para adoptar ${adoptSlug}`);
    }

    await db.tenant.update({
      where: { id: target.id },
      data: { gourmetifyTenantId, name, ...(timezone ? { timezone } : {}) },
    });
    const owner = (await db.user.findFirst({
      where: { tenantId: target.id, role: 'OWNER' },
    })) as User | null;

    this.logger.log(`Tenant adoptado: ${adoptSlug} ← gfy:${gourmetifyTenantId}`);
    return {
      created: false,
      adopted: true,
      tenant: this.serializeTenant({ ...target, name, gourmetifyTenantId } as Tenant),
      owner: owner ? { email: owner.email, name: owner.name } : null,
    };
  }

  /** Conecta (o re-conecta) la cuenta de WhatsApp del tenant. */
  async connectWhatsapp(gourmetifyTenantId: string, input: WhatsappConnectInput): Promise<unknown> {
    const db = this.prisma.db;
    const tenant = (await db.tenant.findUnique({
      where: { gourmetifyTenantId },
    })) as Tenant | null;
    if (!tenant) {
      throw new NotFoundException(`No hay tenant para gourmetifyTenantId=${gourmetifyTenantId}`);
    }

    const metaAppId = requireCredential(input.metaAppId, 'metaAppId');
    const metaAppSecret = requireCredential(input.metaAppSecret, 'metaAppSecret');
    const phoneNumberId = requireCredential(input.phoneNumberId, 'phoneNumberId');
    const wabaId = requireCredential(input.wabaId, 'wabaId');
    const accessToken = requireCredential(input.accessToken, 'accessToken');

    // Validación en vivo ANTES de tocar la base: nada se persiste si Meta
    // rechaza (el operador puede reintentar con las credenciales corregidas).
    const check = await this.checkCredentials(phoneNumberId, accessToken);
    if (!check.ok) {
      throw new BadRequestException(
        `Meta rechazó las credenciales: ${check.reason}${hintForMetaError(check.reason)}`,
      );
    }
    const displayPhone =
      typeof input.displayPhone === 'string' && input.displayPhone.trim()
        ? input.displayPhone.trim()
        : (check.displayPhoneNumber ?? phoneNumberId);

    // El número no puede estar conectado a OTRO tenant.
    const existingAccount = (await db.whatsappAccount.findUnique({
      where: { phoneNumberId },
    })) as WhatsappAccount | null;
    if (existingAccount && existingAccount.tenantId !== tenant.id) {
      throw new ConflictException('Ese número ya está conectado a otro restaurante');
    }

    const ref = `gfy-${gourmetifyTenantId}`.slice(0, 60);
    const providedVerifyToken =
      typeof input.verifyToken === 'string' && input.verifyToken.trim()
        ? input.verifyToken.trim()
        : null;
    const keyVersion = this.encryption.currentKeyVersion;

    /**
     * MetaApp por App ID (unique global). Si ya existe — el caso del tenant
     * que venía del seed, o un re-conectar — se REUSA en vez de crear otra:
     * conserva su `ref`, así la Callback URL que ya está configurada en el
     * panel de Meta sigue siendo válida. Y el verify token NO se regenera
     * salvo que manden uno: regenerarlo obligaría a re-verificar en Meta.
     */
    const byAppId = (await db.metaApp.findUnique({ where: { appId: metaAppId } })) as MetaApp | null;
    let metaApp: MetaApp;
    let verifyToken: string;

    if (byAppId) {
      // Varios tenants PUEDEN compartir la misma MetaApp: es el modelo Tech
      // Provider de fase 1 (una app, N números; el webhook resuelve el
      // tenant por phone_number_id). Lo exclusivo es el NÚMERO, no la app.
      verifyToken = providedVerifyToken ?? this.encryption.decrypt(byAppId.verifyTokenEnc);
      metaApp = (await db.metaApp.update({
        where: { id: byAppId.id },
        data: {
          appSecretEnc: this.encryption.encrypt(metaAppSecret),
          keyVersion,
          ...(providedVerifyToken
            ? { verifyTokenEnc: this.encryption.encrypt(providedVerifyToken) }
            : {}),
        },
      })) as MetaApp;
    } else {
      verifyToken = providedVerifyToken ?? randomBytes(24).toString('base64url');
      try {
        metaApp = (await db.metaApp.upsert({
          where: { ref },
          create: {
            ref,
            name: `Gourmetify — ${tenant.name}`,
            appId: metaAppId,
            appSecretEnc: this.encryption.encrypt(metaAppSecret),
            verifyTokenEnc: this.encryption.encrypt(verifyToken),
            keyVersion,
          },
          update: {
            appId: metaAppId,
            appSecretEnc: this.encryption.encrypt(metaAppSecret),
            verifyTokenEnc: this.encryption.encrypt(verifyToken),
            keyVersion,
          },
        })) as MetaApp;
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          throw new ConflictException('Ese App ID de Meta ya está en uso por otro restaurante');
        }
        throw error;
      }
    }

    const account = (await db.whatsappAccount.upsert({
      where: { phoneNumberId },
      create: {
        tenantId: tenant.id,
        metaAppId: metaApp.id,
        wabaId,
        phoneNumberId,
        displayPhoneNumber: displayPhone,
        accessTokenEnc: this.encryption.encrypt(accessToken),
        keyVersion,
        status: 'ACTIVE',
      },
      update: {
        metaAppId: metaApp.id,
        wabaId,
        displayPhoneNumber: displayPhone,
        accessTokenEnc: this.encryption.encrypt(accessToken),
        keyVersion,
        status: 'ACTIVE',
      },
    })) as WhatsappAccount;

    // Un tenant opera UN número a la vez: al conectar otro (típico paso del
    // número de prueba al real), el anterior queda DISCONNECTED. Su
    // historial de conversaciones se conserva y se sigue viendo.
    const { count: replaced } = await db.whatsappAccount.updateMany({
      where: {
        tenantId: tenant.id,
        phoneNumberId: { not: phoneNumberId },
        status: { not: 'DISCONNECTED' },
      },
      data: { status: 'DISCONNECTED' },
    });
    if (replaced > 0) {
      this.logger.log(`${replaced} número(s) anterior(es) de ${tenant.slug} quedaron DISCONNECTED`);
    }

    this.logger.log(`WhatsApp conectado: tenant ${tenant.slug}, número ${displayPhone}`);
    return {
      ...(this.connectionStatus(tenant, metaApp, account, verifyToken) as Record<string, unknown>),
      replacedNumbers: replaced,
    };
  }

  /** Estado de la conexión — sin secretos (el verify token sí: va al panel de Meta). */
  async getWhatsapp(gourmetifyTenantId: string): Promise<unknown> {
    const db = this.prisma.db;
    const tenant = (await db.tenant.findUnique({
      where: { gourmetifyTenantId },
    })) as Tenant | null;
    if (!tenant) {
      throw new NotFoundException(`No hay tenant para gourmetifyTenantId=${gourmetifyTenantId}`);
    }
    // El número vigente es el ACTIVE; los reemplazados quedan DISCONNECTED.
    const account = ((await db.whatsappAccount.findFirst({
      where: { tenantId: tenant.id, status: 'ACTIVE' },
    })) ??
      (await db.whatsappAccount.findFirst({
        where: { tenantId: tenant.id },
      }))) as WhatsappAccount | null;
    if (!account) {
      return { connected: false, tenant: this.serializeTenant(tenant) };
    }
    const metaApp = (await db.metaApp.findUnique({
      where: { id: account.metaAppId },
    })) as MetaApp | null;
    const verifyToken = metaApp ? this.encryption.decrypt(metaApp.verifyTokenEnc) : null;
    return this.connectionStatus(tenant, metaApp, account, verifyToken);
  }

  // ──────────────────────────────────────────────────────────────────────

  private connectionStatus(
    tenant: Tenant,
    metaApp: MetaApp | null,
    account: WhatsappAccount,
    verifyToken: string | null,
  ): unknown {
    const ref = metaApp?.ref ?? null;
    return {
      connected: true,
      tenant: this.serializeTenant(tenant),
      account: {
        phoneNumberId: account.phoneNumberId,
        wabaId: account.wabaId,
        displayPhoneNumber: account.displayPhoneNumber,
        status: account.status,
      },
      webhook: {
        // Callback URL para el panel de Meta. PUBLIC_API_URL la define el
        // deploy (ej: https://inbox.gourmetify.pro/inbox/api).
        path: ref ? `/webhooks/whatsapp/${ref}` : null,
        url:
          ref && process.env.PUBLIC_API_URL?.trim()
            ? `${process.env.PUBLIC_API_URL.trim().replace(/\/+$/, '')}/webhooks/whatsapp/${ref}`
            : null,
        verifyToken,
      },
    };
  }

  private serializeTenant(tenant: Tenant): Record<string, unknown> {
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
      gourmetifyTenantId: tenant.gourmetifyTenantId,
    };
  }

  private async uniqueSlug(base: string): Promise<string> {
    const db = this.prisma.db;
    let candidate = base;
    for (let i = 2; i < 50; i++) {
      const clash = await db.tenant.findUnique({ where: { slug: candidate } });
      if (!clash) return candidate;
      candidate = `${base}-${i}`;
    }
    return `${base}-${randomBytes(3).toString('hex')}`;
  }
}
