import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma, Tenant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AUTO_REPLY_COOLDOWN_MS,
  AutoReplyConfig,
  isOpenAt,
  parseAutoReplyConfig,
} from './auto-reply';
import { SendMessageService } from './send-message.service';

/**
 * Auto-respuesta fuera de horario. El disparo vive en el worker de
 * entrantes (best-effort: jamás rompe el procesamiento del webhook) y el
 * envío reusa el pipeline real de salida — la auto-respuesta es un mensaje
 * más, con tildes, ventana y errores de Meta como cualquier otro.
 */

const EMPTY_CONFIG: AutoReplyConfig = { enabled: false, message: '', schedule: {} };

@Injectable()
export class AutoReplyService {
  private readonly logger = new Logger(AutoReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sendMessage: SendMessageService,
  ) {}

  /** Config del tenant (para Ajustes). Inválida/ausente → default apagado. */
  async getConfig(tenantId: string): Promise<AutoReplyConfig> {
    const tenant = (await this.prisma.db.tenant.findUnique({
      where: { id: tenantId },
    })) as Tenant | null;
    const parsed = parseAutoReplyConfig(tenant?.autoReply ?? {});
    return parsed.ok ? parsed.config : EMPTY_CONFIG;
  }

  /** PUT de Ajustes: valida estricto y persiste normalizado. */
  async updateConfig(tenantId: string, raw: unknown): Promise<AutoReplyConfig> {
    const parsed = parseAutoReplyConfig(raw ?? {});
    if (!parsed.ok) {
      throw new BadRequestException(`Configuración inválida: ${parsed.problems.join('; ')}`);
    }
    await this.prisma.db.tenant.update({
      where: { id: tenantId },
      data: { autoReply: parsed.config as unknown as Prisma.InputJsonValue },
    });
    return parsed.config;
  }

  /**
   * Llamado tras persistir un entrante. Envía la auto-respuesta si:
   * habilitada + fuera de horario (timezone del tenant) + cooldown de 6h
   * libre. El claim del cooldown es un updateMany condicional ANTES del
   * envío: dos mensajes concurrentes no producen dos respuestas.
   */
  async maybeReply(tenantId: string, conversationId: string, now: Date = new Date()): Promise<void> {
    const db = this.prisma.db;
    const tenant = (await db.tenant.findUnique({ where: { id: tenantId } })) as Tenant | null;
    if (!tenant?.autoReply) return;
    const parsed = parseAutoReplyConfig(tenant.autoReply);
    if (!parsed.ok || !parsed.config.enabled || !parsed.config.message) return;

    if (isOpenAt(parsed.config.schedule, now, tenant.timezone)) return; // abierto: humanos

    const cooldownFloor = new Date(now.getTime() - AUTO_REPLY_COOLDOWN_MS);
    const claimed = await db.conversation.updateMany({
      where: {
        id: conversationId,
        tenantId,
        OR: [{ lastAutoReplyAt: null }, { lastAutoReplyAt: { lt: cooldownFloor } }],
      },
      data: { lastAutoReplyAt: now },
    });
    if (claimed.count === 0) return; // ya respondimos hace poco (o ganó otro job)

    const outcome = await this.sendMessage.send(
      tenantId,
      conversationId,
      {
        clientDedupKey: `auto-reply-${conversationId}-${now.getTime()}`,
        type: 'text',
        body: parsed.config.message,
        isAutoReply: true,
      },
      null, // sentByUserId: nadie — es el sistema
    );
    if (outcome.error) {
      // El cooldown queda consumido a propósito: mejor perder una
      // auto-respuesta que arriesgar dobles en cascada de reintentos.
      this.logger.warn(
        `Auto-respuesta falló (${conversationId}): ${outcome.error.code} ${outcome.error.message}`,
      );
    }
  }
}
