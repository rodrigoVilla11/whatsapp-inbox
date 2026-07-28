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

  /** Alta/actualización idempotente por gourmetifyTenantId. */
  async upsertTenant(input: TenantProvisionInput): Promise<unknown> {
    const gourmetifyTenantId = requireString(input.gourmetifyTenantId, 'gourmetifyTenantId');
    const name = requireString(input.name, 'name');
    const timezone =
      typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : null;
    const db = this.prisma.db;

    const existing = (await db.tenant.findUnique({
      where: { gourmetifyTenantId },
    })) as Tenant | null;

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

  /** Conecta (o re-conecta) la cuenta de WhatsApp del tenant. */
  async connectWhatsapp(gourmetifyTenantId: string, input: WhatsappConnectInput): Promise<unknown> {
    const db = this.prisma.db;
    const tenant = (await db.tenant.findUnique({
      where: { gourmetifyTenantId },
    })) as Tenant | null;
    if (!tenant) {
      throw new NotFoundException(`No hay tenant para gourmetifyTenantId=${gourmetifyTenantId}`);
    }

    const metaAppId = requireString(input.metaAppId, 'metaAppId');
    const metaAppSecret = requireString(input.metaAppSecret, 'metaAppSecret');
    const phoneNumberId = requireString(input.phoneNumberId, 'phoneNumberId');
    const wabaId = requireString(input.wabaId, 'wabaId');
    const accessToken = requireString(input.accessToken, 'accessToken');

    // Validación en vivo ANTES de tocar la base.
    const check = await this.checkCredentials(phoneNumberId, accessToken);
    if (!check.ok) {
      throw new BadRequestException(`Meta rechazó las credenciales: ${check.reason}`);
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
    const verifyToken =
      typeof input.verifyToken === 'string' && input.verifyToken.trim()
        ? input.verifyToken.trim()
        : randomBytes(24).toString('base64url');
    const keyVersion = this.encryption.currentKeyVersion;

    let metaApp: MetaApp;
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

    this.logger.log(`WhatsApp conectado: tenant ${tenant.slug}, número ${displayPhone}`);
    return this.connectionStatus(tenant, metaApp, account, verifyToken);
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
    const account = (await db.whatsappAccount.findFirst({
      where: { tenantId: tenant.id },
    })) as WhatsappAccount | null;
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
