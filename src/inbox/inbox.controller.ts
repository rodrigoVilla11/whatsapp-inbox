import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantContext } from '../tenant/tenant-context.middleware';
import { ConversationListFilter, ConversationsService } from './conversations.service';
import { QuickRepliesService } from './quick-replies.service';

/** Endpoints REST del inbox (todo scopeado por tenant vía middleware). */
@Controller()
export class InboxController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly quickReplies: QuickRepliesService,
    private readonly prisma: PrismaService,
  ) {}

  /** Identidad efectiva del middleware provisional (la UI la necesita para "Mías"/asignarme). */
  @Get('me')
  async me(@Req() req: Request): Promise<unknown> {
    const { tenantId, userId } = getTenantContext(req);
    const tenant = await this.prisma.db.tenant.findUnique({ where: { id: tenantId } });
    return {
      tenantId,
      userId,
      tenantName: tenant?.name ?? null,
      timezone: tenant?.timezone ?? 'UTC',
    };
  }

  @Get('conversations')
  async list(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('assignedToMe') assignedToMe?: string,
    @Query('cursor') cursor?: string,
  ): Promise<unknown> {
    const { tenantId, userId } = getTenantContext(req);
    const filter: ConversationListFilter =
      status === 'all' || status === 'closed' ? status : 'open';
    return this.conversations.list(tenantId, userId, {
      filter,
      assignedToMe: assignedToMe === 'true',
      cursor,
    });
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

  @Post('conversations/:id/assign')
  async assign(
    @Param('id') conversationId: string,
    @Body() body: { userId?: string | null },
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    const userId = body?.userId ?? null;
    if (userId !== null && typeof userId !== 'string') {
      throw new BadRequestException('userId debe ser string o null');
    }
    return { conversation: await this.conversations.assign(tenantId, conversationId, userId) };
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
  async updateQuickReply(
    @Param('id') id: string,
    @Body() body: { shortcut?: string; title?: string; body?: string; isActive?: boolean },
    @Req() req: Request,
  ): Promise<unknown> {
    const { tenantId } = getTenantContext(req);
    return this.quickReplies.update(tenantId, id, body ?? {});
  }

  @Delete('quick-replies/:id')
  async deleteQuickReply(@Param('id') id: string, @Req() req: Request): Promise<{ ok: true }> {
    const { tenantId } = getTenantContext(req);
    await this.quickReplies.deactivate(tenantId, id);
    return { ok: true };
  }
}
