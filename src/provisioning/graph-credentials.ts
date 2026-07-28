import { graphApiBaseUrl } from '../whatsapp/graph-api.constants';

/**
 * Validación EN VIVO de credenciales antes de persistirlas: un token
 * vencido/mal scopeado o un phone_number_id ajeno se rechazan al cargar,
 * no en el primer envío de la cajera. Inyectable para testear sin Meta.
 */

export const GRAPH_CREDENTIALS_CHECK = Symbol('GRAPH_CREDENTIALS_CHECK');

export type GraphCredentialsResult =
  | { ok: true; displayPhoneNumber: string | null; verifiedName: string | null }
  | { ok: false; reason: string };

export type GraphCredentialsCheck = (
  phoneNumberId: string,
  accessToken: string,
) => Promise<GraphCredentialsResult>;

const CHECK_TIMEOUT_MS = 10_000;

export const checkGraphCredentials: GraphCredentialsCheck = async (phoneNumberId, accessToken) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${graphApiBaseUrl()}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
      { headers: { authorization: `Bearer ${accessToken}` }, signal: controller.signal },
    );
    const body = (await res.json().catch(() => ({}))) as {
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      // el mensaje de Meta es accionable ("Invalid OAuth access token", etc.)
      return { ok: false, reason: body.error?.message ?? `Meta respondió ${res.status}` };
    }
    return {
      ok: true,
      displayPhoneNumber: body.display_phone_number ?? null,
      verifiedName: body.verified_name ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'Meta no respondió a tiempo — probá de nuevo'
          : `No se pudo llegar a Meta: ${String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
};
