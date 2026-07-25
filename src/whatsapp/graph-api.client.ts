import { Injectable, Logger } from '@nestjs/common';
import type { WhatsappAccount } from '@prisma/client';
import { EncryptionService } from '../crypto/encryption.service';
import { MediaTooLargeError } from '../media/media-limits';
import { GRAPH_API_VERSION, graphApiBaseUrl } from './graph-api.constants';

/** Cuerpo de error estándar de Graph API. */
export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
  fbtrace_id?: string;
}

export class GraphApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly meta: MetaErrorBody | undefined,
  ) {
    super(meta?.message ?? `Graph API respondió ${httpStatus}`);
    this.name = 'GraphApiError';
  }

  get code(): number | null {
    return this.meta?.code ?? null;
  }

  get details(): string | null {
    return this.meta?.error_data?.details ?? this.meta?.message ?? null;
  }
}

export interface GraphSendResult {
  wamid: string | null;
}

export interface MetaTemplateDefinition {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
}

const REQUEST_TIMEOUT_MS = 10_000; // el request de la cajera no puede colgarse

/**
 * Cliente HTTP de Graph API. El access token se descifra de la cuenta en
 * cada llamada (solo vive en memoria) y la versión sale SIEMPRE de
 * GRAPH_API_VERSION — ninguna URL se arma a mano fuera de acá.
 */
@Injectable()
export class GraphApiClient {
  private readonly logger = new Logger(GraphApiClient.name);

  constructor(private readonly encryption: EncryptionService) {}

  private baseUrl(account: WhatsappAccount & { metaApp?: { graphVersion?: string | null } }): string {
    return graphApiBaseUrl(account.metaApp?.graphVersion ?? GRAPH_API_VERSION);
  }

  private async request<T>(
    account: WhatsappAccount,
    path: string,
    init: { method: string; body?: object },
  ): Promise<T> {
    const token = this.encryption.decrypt(account.accessTokenEnc);
    const response = await fetch(`${this.baseUrl(account)}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: MetaErrorBody; [key: string]: unknown }
      | null;

    if (!response.ok) {
      throw new GraphApiError(response.status, body?.error);
    }
    return body as T;
  }

  /** POST /{version}/{phoneNumberId}/messages */
  async sendMessage(account: WhatsappAccount, payload: object): Promise<GraphSendResult> {
    const body = await this.request<{ messages?: Array<{ id?: string }> }>(
      account,
      `/${account.phoneNumberId}/messages`,
      { method: 'POST', body: { messaging_product: 'whatsapp', ...payload } },
    );
    return { wamid: body?.messages?.[0]?.id ?? null };
  }

  /**
   * Marca un mensaje entrante como leído (tildes azules del cliente).
   * Best-effort desde el caller: cortesía, no funcionalidad crítica.
   */
  async markMessageRead(account: WhatsappAccount, wamid: string): Promise<void> {
    await this.request(account, `/${account.phoneNumberId}/messages`, {
      method: 'POST',
      body: { status: 'read', message_id: wamid },
    });
  }

  /**
   * GET /{version}/{mediaId} → metadata + URL temporal de descarga.
   * La URL expira en minutos: SIEMPRE se pide fresca en el mismo job que
   * descarga, jamás se persiste.
   */
  async getMediaInfo(
    account: WhatsappAccount,
    mediaId: string,
  ): Promise<{ url: string | null; mimeType: string | null; sha256: string | null; fileSizeBytes: number | null }> {
    const body = await this.request<{
      url?: string;
      mime_type?: string;
      sha256?: string;
      file_size?: number;
    }>(account, `/${mediaId}`, { method: 'GET' });
    return {
      url: body?.url ?? null,
      mimeType: body?.mime_type ?? null,
      sha256: body?.sha256 ?? null,
      fileSizeBytes: body?.file_size ?? null,
    };
  }

  /**
   * Descarga el binario desde la URL temporal (host lookaside, no Graph),
   * también con Bearer. Corta ANTES de bufferear si Content-Length excede
   * el techo, y re-verifica sobre los bytes reales.
   */
  async downloadMediaBinary(
    account: WhatsappAccount,
    url: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const token = this.encryption.decrypt(account.accessTokenEnc);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      // 404 típico = URL expirada; el reintento del job pide una fresca.
      throw new GraphApiError(response.status, undefined);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new MediaTooLargeError(declared, maxBytes);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new MediaTooLargeError(buffer.length, maxBytes);
    }
    return buffer;
  }

  /**
   * POST /{version}/{phoneNumberId}/media (multipart) → media_id de Meta.
   * El media_id expira a los ~30 días: NO se persiste como reutilizable,
   * se sube por envío.
   */
  async uploadMedia(
    account: WhatsappAccount,
    buffer: Buffer,
    contentType: string,
    filename: string,
  ): Promise<string> {
    const token = this.encryption.decrypt(account.accessTokenEnc);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', contentType);
    form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), filename);

    const response = await fetch(`${this.baseUrl(account)}/${account.phoneNumberId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json().catch(() => null)) as
      | { error?: MetaErrorBody; id?: string }
      | null;
    if (!response.ok) throw new GraphApiError(response.status, body?.error);
    if (!body?.id) throw new GraphApiError(response.status, { message: 'upload sin id' });
    return body.id;
  }

  /** GET /{version}/{wabaId}/message_templates — paginado completo. */
  async listTemplates(account: WhatsappAccount): Promise<MetaTemplateDefinition[]> {
    const token = this.encryption.decrypt(account.accessTokenEnc);
    const all: MetaTemplateDefinition[] = [];
    let url: string | null =
      `${this.baseUrl(account)}/${account.wabaId}/message_templates` +
      `?fields=id,name,language,status,category,components&limit=100`;

    while (url) {
      const response: Response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: MetaErrorBody;
        data?: MetaTemplateDefinition[];
        paging?: { next?: string };
      } | null;
      if (!response.ok) throw new GraphApiError(response.status, body?.error ?? undefined);
      all.push(...(body?.data ?? []));
      url = body?.paging?.next ?? null;
    }
    this.logger.log(`listTemplates(${account.wabaId}): ${all.length} plantillas`);
    return all;
  }
}
