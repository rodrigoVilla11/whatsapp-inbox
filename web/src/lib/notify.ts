'use client';

import { usePrefs } from './prefs';
import { useInbox } from './store';
import type { MessageCreatedEvent } from './types';

/**
 * Notificaciones de mensaje entrante:
 * - sonido corto por WebAudio (sin asset), respetando autoplay policies:
 *   el AudioContext se crea recién en la primera interacción del usuario;
 * - Notification API SOLO con la pestaña sin foco y permiso ya otorgado
 *   (el permiso se pide desde Ajustes, nunca de sorpresa).
 * El badge del título de pestaña vive en InboxShell (deriva del store).
 */

let audioCtx: AudioContext | null = null;
let navigate: ((conversationId: string) => void) | null = null;

function ensureAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audioCtx ??= new Ctor();
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

/** Blip de dos notas, ganancia baja — se oye en el mostrador, no asusta. */
export function playIncomingSound(): void {
  const ctx = ensureAudio();
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.06, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(740, t0);
  osc.frequency.setValueAtTime(988, t0 + 0.08);
  osc.connect(gain);
  osc.start(t0);
  osc.stop(t0 + 0.25);
}

/**
 * Se llama una vez desde InboxShell. Desbloquea el audio en la primera
 * interacción y registra cómo navegar al click de una notificación.
 */
export function initNotifications(nav: (conversationId: string) => void): () => void {
  navigate = nav;
  if (typeof window === 'undefined') return () => undefined;
  const unlock = (): void => {
    ensureAudio();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    navigate = null;
  };
}

function previewOf(event: MessageCreatedEvent): string {
  const m = event.message;
  if (m.body) return m.body;
  switch (m.type) {
    case 'IMAGE':
    case 'STICKER':
      return '📷 Foto';
    case 'VIDEO':
      return '🎬 Video';
    case 'AUDIO':
      return '🎧 Audio';
    case 'DOCUMENT':
      return '📄 Documento';
    default:
      return 'Mensaje nuevo';
  }
}

/** Hook del socket: mensaje ENTRANTE recién llegado. */
export function notifyInbound(event: MessageCreatedEvent): void {
  const { prefs } = usePrefs.getState();
  if (prefs.sound) playIncomingSound();

  if (
    prefs.nativeNotifications &&
    typeof document !== 'undefined' &&
    document.hidden &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    const conversation = useInbox
      .getState()
      .conversations.find((c) => c.id === event.conversationId);
    const title =
      conversation?.contact?.profileName ??
      conversation?.contact?.phoneE164 ??
      'Mensaje nuevo';
    // tag por conversación: N mensajes seguidos no apilan N notificaciones
    const notification = new Notification(title, {
      body: previewOf(event),
      tag: `inbox-${event.conversationId}`,
    });
    notification.onclick = () => {
      window.focus();
      navigate?.(event.conversationId);
      notification.close();
    };
  }
}
