'use client';

import { useMemo, useRef, useState } from 'react';
import { validateFile } from '@/lib/media-constants';
import { useInbox } from '@/lib/store';
import type { Conversation, QuickReply, Template } from '@/lib/types';
import { windowView } from '@/lib/window-ui';

function renderTemplate(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, i: string) => params[Number(i) - 1] ?? '…');
}

/** Mini-formulario de parámetros con preview del texto final antes de enviar. */
function TemplateForm({
  template,
  onSend,
  onCancel,
}: {
  template: Template;
  onSend: (params: string[], preview: string) => void;
  onCancel: () => void;
}) {
  const [params, setParams] = useState<string[]>(Array(template.variableCount).fill(''));
  const preview = renderTemplate(template.bodyText, params);
  const complete = params.every((p) => p.trim().length > 0);

  return (
    <div className="space-y-2 border-t border-stone-200 bg-white p-3">
      <p className="text-sm font-semibold">{template.name}</p>
      {params.map((value, i) => (
        <label key={i} className="block text-sm">
          <span className="mb-0.5 block text-xs text-stone-600">Variable {'{{'}{i + 1}{'}}'}</span>
          <input
            value={value}
            onChange={(e) =>
              setParams((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
            }
            className="min-h-11 w-full rounded-lg border border-stone-300 px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
          />
        </label>
      ))}
      <div className="rounded-lg bg-stone-50 p-2 text-sm text-stone-700" aria-label="Vista previa">
        {preview}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="min-h-11 rounded-lg px-4 text-sm font-medium text-stone-600 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        >
          Cancelar
        </button>
        <button
          onClick={() => onSend(params, preview)}
          disabled={!complete}
          className="min-h-11 flex-1 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-800"
        >
          Enviar plantilla
        </button>
      </div>
    </div>
  );
}

export function Composer({ conversation }: { conversation: Conversation }) {
  const [text, setText] = useState('');
  const [pickingTemplate, setPickingTemplate] = useState<Template | 'list' | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const templates = useInbox((s) => s.templates);
  const quickReplies = useInbox((s) => s.quickReplies);
  const sendText = useInbox((s) => s.sendText);
  const sendTemplate = useInbox((s) => s.sendTemplate);
  const sendMedia = useInbox((s) => s.sendMedia);

  // El MODO lo dicta el servidor: cerrada = input deshabilitado, plantillas
  // como acción primaria. La cajera nunca reintenta a ciegas.
  const closed = windowView(conversation).mode === 'closed';

  // "/" al inicio → picker de respuestas rápidas filtrado mientras escribe
  const quickMatches: QuickReply[] = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ')) return [];
    return quickReplies.filter((q) => q.shortcut.startsWith(text)).slice(0, 6);
  }, [text, quickReplies]);

  async function submitText() {
    const body = text.trim();
    if (!body || closed) return;
    setText('');
    await sendText(conversation.id, body);
  }

  function pickFile(file: File | null) {
    if (!file) return;
    const error = validateFile(file);
    setFileError(error);
    if (error) return;
    const caption = text.trim() || null;
    setText('');
    void sendMedia(conversation.id, file, caption);
  }

  if (pickingTemplate && pickingTemplate !== 'list') {
    return (
      <TemplateForm
        template={pickingTemplate}
        onCancel={() => setPickingTemplate(null)}
        onSend={(params, preview) => {
          setPickingTemplate(null);
          void sendTemplate(conversation.id, pickingTemplate.id, params, preview);
        }}
      />
    );
  }

  return (
    <div className="border-t border-stone-200 bg-white">
      {closed && (
        <div className="px-3 pt-2 text-sm font-medium text-stone-700">
          La ventana de 24h venció — enviá una plantilla
        </div>
      )}

      {pickingTemplate === 'list' && (
        <ul className="max-h-56 overflow-y-auto border-b border-stone-100 p-2" aria-label="Plantillas">
          {templates.length === 0 && (
            <li className="p-2 text-sm text-stone-500">
              No hay plantillas aprobadas. Sincronizá desde el backend (POST /templates/sync).
            </li>
          )}
          {templates.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setPickingTemplate(t)}
                className="min-h-12 w-full rounded-lg px-3 py-2 text-left hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
              >
                <span className="block text-sm font-semibold">{t.name}</span>
                <span className="line-clamp-1 text-xs text-stone-500">{t.bodyText}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {quickMatches.length > 0 && (
        <ul className="border-b border-stone-100 p-2" aria-label="Respuestas rápidas">
          {quickMatches.map((q) => (
            <li key={q.id}>
              <button
                onClick={() => setText(q.body)}
                className="min-h-12 w-full rounded-lg px-3 py-2 text-left hover:bg-stone-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
              >
                <span className="mr-2 font-mono text-sm font-semibold text-emerald-700">
                  {q.shortcut}
                </span>
                <span className="text-sm text-stone-600">{q.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {fileError && (
        <p role="alert" className="px-3 pt-2 text-xs font-medium text-red-600">
          {fileError}
        </p>
      )}

      <div className="flex items-end gap-2 p-3">
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
          aria-hidden
          tabIndex={-1}
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={closed}
          aria-label="Adjuntar archivo"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl hover:bg-stone-100 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        >
          📎
        </button>

        <label className="sr-only" htmlFor="composer-input">
          Mensaje
        </label>
        <textarea
          id="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && quickMatches.length === 0) {
              e.preventDefault();
              void submitText();
            }
            if (e.key === 'Enter' && quickMatches.length > 0) {
              e.preventDefault();
              setText(quickMatches[0].body); // Enter inserta el body
            }
          }}
          disabled={closed}
          rows={1}
          placeholder={
            closed ? 'Texto libre deshabilitado (ventana cerrada)' : 'Escribí un mensaje… ("/" para respuestas rápidas)'
          }
          className="max-h-32 min-h-12 flex-1 resize-y rounded-2xl border border-stone-300 px-4 py-3 text-[15px] disabled:bg-stone-100 disabled:text-stone-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        />

        <button
          onClick={() => setPickingTemplate(pickingTemplate === 'list' ? null : 'list')}
          aria-label="Elegir plantilla"
          aria-expanded={pickingTemplate === 'list'}
          className={`flex h-12 shrink-0 items-center justify-center rounded-full px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-800 ${
            closed
              ? 'bg-emerald-600 text-white hover:bg-emerald-700' // acción PRIMARIA con ventana cerrada
              : 'text-emerald-700 hover:bg-emerald-50'
          }`}
        >
          Plantillas
        </button>

        <button
          onClick={() => void submitText()}
          disabled={closed || !text.trim()}
          aria-label="Enviar mensaje"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xl text-white hover:bg-emerald-700 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-800"
        >
          ➤
        </button>
      </div>
    </div>
  );
}
