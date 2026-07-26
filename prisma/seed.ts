/**
 * Seed: tenant Nova Sushi + Meta App + cuenta de WhatsApp + owner + /carta.
 *
 * Las credenciales se leen de las SEED_* de .env UNA sola vez, acá, para
 * cifrarlas y guardarlas en la base. El runtime jamás las lee de env.
 *
 * Idempotente: se puede correr N veces. Política de secretos en re-runs:
 * - SEED_* presente  → se re-cifra y actualiza (rotación manual de creds).
 * - SEED_* ausente   → no se toca lo que ya está en la base (y si es un
 *   create nuevo, entra un placeholder y la cuenta queda PENDING).
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/passwords';
import { Encryption } from '../src/crypto/encryption';

const prisma = new PrismaClient();
const encryption = Encryption.fromEnv(process.env);

const PLACEHOLDER = (name: string) => `PLACEHOLDER_${name}`;

function seedValue(envVar: string): { value: string; isPlaceholder: boolean } {
  const raw = process.env[envVar]?.trim();
  if (raw) return { value: raw, isPlaceholder: false };
  return { value: PLACEHOLDER(envVar.replace(/^SEED_/, '')), isPlaceholder: true };
}

async function main(): Promise<void> {
  const keyVersion = encryption.currentKeyVersion;

  // ── Meta App (plataforma: una sola app para todos los tenants) ──────────
  const appId = seedValue('SEED_META_APP_ID');
  const appSecret = seedValue('SEED_META_APP_SECRET');
  // El verify token es nuestro (se lo damos a Meta al configurar el webhook):
  // si no vino por env, se genera uno real, no un placeholder.
  const verifyTokenEnv = process.env.SEED_WEBHOOK_VERIFY_TOKEN?.trim();
  const generatedVerifyToken = verifyTokenEnv ?? randomBytes(24).toString('base64url');

  const metaApp = await prisma.metaApp.upsert({
    where: { ref: 'default' },
    create: {
      ref: 'default',
      name: 'Gourmetify WhatsApp App',
      appId: appId.value,
      appSecretEnc: encryption.encrypt(appSecret.value),
      verifyTokenEnc: encryption.encrypt(generatedVerifyToken),
      keyVersion,
    },
    update: {
      ...(appId.isPlaceholder ? {} : { appId: appId.value }),
      ...(appSecret.isPlaceholder
        ? {}
        : { appSecretEnc: encryption.encrypt(appSecret.value), keyVersion }),
      ...(verifyTokenEnv
        ? { verifyTokenEnc: encryption.encrypt(verifyTokenEnv), keyVersion }
        : {}),
    },
  });

  // ── Tenant ──────────────────────────────────────────────────────────────
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'nova-sushi' },
    create: {
      slug: 'nova-sushi',
      name: 'Nova Sushi',
      timezone: 'America/Argentina/Buenos_Aires',
    },
    update: {},
  });

  // ── Cuenta de WhatsApp ──────────────────────────────────────────────────
  const phoneNumberId = seedValue('SEED_WA_PHONE_NUMBER_ID');
  const wabaId = seedValue('SEED_WA_WABA_ID');
  const displayPhone = seedValue('SEED_WA_DISPLAY_PHONE');
  const accessToken = seedValue('SEED_WA_ACCESS_TOKEN');

  const credentialsComplete =
    !phoneNumberId.isPlaceholder &&
    !wabaId.isPlaceholder &&
    !accessToken.isPlaceholder &&
    !appSecret.isPlaceholder;

  const account = await prisma.whatsappAccount.upsert({
    where: { phoneNumberId: phoneNumberId.value },
    create: {
      tenantId: tenant.id,
      metaAppId: metaApp.id,
      wabaId: wabaId.value,
      phoneNumberId: phoneNumberId.value,
      displayPhoneNumber: displayPhone.value,
      accessTokenEnc: encryption.encrypt(accessToken.value),
      keyVersion,
      status: credentialsComplete ? 'ACTIVE' : 'PENDING',
    },
    update: {
      ...(wabaId.isPlaceholder ? {} : { wabaId: wabaId.value }),
      ...(displayPhone.isPlaceholder ? {} : { displayPhoneNumber: displayPhone.value }),
      ...(accessToken.isPlaceholder
        ? {}
        : {
            accessTokenEnc: encryption.encrypt(accessToken.value),
            keyVersion,
            status: credentialsComplete ? 'ACTIVE' : undefined,
          }),
    },
  });

  // ── Usuario owner ───────────────────────────────────────────────────────
  // SEED_OWNER_PASSWORD presente → se hashea (argon2id) y actualiza; ausente
  // → no se toca lo existente (y un owner nuevo queda SIN poder loguearse
  // hasta re-seedear con password). El owner conoce su password: sin
  // mustChangePassword.
  // `||` y no `??`: SEED_OWNER_EMAIL= (vacía) también debe caer al default —
  // con ?? se creaba un owner con email '' imposible de loguear.
  const ownerEmail = (process.env.SEED_OWNER_EMAIL?.trim() || 'owner@nova-sushi.local')
    .toLowerCase();
  const ownerPassword = process.env.SEED_OWNER_PASSWORD?.trim();
  const ownerHash = ownerPassword ? await hashPassword(ownerPassword) : null;

  // Sanar el daño de ese bug si ya existe: renombrar al owner con email ''
  // (en vez de dejar un OWNER fantasma y crear otro).
  await prisma.user.updateMany({
    where: { tenantId: tenant.id, role: 'OWNER', email: '' },
    data: { email: ownerEmail },
  });

  const owner = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: ownerEmail } },
    create: {
      tenantId: tenant.id,
      email: ownerEmail,
      name: 'Nova Sushi Owner',
      role: 'OWNER',
      passwordHash: ownerHash,
    },
    update: ownerHash ? { passwordHash: ownerHash } : {},
  });

  // ── Respuesta rápida /carta (el link del menú es DATO por-tenant) ───────
  const menuUrl = process.env.SEED_MENU_URL?.trim() || 'https://TODO-link-carta-nova-sushi';
  await prisma.quickReply.upsert({
    where: { tenantId_shortcut: { tenantId: tenant.id, shortcut: '/carta' } },
    create: {
      tenantId: tenant.id,
      shortcut: '/carta',
      title: 'Enviar carta',
      body: `¡Hola! 🍣 Acá podés ver nuestra carta completa: ${menuUrl}`,
    },
    update: {},
  });

  // ── Resumen ─────────────────────────────────────────────────────────────
  console.log('Seed OK');
  console.log(`  Tenant:          ${tenant.name} (${tenant.id})`);
  console.log(`  MetaApp:         ref=${metaApp.ref} appId=${appId.value}`);
  console.log(`  WhatsappAccount: phoneNumberId=${phoneNumberId.value} status=${account.status}`);
  if (!verifyTokenEnv) {
    console.log(
      '  Verify token: en DB, cifrado (autogenerado si la app era nueva). Para fijar uno propio, ' +
        'setear SEED_WEBHOOK_VERIFY_TOKEN y re-seedear; es el que se pega en la config del webhook en Meta.',
    );
  }
  if (!credentialsComplete) {
    console.warn(
      '  ⚠ Hay credenciales placeholder (SEED_* vacías en .env): la cuenta quedó PENDING. ' +
        'Completá las SEED_* reales y volvé a correr `npm run db:seed`.',
    );
  }
  if (!owner.passwordHash) {
    console.warn(
      `  ⚠ El owner (${ownerEmail}) NO tiene contraseña: no puede iniciar sesión. ` +
        'Seteá SEED_OWNER_PASSWORD (mínimo 10 caracteres) y volvé a correr `npm run db:seed`.',
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
