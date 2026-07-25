'use client';

import { api } from '@/lib/api';
import { formatBytes, formatTime } from '@/lib/format';
import { useInbox } from '@/lib/store';
import type { Message } from '@/lib/types';

/** Tildes de estado: reloj PENDING, ✓ SENT, ✓✓ DELIVERED, ✓✓ azul READ, ⚠ FAILED. */
function Ticks({ message }: { message: Message }) {
  if (message.direction !== 'OUTBOUND') return null;
  const base = 'ml-1 inline-block text-[13px] leading-none align-middle';
  switch (message.status) {
    case 'PENDING':
      return (
        <span className={`${base} text-stone-400`} aria-label="Enviando" title="Enviando">
          🕐
        </span>
      );
    case 'SENT':
      return (
        <span className={`${base} text-stone-500`} aria-label="Enviado">
          ✓
        </span>
      );
    case 'DELIVERED':
      return (
        <span className={`${base} text-stone-500`} aria-label="Entregado">
          ✓✓
        </span>
      );
    case 'READ':
      return (
        <span className={`${base} font-bold text-sky-500`} aria-label="Leído">
          ✓✓
        </span>
      );
    case 'FAILED':
      return (
        <span className={`${base} text-red-600`} aria-label="Falló">
          ⚠
        </span>
      );
  }
}

function Media({ message }: { message: Message }) {
  if (message.mediaStatus === 'PENDING') {
    return (
      <div className="flex h-32 w-48 animate-pulse items-center justify-center rounded-lg bg-stone-200 text-xs text-stone-500">
        Descargando…
      </div>
    );
  }
  if (message.mediaStatus === 'FAILED') {
    return (
      <div className="flex h-20 w-48 items-center justify-center rounded-lg bg-stone-100 text-xs text-stone-500">
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
        className="max-h-64 max-w-full rounded-lg object-cover"
        loading="lazy"
      />
    );
  }
  if (message.type === 'AUDIO') {
    return <audio controls src={url} className="max-w-full" aria-label="Audio" />;
  }
  if (message.type === 'VIDEO') {
    return <video controls src={url} className="max-h-64 max-w-full rounded-lg" />;
  }
  // Documento: tarjeta con nombre + tamaño + descarga
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex min-h-12 items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-sm hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
    >
      <span aria-hidden>📄</span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{message.mediaFilename ?? 'Documento'}</span>
        <span className="text-xs text-stone-500">{formatBytes(message.mediaSizeBytes)}</span>
      </span>
      <span className="ml-auto text-xs font-medium text-emerald-700">Descargar</span>
    </a>
  );
}

export function MessageBubble({
  message,
  quoted,
  reactions,
}: {
  message: Message;
  quoted?: Message | null;
  reactions?: string[];
}) {
  const timezone = useInbox((s) => s.timezone);
  const retrySend = useInbox((s) => s.retrySend);
  const uploadProgress = useInbox((s) =>
    message.clientDedupKey ? s.uploadProgress[message.clientDedupKey] : undefined,
  );
  const outbound = message.direction === 'OUTBOUND';
  const hasMedia = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER'].includes(message.type);

  return (
    <div className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`relative max-w-[80%] rounded-2xl px-3 py-2 shadow-sm md:max-w-[65%] ${
          outbound ? 'rounded-br-sm bg-emerald-100' : 'rounded-bl-sm bg-white'
        }`}
      >
        {quoted && (
          <div className="mb-1 rounded-lg border-l-4 border-emerald-500 bg-black/5 px-2 py-1 text-xs text-stone-600">
            <span className="line-clamp-2">{quoted.body ?? `[${quoted.type.toLowerCase()}]`}</span>
          </div>
        )}

        {hasMedia && <Media message={message} />}

        {message.body && (
          <p className="whitespace-pre-wrap break-words text-[15px]">{message.body}</p>
        )}
        {message.type === 'TEMPLATE' && (
          <p className="mt-0.5 text-[11px] text-stone-500">Plantilla: {message.templateName}</p>
        )}

        {typeof uploadProgress === 'number' && (
          <div
            role="progressbar"
            aria-valuenow={uploadProgress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Subiendo archivo"
            className="mt-1 h-1.5 w-full overflow-hidden rounded bg-stone-200"
          >
            <div className="h-full bg-emerald-600 transition-all" style={{ width: `${uploadProgress}%` }} />
          </div>
        )}

        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-stone-500">
          <span>{formatTime(message.timestamp, timezone)}</span>
          <Ticks message={message} />
        </div>

        {/* FAILED: userMessage del dominio (nunca el código crudo) + reintentar */}
        {message.status === 'FAILED' && outbound && (
          <div className="mt-1 rounded-lg bg-red-50 px-2 py-1.5">
            <p className="text-xs text-red-700">
              {message._local === 'failed-network'
                ? 'Sin conexión con el servidor. Reintentá.'
                : (message.errorDetail ?? message.errorTitle ?? 'No se pudo enviar el mensaje.')}
            </p>
            <button
              onClick={() => void retrySend(message)}
              className="mt-1 min-h-10 rounded-lg bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-700"
            >
              Reintentar
            </button>
          </div>
        )}

        {reactions && reactions.length > 0 && (
          <div className="absolute -bottom-3 right-2 rounded-full border border-stone-200 bg-white px-1.5 py-0.5 text-sm shadow-sm">
            {reactions.join(' ')}
          </div>
        )}
      </div>
    </div>
  );
}
