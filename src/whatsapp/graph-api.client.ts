import { Injectable, Logger } from '@nestjs/common';
import type { WhatsappAccount } from '@prisma/client';
import { EncryptionService } from '../crypto/encryption.service';
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
