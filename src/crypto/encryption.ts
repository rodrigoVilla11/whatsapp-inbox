import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado en reposo para credenciales (access tokens, app secrets, verify
 * tokens). AES-256-GCM con envelope versionado:
 *
 *   v1.<keyVersion>.<iv b64>.<authTag b64>.<ciphertext b64>
 *
 * - `v1` es la versión del FORMATO de envelope.
 * - `keyVersion` identifica la clave usada: permite rotar la clave activa
 *   sin re-cifrar toda la tabla de golpe (las versiones viejas quedan
 *   disponibles solo para descifrar).
 *
 * Clase pura sin dependencias de Nest: el seed de Prisma la usa directo,
 * sin bootstrapear la aplicación.
 */

const ENVELOPE_FORMAT = 'v1';
const IV_BYTES = 12; // recomendado para GCM
const KEY_BYTES = 32; // AES-256

export interface EncryptionKeys {
  keys: Map<number, Buffer>;
  activeVersion: number;
}

export class Encryption {
  private readonly keys: Map<number, Buffer>;
  private readonly activeVersion: number;

  constructor({ keys, activeVersion }: EncryptionKeys) {
    for (const [version, key] of keys) {
      if (key.length !== KEY_BYTES) {
        throw new Error(
          `ENCRYPTION_KEY v${version} inválida: se esperan ${KEY_BYTES} bytes en base64, llegaron ${key.length}`,
        );
      }
    }
    if (!keys.has(activeVersion)) {
      throw new Error(
        `ENCRYPTION_ACTIVE_KEY_VERSION=${activeVersion} no tiene clave correspondiente`,
      );
    }
    this.keys = keys;
    this.activeVersion = activeVersion;
  }

  /**
   * Lee las claves desde env. Formas soportadas:
   * - ENCRYPTION_KEY=<base64 32B>                      → versión 1
   * - ENCRYPTION_KEYS={"1":"<b64>","2":"<b64>"}        → multi-versión (rotación)
   * - ENCRYPTION_ACTIVE_KEY_VERSION=2                  → con cuál cifrar (default 1)
   */
  static parseEnv(env: NodeJS.ProcessEnv): EncryptionKeys {
    const keys = new Map<number, Buffer>();

    if (env.ENCRYPTION_KEYS) {
      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(env.ENCRYPTION_KEYS) as Record<string, string>;
      } catch {
        throw new Error('ENCRYPTION_KEYS no es JSON válido ({"version":"base64"})');
      }
      for (const [version, b64] of Object.entries(parsed)) {
        keys.set(Number(version), Buffer.from(b64, 'base64'));
      }
    }
    if (env.ENCRYPTION_KEY && !keys.has(1)) {
      keys.set(1, Buffer.from(env.ENCRYPTION_KEY, 'base64'));
    }
    if (keys.size === 0) {
      throw new Error(
        'Falta ENCRYPTION_KEY (o ENCRYPTION_KEYS). Generar con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
    }

    const activeVersion = Number(env.ENCRYPTION_ACTIVE_KEY_VERSION ?? '1');
    return { keys, activeVersion };
  }

  static fromEnv(env: NodeJS.ProcessEnv): Encryption {
    return new Encryption(Encryption.parseEnv(env));
  }

  /** Versión de clave con la que se cifra hoy — se persiste en keyVersion. */
  get currentKeyVersion(): number {
    return this.activeVersion;
  }

  encrypt(plaintext: string): string {
    const key = this.keys.get(this.activeVersion)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_FORMAT,
      String(this.activeVersion),
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== ENVELOPE_FORMAT) {
      throw new Error('Envelope de cifrado inválido (se espera v1.<kv>.<iv>.<tag>.<ct>)');
    }
    const version = Number(parts[1]);
    const key = this.keys.get(version);
    if (!key) {
      throw new Error(`No hay clave para keyVersion=${version}; ¿falta en ENCRYPTION_KEYS?`);
    }
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const ciphertext = Buffer.from(parts[4], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    // .final() tira si el tag no valida (payload manipulado o clave equivocada)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
