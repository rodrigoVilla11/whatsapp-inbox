import type { Conversation, Message } from './types';

/**
 * Lógica PURA de merge del estado con los eventos WS (contrato fase 6).
 * Sin React ni zustand acá: es lo que se testea.
 */

function messageOrder(a: Message, b: Message): number {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  if (ta !== tb) return ta - tb; // ascendente: el hilo se lee de arriba a abajo
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortMessages(list: Message[]): Message[] {
  return [...list].sort(messageOrder);
}

/**
 * message.created / respuesta del POST propio → upsert con dedup:
 * 1. por id (el evento WS del mensaje que ya llegó por REST, o viceversa);
 * 2. por clientDedupKey (la copia del servidor reemplaza al optimista local).
 * La copia entrante es la autoritativa; los flags _local se limpian.
 */
export function upsertMessage(list: Message[], incoming: Message): Message[] {
  const cleaned: Message = { ...incoming };
  delete cleaned._local;

  const byId = list.findIndex((m) => m.id === incoming.id);
  if (byId >= 0) {
    const merged = list.map((m, i) => (i === byId ? { ...m, ...cleaned, _local: undefined } : m));
    return sortMessages(merged);
  }
  if (incoming.clientDedupKey) {
    const byKey = list.findIndex((m) => m.clientDedupKey === incoming.clientDedupKey);
    if (byKey >= 0) {
      const merged = list.map((m, i) =>
        i === byKey ? { ...m, ...cleaned, id: incoming.id, _local: undefined } : m,
      );
      return sortMessages(merged);
    }
  }
  return sortMessages([...list, cleaned]);
}

/** message.updated → merge de `changes` sobre el mensaje existente. */
export function applyMessageChanges(
  list: Message[],
  id: string,
  changes: Partial<Message>,
): Message[] {
  if (!list.some((m) => m.id === id)) return list;
  return list.map((m) => (m.id === id ? { ...m, ...changes } : m));
}

function conversationOrder(a: Conversation, b: Conversation): number {
  // Los ANCLADOS van arriba de todo (mismo criterio que el listado del
  // servidor). Sin esto, un conversation.updated por WS reordenaría por
  // fecha y el anclado se caería de la punta.
  const pa = a.pinnedAt ? Date.parse(a.pinnedAt) : null;
  const pb = b.pinnedAt ? Date.parse(b.pinnedAt) : null;
  if (pa !== null || pb !== null) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pa !== pb) return pb - pa; // el último anclado, primero
    return a.id < b.id ? 1 : -1;
  }

  const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : null;
  const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : null;
  if (ta === null && tb === null) return a.id < b.id ? 1 : -1;
  if (ta === null) return 1; // sin mensajes al final
  if (tb === null) return -1;
  if (ta !== tb) return tb - ta; // descendente
  return a.id < b.id ? 1 : -1;
}

export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort(conversationOrder);
}

/**
 * conversation.updated → REEMPLAZO de la fila (el server manda el estado
 * completo), preservando el contact embebido que el evento WS no trae.
 */
export function upsertConversation(list: Conversation[], incoming: Conversation): Conversation[] {
  const existing = list.find((c) => c.id === incoming.id);
  const merged: Conversation = {
    ...incoming,
    contact: incoming.contact ?? existing?.contact ?? null,
    // hasActiveOrder/activeOrderNumber solo viajan en el listado REST: los
    // eventos WS no los traen y no deben apagarlos.
    hasActiveOrder: incoming.hasActiveOrder ?? existing?.hasActiveOrder,
    activeOrderNumber: incoming.activeOrderNumber ?? existing?.activeOrderNumber,
    // Igual con las etiquetas: solo el evento de cambio de etiquetas las
    // trae. Un assign o un mark-read no debe vaciar los chips de la fila.
    tags: incoming.tags ?? existing?.tags,
  };
  const rest = list.filter((c) => c.id !== incoming.id);
  return sortConversations([...rest, merged]);
}
