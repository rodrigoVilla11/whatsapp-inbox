/**
 * Auto-respuesta fuera de horario: isOpenAt puro (timezone, dos turnos,
 * cruce de medianoche), validación de config, y el trigger con cooldown
 * de 6h y claim atómico.
 */
import 'reflect-metadata';
import { BadRequestException, Logger } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOpenAt, parseAutoReplyConfig, type WeekSchedule } from '../src/messaging/auto-reply';
import { AutoReplyService } from '../src/messaging/auto-reply.service';
import type { SendMessageService } from '../src/messaging/send-message.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createFakeDb, type FakeDb } from './support/fake-db';

const TENANT = 'ten_1';
const TZ = 'America/Argentina/Buenos_Aires'; // UTC-3

beforeAll(() => Logger.overrideLogger(false));

// ── isOpenAt (el corazón) ────────────────────────────────────────────────

describe('isOpenAt', () => {
  // miércoles 19:30–23:30 y 12:00–15:00 (dos turnos), lunes cerrado
  const schedule: WeekSchedule = {
    '3': [
      { from: '12:00', to: '15:00' },
      { from: '19:30', to: '23:30' },
    ],
  };

  // miércoles 2026-07-29 en Buenos Aires (UTC-3)
  const wedAt = (hhmm: string): Date => new Date(`2026-07-29T${hhmm}:00-03:00`);

  it('dentro de un turno → abierto; entre turnos y fuera → cerrado', () => {
    expect(isOpenAt(schedule, wedAt('13:00'), TZ)).toBe(true); // mediodía
    expect(isOpenAt(schedule, wedAt('20:00'), TZ)).toBe(true); // noche
    expect(isOpenAt(schedule, wedAt('17:00'), TZ)).toBe(false); // corte
    expect(isOpenAt(schedule, wedAt('09:00'), TZ)).toBe(false); // antes
    expect(isOpenAt(schedule, wedAt('23:45'), TZ)).toBe(false); // después
  });

  it('día sin rangos (o ausente) → cerrado todo el día', () => {
    const monday = new Date('2026-07-27T13:00:00-03:00');
    expect(isOpenAt(schedule, monday, TZ)).toBe(false);
  });

  it('el TIMEZONE manda: el mismo instante es otro día/hora según el tenant', () => {
    // 2026-07-30T01:00Z = miércoles 22:00 en Buenos Aires → abierto
    const instant = new Date('2026-07-30T01:00:00Z');
    expect(isOpenAt(schedule, instant, TZ)).toBe(true);
    // …pero en UTC ya es jueves 01:00 → cerrado
    expect(isOpenAt(schedule, instant, 'UTC')).toBe(false);
  });

  it('rango que cruza medianoche: cubre la noche Y la madrugada del día siguiente', () => {
    const nocturno: WeekSchedule = { '5': [{ from: '19:30', to: '00:30' }] }; // viernes
    const friNight = new Date('2026-07-31T23:00:00-03:00'); // viernes 23:00
    const satEarly = new Date('2026-08-01T00:15:00-03:00'); // sábado 00:15
    const satLater = new Date('2026-08-01T01:00:00-03:00'); // sábado 01:00
    expect(isOpenAt(nocturno, friNight, TZ)).toBe(true);
    expect(isOpenAt(nocturno, satEarly, TZ)).toBe(true); // madrugada del rango del viernes
    expect(isOpenAt(nocturno, satLater, TZ)).toBe(false);
  });
});

// ── Validación de config ─────────────────────────────────────────────────

describe('parseAutoReplyConfig', () => {
  it('config válida se normaliza; inválidas nombran el problema', () => {
    const ok = parseAutoReplyConfig({
      enabled: true,
      message: 'Cerrado — abrimos 19:30',
      schedule: { '3': [{ from: '19:30', to: '23:30' }] },
    });
    expect(ok.ok).toBe(true);

    const badHour = parseAutoReplyConfig({
      enabled: true, message: 'x'.repeat(11),
      schedule: { '3': [{ from: '25:00', to: '23:30' }] },
    });
    expect(badHour.ok).toBe(false);
    expect((badHour as { problems: string[] }).problems.join(' ')).toMatch(/HH:MM/);

    const emptyMsg = parseAutoReplyConfig({ enabled: true, message: '  ', schedule: {} });
    expect(emptyMsg.ok).toBe(false);

    const tooMany = parseAutoReplyConfig({
      enabled: false, message: '',
      schedule: { '1': [{ from: '01:00', to: '02:00' }, { from: '03:00', to: '04:00' }, { from: '05:00', to: '06:00' }] },
    });
    expect(tooMany.ok).toBe(false);
    expect((tooMany as { problems: string[] }).problems.join(' ')).toMatch(/máximo 2/);
  });
});

// ── Trigger con cooldown ─────────────────────────────────────────────────

describe('AutoReplyService.maybeReply', () => {
  let db: FakeDb;
  let send: ReturnType<typeof vi.fn>;
  let service: AutoReplyService;

  // Config: SOLO abre miércoles a la noche → un lunes a las 15:00 está cerrado
  const closedMonday = new Date('2026-07-27T15:00:00-03:00');
  const openWednesday = new Date('2026-07-29T20:00:00-03:00');

  beforeEach(() => {
    db = createFakeDb();
    send = vi.fn().mockResolvedValue({ httpStatus: 200, message: { id: 'm1' }, error: null });
    service = new AutoReplyService(
      { db } as unknown as PrismaService,
      { send } as unknown as SendMessageService,
    );
    db.tenant.seed({
      id: TENANT, slug: 'nova', name: 'Nova', timezone: TZ,
      autoReply: {
        enabled: true,
        message: 'Cerrado — abrimos 19:30 🍣',
        schedule: { '3': [{ from: '19:30', to: '23:30' }] },
      },
    });
    db.conversation.seed({ id: 'conv_1', tenantId: TENANT, whatsappAccountId: 'a', contactId: 'c' });
  });

  it('fuera de horario → envía UNA vez y estampa lastAutoReplyAt', async () => {
    await service.maybeReply(TENANT, 'conv_1', closedMonday);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      TENANT,
      'conv_1',
      expect.objectContaining({ type: 'text', body: 'Cerrado — abrimos 19:30 🍣', isAutoReply: true }),
      null, // el sistema, no una persona
    );
    expect(db.conversation.findFirst({ where: { id: 'conv_1' } })!.lastAutoReplyAt).toBeTruthy();
  });

  it('cooldown de 6h: mensajes seguidos NO repiten; pasadas las 6h sí', async () => {
    await service.maybeReply(TENANT, 'conv_1', closedMonday);
    await service.maybeReply(TENANT, 'conv_1', new Date(closedMonday.getTime() + 60_000));
    expect(send).toHaveBeenCalledTimes(1); // el segundo mensaje no dispara

    const sevenHoursLater = new Date(closedMonday.getTime() + 7 * 3600 * 1000);
    await service.maybeReply(TENANT, 'conv_1', sevenHoursLater); // lunes 22:00, sigue cerrado
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('dentro de horario NO envía', async () => {
    await service.maybeReply(TENANT, 'conv_1', openWednesday);
    expect(send).not.toHaveBeenCalled();
  });

  it('deshabilitada o sin config NO envía', async () => {
    db.tenant.updateMany({ where: { id: TENANT }, data: { autoReply: { enabled: false, message: 'x', schedule: {} } } });
    await service.maybeReply(TENANT, 'conv_1', closedMonday);
    db.tenant.updateMany({ where: { id: TENANT }, data: { autoReply: null } });
    await service.maybeReply(TENANT, 'conv_1', closedMonday);
    expect(send).not.toHaveBeenCalled();
  });

  it('fallo del envío no explota (best-effort) y el cooldown queda consumido', async () => {
    send.mockResolvedValueOnce({
      httpStatus: 500, message: null, error: { code: 'META_UNAVAILABLE', message: 'boom' },
    });
    await expect(service.maybeReply(TENANT, 'conv_1', closedMonday)).resolves.toBeUndefined();
    await service.maybeReply(TENANT, 'conv_1', new Date(closedMonday.getTime() + 60_000));
    expect(send).toHaveBeenCalledTimes(1); // sin cascada de reintentos
  });

  it('updateConfig valida (400 con detalle) y getConfig devuelve default si no hay nada', async () => {
    await expect(
      service.updateConfig(TENANT, { enabled: true, message: '', schedule: {} }),
    ).rejects.toThrow(BadRequestException);

    db.tenant.updateMany({ where: { id: TENANT }, data: { autoReply: null } });
    const config = await service.getConfig(TENANT);
    expect(config.enabled).toBe(false);
  });
});
