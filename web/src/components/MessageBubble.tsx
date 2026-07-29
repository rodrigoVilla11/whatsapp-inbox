'use client';

import { api } from '@/lib/api';
import { formatBytes, formatTime } from '@/lib/format';
import { useInbox } from '@/lib/store';
import { toast } from '@/lib/toast';
import type { Message } from '@/lib/types';
import { usePending } from '@/lib/use-pending';

/**
 * Transcripción bajo demanda del audio entrante: un tap y se lee en vez de
 * escuchar. Una vez transcripto queda para siempre (cache server-side).
 */
function AudioTranscription({ message }: { message: Message }) {
  const enabled = useInbox((s) => s.me?.features.transcription ?? false);
  const { pending, run } = usePending();

  if (message.transcription) {
    return (
      <p className="mt-1.5 border-l-2 border-nori/40 pl-2 text-sm italic text-sumi/80">
        {message.transcription}
      </p>
    );
  }
  if (!enabled || message.direction !== 'INBOUND' || message.mediaStatus !== 'DOWNLOADED') {
    return null;
  }
  return (
    <button
      onClick={() =>
        run(async () => {
          try {
            const { message: updated } = await api.transcribe(message.id);
            // aplicar ya (el message.updated del WS confirma para el resto)
            useInbox.getState().onMessageUpdated({
              id: message.id,
              conversationId: message.conversationId,
              changes: { transcription: updated.transcription },
            });
          } catch (error) {
            toast(error instanceof Error ? error.message : 'No se pudo transcribir');
          }
        })
      }
      disabled={pending}
      className="mt-1 min-h-10 rounded-lg px-2 text-xs font-medium text-nori hover:bg-nori-soft disabled:opacity-50"
    >
      {pending ? 'Transcribiendo…' : '✎ Transcribir'}
    </button>
  );
}

/** Tildes de estado: reloj PENDING, ✓ SENT, ✓✓ DELIVERED, ✓✓ azul READ, ⚠ FAILED. */
function Ticks({ message }: { message: Message }) {
  if (message.direction !== 'OUTBOUND') return null;
  const base = 'ml-1 inline-block text-[13px] leading-none align-middle';
  switch (message.status) {
    case 'PENDING':
      return (
        <span className={`${base} text-rice/60`} aria-label="Enviando" title="Enviando">
          🕐
        </span>
      );
    case 'SENT':
      return (
        <span className={`${base} text-rice/70`} aria-label="Enviado">
          ✓
        </span>
      );
    case 'DELIVERED':
      return (
        <span className={`${base} text-rice/70`} aria-label="Entregado">
          ✓✓
        </span>
      );
    case 'READ':
      // la convención azul de WhatsApp — la cajera ya la sabe leer
      return (
        <span className={`${base} font-bold text-sky-300`} aria-label="Leído">
          ✓✓
        </span>
      );
    case 'FAILED':
      return (
        <span className={`${base} text-gari`} aria-label="Falló">
          ⚠
        </span>
      );
  }
}

function Media({ message, outbound }: { message: Message; outbound: boolean }) {
  if (message.mediaStatus === 'PENDING') {
    return (
      <div className="flex h-32 w-48 animate-pulse items-center justify-center rounded-xl bg-piedra-soft text-xs text-piedra">
        {/* Saliente el archivo SUBE; sólo lo entrante se descarga de Meta. */}
        {outbound ? 'Subiendo…' : 'Descargando…'}
      </div>
    );
  }
  if (message.mediaStatus === 'FAILED') {
    return (
      <div className="flex h-20 w-48 items-center justify-center rounded-xl bg-piedra-soft text-xs text-piedra">
        Archivo no disponible
      </div>
    );
  }
  const url = api.mediaUrl(message.id); // 302 → URL firmada; el tag sigue el redirect
  if (message.type === 'IMAGE' || message.type === 'STICKER') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={message.body ?? 'Imagen recibida'}
        className="max-h-64 max-w-full rounded-xl object-cover"
        loading="lazy"
      />
    );
  }
  if (message.type === 'AUDIO') {
    return (
      <div>
        <audio controls src={url} className="max-w-full" aria-label="Audio" />
        <AudioTranscription message={message} />
      </div>
    );
  }
  if (message.type === 'VIDEO') {
    return <video controls src={url} className="max-h-64 max-w-full rounded-xl" />;
  }
  // Documento: tarjeta con nombre + tamaño + descarga
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={`flex min-h-12 items-center gap-2 rounded-xl px-3 py-2 text-sm ${
        outbound ? 'bg-white/10 hover:bg-white/20' : 'bg-sumi/5 hover:bg-sumi/10'
      }`}
    >
      <span aria-hidden>📄</span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{message.mediaFilename ?? 'Documento'}</span>
        <span className={`text-xs ${outbound ? 'text-rice/70' : 'text-piedra'}`}>
          {formatBytes(message.mediaSizeBytes)}
        </span>
      </span>
      <span
        className={`ml-auto text-xs font-medium ${outbound ? 'text-rice underline' : 'text-nori'}`}
      >
        Descargar
      </span>
    </a>
  );
}

/**
 * `last`: última burbuja de un grupo de consecutivas del mismo autor —
 * solo ella lleva hora + tildes y la esquina "cola" (9b).
 */
export function MessageBubble({
  message,
  quoted,
  reactions,
  last = true,
}: {
  message: Message;
  quoted?: Message | null;
  reactions?: string[];
  last?: boolean;
}) {
  const timezone = useInbox((s) => s.timezone);
  const retrySend = useInbox((s) => s.retrySend);
  const users = useInbox((s) => s.users);
  const uploadProgress = useInbox((s) =>
    message.clientDedupKey ? s.uploadProgress[message.clientDedupKey] : undefined,
  );
  const outbound = message.direction === 'OUTBOUND';
  // Quién respondió (sentByUserId sale de la sesión real desde fase 8) —
  // importa cuando atienden varios: la cajera y el dueño se distinguen.
  const senderName =
    outbound && message.sentByUserId
      ? (users.find((u) => u.id === message.sentByUserId)?.name ?? null)
      : null;
  const hasMedia = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER'].includes(message.type);
  const hasReactions = !!reactions && reactions.length > 0;

  const corners = outbound
    ? last
      ? 'rounded-2xl rounded-br-sm'
      : 'rounded-2xl'
    : last
      ? 'rounded-2xl rounded-bl-sm'
      : 'rounded-2xl';

  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`relative max-w-[80%] px-3 py-2 shadow-sm md:max-w-[65%] ${corners} ${
          outbound ? 'bg-nori text-rice' : 'border border-line bg-rice text-sumi'
        } ${hasReactions ? 'mb-3' : ''}`}
      >
        {quoted && (
          <div
            className={`mb-1 rounded-lg border-l-4 px-2 py-1 text-xs ${
              outbound
                ? 'border-rice/40 bg-white/10 text-rice/80'
                : 'border-nori/50 bg-sumi/5 text-sumi/70'
            }`}
          >
            <span className="line-clamp-2">{quoted.body ?? `[${quoted.type.toLowerCase()}]`}</span>
          </div>
        )}

        {hasMedia && <Media message={message} outbound={outbound} />}

        {message.body && (
          <p className="whitespace-pre-wrap wrap-break-word text-[15px]">{message.body}</p>
        )}
        {message.type === 'TEMPLATE' && (
          <p className={`mt-0.5 text-[11px] ${outbound ? 'text-rice/60' : 'text-piedra'}`}>
            Plantilla: {message.templateName}
          </p>
        )}

        {typeof uploadProgress === 'number' && (
          <div
            role="progressbar"
            aria-valuenow={uploadProgress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Subiendo archivo"
            className={`mt-1 h-1.5 w-full overflow-hidden rounded ${outbound ? 'bg-white/20' : 'bg-piedra-soft'}`}
          >
            <div
              className={`h-full transition-all ${outbound ? 'bg-rice' : 'bg-nori'}`}
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        )}

        {last && (
          <div
            className={`tnum mt-0.5 flex items-center justify-end gap-1 font-mono text-[11px] ${
              outbound ? 'text-rice/70' : 'text-piedra'
            }`}
          >
            {message.isAutoReply && <span className="font-sans">Automática ·</span>}
            {senderName && <span className="truncate font-sans">{senderName} ·</span>}
            <span>{formatTime(message.timestamp, timezone)}</span>
            <Ticks message={message} />
          </div>
        )}

        {/* FAILED: userMessage del dominio (nunca el código crudo) + reintentar */}
        {message.status === 'FAILED' && outbound && (
          <div className="mt-1 rounded-xl bg-gari-soft px-2 py-1.5">
            <p className="text-xs font-medium text-gari-ink">
              {message._local === 'failed-network'
                ? 'Sin conexión con el servidor. Reintentá.'
                : (message.errorDetail ?? message.errorTitle ?? 'No se pudo enviar el mensaje.')}
            </p>
            {/* Media no se puede reintentar: el File ya no está en memoria y
                retrySend reenviaría sólo el caption como texto. Se adjunta
                de nuevo, y se dice así. */}
            {hasMedia ? (
              <p className="mt-1 text-xs text-gari-ink/80">Adjuntá el archivo de nuevo.</p>
            ) : (
              <button
                onClick={() => void retrySend(message)}
                className="mt-1 min-h-10 rounded-lg bg-gari px-3 text-xs font-semibold text-white hover:bg-gari-ink"
              >
                Reintentar
              </button>
            )}
          </div>
        )}

        {hasReactions && (
          <div className="absolute -bottom-3 right-2 rounded-full border border-line bg-rice px-1.5 py-0.5 text-sm text-sumi shadow-sm">
            {reactions.join(' ')}
          </div>
        )}
      </div>
    </div>
  );
}
