import { describe, expect, it } from 'vitest';
import {
  computeMetaSignature,
  timingSafeStringEqual,
  verifyMetaSignature,
} from '../src/webhooks/webhook-signature';

const SECRET = 'app-secret-de-prueba';
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

describe('verifyMetaSignature', () => {
  it('valida la firma correcta', () => {
    expect(verifyMetaSignature(body, SECRET, computeMetaSignature(body, SECRET))).toBe(true);
  });

  it('rechaza body alterado y secret equivocado', () => {
    const sig = computeMetaSignature(body, SECRET);
    expect(verifyMetaSignature(Buffer.from(body.toString() + ' '), SECRET, sig)).toBe(false);
    expect(verifyMetaSignature(body, 'otro-secret', sig)).toBe(false);
  });

  it('rechaza header ausente, malformado o no-string, sin tirar', () => {
    expect(verifyMetaSignature(body, SECRET, undefined)).toBe(false);
    expect(verifyMetaSignature(body, SECRET, 'md5=abc')).toBe(false);
    expect(verifyMetaSignature(body, SECRET, 'abc123')).toBe(false);
    expect(verifyMetaSignature(body, SECRET, ['sha256=a', 'sha256=b'])).toBe(false);
  });

  it('rechaza hex corto/largo/basura sin excepción (timingSafeEqual tiraría por longitud)', () => {
    expect(verifyMetaSignature(body, SECRET, 'sha256=abcd')).toBe(false); // 2 bytes
    expect(verifyMetaSignature(body, SECRET, 'sha256=' + 'a'.repeat(63))).toBe(false);
    expect(verifyMetaSignature(body, SECRET, 'sha256=' + 'a'.repeat(65))).toBe(false);
    expect(verifyMetaSignature(body, SECRET, 'sha256=' + 'z'.repeat(64))).toBe(false); // no-hex
  });

  it('rechaza firma de 64 hex válidos pero incorrecta', () => {
    expect(verifyMetaSignature(body, SECRET, 'sha256=' + '0'.repeat(64))).toBe(false);
  });

  it('rechaza rawBody ausente o vacío', () => {
    const sig = computeMetaSignature(Buffer.alloc(0), SECRET);
    expect(verifyMetaSignature(undefined, SECRET, sig)).toBe(false);
    expect(verifyMetaSignature(Buffer.alloc(0), SECRET, sig)).toBe(false);
  });
});

describe('timingSafeStringEqual', () => {
  it('compara sin tirar ante longitudes distintas', () => {
    expect(timingSafeStringEqual('abc', 'abc')).toBe(true);
    expect(timingSafeStringEqual('abc', 'abd')).toBe(false);
    expect(timingSafeStringEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeStringEqual('', '')).toBe(true);
  });
});
