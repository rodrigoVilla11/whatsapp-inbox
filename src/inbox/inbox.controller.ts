import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { MinRole, roleAtLeast, RolesGuard } from '../auth/roles';
import { GourmetifyOrdersService } from '../gourmetify/orders.service';
import { AutoReplyService } from '../messaging/auto-reply.service';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantContext } from '../tenant/tenant-context';
import { ConversationListFilter, ConversationsService } from './conversations.service';
import { QuickRepliesService } from './quick-replies.service';

/**
 * Endpoints REST del inbox — sesión obligatoria (SessionAuthMiddleware en
 * el módulo) + matriz de roles donde aplica. La identidad (/auth/me) y la
 * gestión de usuarios (/users) viven en el AuthModule.
 */
@Controller()
@UseGuards(RolesGuard)
export class InboxController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly quickReplies: QuickRepliesService,
    private readonly orders: GourmetifyOrdersService,
    private readonly autoReply: AutoReplyService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Auto-respuesta fuera de horario (config del tenant, ADMIN+) ────────

  @Get('settings/auto-reply')
  @MinRole('ADMIN')
  async getAutoReply(@Req() req: Request): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.autoReply.getConfig(tenantId);
  }

  @Put('settings/auto-reply')
  @MinRole('ADMIN')
  async updateAutoReply(@Body() body: unknown, @Req() req: Request): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.autoReply.updateConfig(tenantId, body);
  }

  /** Pedidos de Gourmetify del contacto: activos + últimos 3 cerrados. */
  @Get('conversations/:id/orders')
  async conversationOrders(
    @Param('id') conversationId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.orders.listForConversation(tenantId, conversationId);
  }

  @Get('conversations')
  async list(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('assignedToMe') assignedToMe?: string,
    @Query('cursor') cursor?: string,
    @Query('q') q?: string,
  ): Promise<unknown> {
    const { tenantId, userId } = getTenantContext(req);
    const filter: ConversationListFilter =
      status === 'all' || status === 'closed' ? status : 'open';
    return this.conversations.list(tenantId, userId, {
      filter,
      assignedToMe: assignedToMe === 'true',
      cursor,
      q,
    });
  }

  /**
   * Deep-link de Gourmetify (ex wa.me): abre/crea la conversación del
   * teléfono y la devuelve. Cualquier rol con sesión.
   */
  @Post('conversations/open-by-phone')
  async openByPhone(
    @Body() body: { phone?: string },
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    if (typeof body?.phone !== 'string' || !body.phone.trim()) {
      throw new BadRequestException('Falta el teléfono');
    }
    return { conversation: await this.conversations.openByPhone(tenantId, body.phone) };
  }

  /** SOLO notes: el resto del contacto lo escribe el webhook, no la UI. */
  @Patch('contacts/:id')
  async updateContactNotes(
    @Param('id') contactId: string,
    @Body() body: { notes?: string | null },
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    const notes = body?.notes ?? null;
    if (notes !== null && typeof notes !== 'string') {
      throw new BadRequestException('notes debe ser string o null');
    }
    if (typeof notes === 'string' && notes.length > 5000) {
      throw new BadRequestException('notes supera el máximo de 5000 caracteres');
    }
    return { contact: await this.conversations.updateContactNotes(tenantId, contactId, notes) };
  }

  @Get('conversations/:id/messages')
  async messages(
    @Param('id') conversationId: string,
    @Req() req: Request,
    @Query('cursor') cursor?: string,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.conversations.listMessages(tenantId, conversationId, cursor);
  }

  @Post('conversations/:id/read')
  async markRead(@Param('id') conversationId: string, @Req() req: Request): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return { conversation: await this.conversations.markRead(tenantId, conversationId) };
  }

  /** "Vuelvo a esto después": deja la conversación como no leída. */
  @Post('conversations/:id/unread')
  async markUnread(@Param('id') conversationId: string, @Req() req: Request): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return { conversation: await this.conversations.markUnread(tenantId, conversationId) };
  }

  /** Matriz: AGENT solo se asigna/libera a sí mismo; ADMIN+ asigna a otros. */
  @Post('conversations/:id/assign')
  async assign(
    @Param('id') conversationId: string,
    @Body() body: { userId?: string | null },
    @Req() req: Request,
  ): Promise<unknown> {
    const context = getTenantContext(req);
    const userId = body?.userId ?? null;
    if (userId !== null && typeof userId !== 'string') {
      throw new BadRequestException('userId debe ser string o null');
    }
    if (!roleAtLeast(context.role, 'ADMIN') && userId !== null && userId !== context.userId) {
      throw new ForbiddenException(
        'Para asignarle una conversación a otra persona necesitás rol ADMIN',
      );
    }
    return {
      conversation: await this.conversations.assign(context.tenantId, conversationId, userId),
    };
  }

  @Post('conversations/:id/status')
  async setStatus(
    @Param('id') conversationId: string,
    @Body() body: { status?: string },
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    if (body?.status !== 'OPEN' && body?.status !== 'CLOSED') {
      throw new BadRequestException("status debe ser 'OPEN' o 'CLOSED'");
    }
    return {
      conversation: await this.conversations.setStatus(tenantId, conversationId, body.status),
    };
  }

  /** Solo APPROVED: es el picker de envío, no un admin de plantillas. */
  @Get('templates')
  async templates(@Req() req: Request): Promise<unknown[]> {
    const { tenantId } = getTenantContext(req);
    const rows = await this.prisma.db.messageTemplate.findMany({
      where: { tenantId, status: 'APPROVED' },
      orderBy: [{ name: 'asc' }],
    });
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      bodyText: t.bodyText,
      variableCount: t.variableCount,
    }));
  }

  // ── Quick replies ─────────────────────────────────────────────────────

  @Get('quick-replies')
  async listQuickReplies(
    @Req() req: Request,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<unknown[]> {
    const { tenantId } = getTenantContext(req);
    return this.quickReplies.list(tenantId, includeInactive === 'true');
  }

  @Post('quick-replies')
  @MinRole('ADMIN')
  async createQuickReply(
    @Body() body: { shortcut?: string; title?: string; body?: string },
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.quickReplies.create(tenantId, {
      shortcut: body?.shortcut ?? '',
      title: body?.title ?? '',
      body: body?.body ?? '',
    });
  }

  @Patch('quick-replies/:id')
  @MinRole('ADMIN')
  async updateQuickReply(
    @Param('id') id: string,
    @Body()
    body: {
      shortcut?: string;
      title?: string;
      body?: string;
      isActive?: boolean;
      isFavorite?: boolean;
    },
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.quickReplies.update(tenantId, id, body ?? {});
  }

  @Delete('quick-replies/:id')
  @MinRole('ADMIN')
  async deleteQuickReply(@Param('id') id: string, @Req() req: Request): Promise<{ ok: true }> {
    const { tenantId } = getTenantContext(req);
    await this.quickReplies.deactivate(tenantId, id);
    return { ok: true };
  }
}
