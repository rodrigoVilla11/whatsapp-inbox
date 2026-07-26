import * as argon2 from 'argon2';

/**
 * Passwords con argon2id (ganador del PHC, memoria-duro). Parámetros OWASP:
 * 64MB / t=3 / p=4. `verifyPassword` devuelve además si el hash quedó viejo
 * (parámetros cambiados o formato ajeno) → el login re-hashea en caliente.
 *
 * Nota: el seed nunca escribió bcrypt (passwordHash era null hasta esta
 * fase), así que no hay verificación legacy: un hash que no sea argon2
 * simplemente no verifica. Si algún día entra una base con bcrypt, este es
 * el lugar donde se agrega el fallback + rehash.
 */

const ARGON_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536, // KiB = 64MB
  timeCost: 3,
  parallelism: 4,
};

const REHASH_OPTIONS = { memoryCost: 65536, timeCost: 3, parallelism: 4 };

export const MIN_PASSWORD_LENGTH = 10;

/** null si es válida; mensaje para el usuario si no. Sin reglas arbitrarias. */
export function passwordPolicyError(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(
  hash: string | null,
  password: string,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (!hash || !hash.startsWith('$argon2')) {
    // Igualar el timing con un verify real contra un hash dummy: que
    // "email sin password" no se distinga por velocidad de respuesta.
    await argon2.verify(await dummyHash(), password).catch(() => false);
    return { ok: false, needsRehash: false };
  }
  const ok = await argon2.verify(hash, password).catch(() => false);
  return { ok, needsRehash: ok && argon2.needsRehash(hash, REHASH_OPTIONS) };
}

// Hash real (calculado una vez, lazy) solo para igualar timing.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('timing-equalizer', ARGON_OPTIONS);
  return dummyHashPromise;
}
