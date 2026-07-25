import { describe, expect, it } from 'vitest';
import {
  buildMessagePreview,
  mapInboundMessage,
  mapMetaMessageType,
  parseEpochSeconds,
  waIdToE164,
} from '../src/webhook-worker/message-mapping';

describe('parseEpochSeconds', () => {
  it('convierte epoch en SEGUNDOS a Date (×1000)', () => {
    const date = parseEpochSeconds('1690000000');
    expect(date?.getTime()).toBe(1_690_000_000_000);
    expect(date?.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('documenta el bug clásico: sin ×1000 todo queda en enero de 1970', () => {
    expect(new Date(1_690_000_000).getUTCFullYear()).toBe(1970); // el bug
    expect(parseEpochSeconds(1_690_000_000)?.getUTCFullYear()).toBeGreaterThan(2020); // el fix
  });

  it('devuelve null ante basura', () => {
    expect(parseEpochSeconds(undefined)).toBeNull();
    expect(parseEpochSeconds('abc')).toBeNull();
    expect(parseEpochSeconds('0')).toBeNull();
  });
});

describe('mapMetaMessageType', () => {
  it('mapea los tipos conocidos', () => {
    expect(mapMetaMessageType('text')).toBe('TEXT');
    expect(mapMetaMessageType('image')).toBe('IMAGE');
    expect(mapMetaMessageType('reaction')).toBe('REACTION');
  });

  it('tipo desconocido o ausente → UNSUPPORTED', () => {
    expect(mapMetaMessageType('flight_ticket')).toBe('UNSUPPORTED');
    expect(mapMetaMessageType(undefined)).toBe('UNSUPPORTED');
  });
});

describe('waIdToE164', () => {
  it('normaliza wa_id válido y rechaza basura', () => {
    expect(waIdToE164('5493415550000')).toBe('+5493415550000');
    expect(waIdToE164('no-un-numero')).toBeNull();
    expect(waIdToE164('123')).toBeNull();
  });
});

describe('mapInboundMessage / buildMessagePreview', () => {
  it('texto: body directo, sin raw', () => {
    const mapped = mapInboundMessage({ type: 'text', text: { body: 'hola' } });
    expect(mapped).toMatchObject({ type: 'TEXT', body: 'hola', keepRaw: false, hasMedia: false });
  });

  it('imagen: media fields + PENDING implícito, caption como body', () => {
    const mapped = mapInboundMessage({
      type: 'image',
      image: { id: 'media_1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'mirá' },
    });
    expect(mapped).toMatchObject({
      type: 'IMAGE',
      body: 'mirá',
      mediaId: 'media_1',
      mediaMimeType: 'image/jpeg',
      mediaSha256: 'abc',
      hasMedia: true,
    });
  });

  it('tipo inventado → UNSUPPORTED con keepRaw', () => {
    const mapped = mapInboundMessage({ type: 'flight_ticket' });
    expect(mapped.type).toBe('UNSUPPORTED');
    expect(mapped.keepRaw).toBe(true);
  });

  it('reaction: emoji en body, referencia al mensaje reaccionado, preview deliberado', () => {
    const mapped = mapInboundMessage({
      type: 'reaction',
      reaction: { message_id: 'wamid.TARGET', emoji: '👍' },
    });
    expect(mapped).toMatchObject({ type: 'REACTION', body: '👍', replyToWamid: 'wamid.TARGET', isReaction: true });
    expect(buildMessagePreview(mapped)).toBe('Reaccionó 👍');
  });

  it('context.id → replyToWamid en mensajes normales', () => {
    const mapped = mapInboundMessage({
      type: 'text',
      text: { body: 'respuesta' },
      context: { id: 'wamid.QUOTED' },
    });
    expect(mapped.replyToWamid).toBe('wamid.QUOTED');
  });

  it('preview: documento con filename, y truncado a 120', () => {
    const doc = mapInboundMessage({ type: 'document', document: { id: 'm', filename: 'menu.pdf' } });
    expect(buildMessagePreview(doc)).toBe('📄 menu.pdf');

    const largo = mapInboundMessage({ type: 'text', text: { body: 'x'.repeat(500) } });
    expect(buildMessagePreview(largo).length).toBeLessThanOrEqual(120);
  });
});
