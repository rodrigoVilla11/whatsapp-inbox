import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Encryption } from '../src/crypto/encryption';

const keyB64 = (): string => randomBytes(32).toString('base64');

function build(version = 1, key = keyB64()): Encryption {
  return new Encryption({ keys: new Map([[version, Buffer.from(key, 'base64')]]), activeVersion: version });
}

describe('Encryption', () => {
  it('roundtrip: encrypt → decrypt devuelve el plaintext', () => {
    const enc = build();
    const token = 'EAAG...token-de-whatsapp-largo-🔐';
    expect(enc.decrypt(enc.encrypt(token))).toBe(token);
  });

  it('produce envelopes distintos para el mismo plaintext (IV aleatorio)', () => {
    const enc = build();
    expect(enc.encrypt('mismo')).not.toBe(enc.encrypt('mismo'));
  });

  it('el envelope tiene el formato v1.<kv>.<iv>.<tag>.<ct>', () => {
    const enc = build(3, keyB64());
    const parts = enc.encrypt('x').split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe('3');
  });

  it('rechaza payload manipulado (auth tag GCM)', () => {
    const enc = build();
    const envelope = enc.encrypt('secreto');
    const parts = envelope.split('.');
    const ct = Buffer.from(parts[4], 'base64');
    ct[0] ^= 0xff;
    parts[4] = ct.toString('base64');
    expect(() => enc.decrypt(parts.join('.'))).toThrow();
  });

  it('rechaza descifrar con otra clave', () => {
    const a = build();
    const b = build();
    expect(() => b.decrypt(a.encrypt('secreto'))).toThrow();
  });

  it('rechaza keyVersion sin clave disponible', () => {
    const enc = build(1);
    const other = build(2);
    expect(() => enc.decrypt(other.encrypt('x'))).toThrow(/keyVersion=2/);
  });

  it('descifra envelopes viejos tras rotar la clave activa', () => {
    const v1 = Buffer.from(keyB64(), 'base64');
    const v2 = Buffer.from(keyB64(), 'base64');
    const before = new Encryption({ keys: new Map([[1, v1]]), activeVersion: 1 });
    const old = before.encrypt('token-viejo');

    const after = new Encryption({ keys: new Map([[1, v1], [2, v2]]), activeVersion: 2 });
    expect(after.decrypt(old)).toBe('token-viejo'); // clave vieja sigue descifrando
    expect(after.encrypt('nuevo').split('.')[1]).toBe('2'); // lo nuevo sale con v2
  });

  it('parseEnv: ENCRYPTION_KEY simple equivale a versión 1', () => {
    const { keys, activeVersion } = Encryption.parseEnv({ ENCRYPTION_KEY: keyB64() });
    expect(activeVersion).toBe(1);
    expect(keys.get(1)).toHaveLength(32);
  });

  it('parseEnv: falla sin claves y con clave corta', () => {
    expect(() => Encryption.parseEnv({})).toThrow(/ENCRYPTION_KEY/);
    expect(() => Encryption.fromEnv({ ENCRYPTION_KEY: 'corta' })).toThrow(/32 bytes/);
  });
});
