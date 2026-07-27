'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { validateFile } from '@/lib/media-constants';
import { usePrefs } from '@/lib/prefs';
import { useInbox } from '@/lib/store';
import type { Conversation, QuickReply, Template } from '@/lib/types';
import { windowView } from '@/lib/window-ui';
import { EmojiPicker } from './EmojiPicker';

const TEXT_LIMIT = 4096; // techo de WhatsApp para texto
const COUNTER_FROM = TEXT_LIMIT - 300; // el contador aparece solo cerca del límite
const MAX_TEXTAREA_PX = 160;

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
    <div className="space-y-2 border-t border-line bg-rice p-3">
      <p className="text-sm font-semibold">{template.name}</p>
      {params.map((value, i) => (
        <label key={i} className="block text-sm">
          <span className="mb-0.5 block text-xs text-sumi/70">Variable {'{{'}{i + 1}{'}}'}</span>
          <input
            value={value}
            onChange={(e) =>
              setParams((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))
            }
            className="min-h-11 w-full rounded-xl border border-line bg-rice px-3"
          />
        </label>
      ))}
      <div className="rounded-xl bg-ceramic p-2 text-sm text-sumi/85" aria-label="Vista previa">
        {preview}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="min-h-11 rounded-xl px-4 text-sm font-medium text-sumi/70 hover:bg-ceramic"
        >
          Cancelar
        </button>
        <button
          onClick={() => onSend(params, preview)}
          disabled={!complete}
          className="min-h-11 flex-1 rounded-xl bg-nori px-4 text-sm font-semibold text-rice hover:bg-nori-deep disabled:opacity-40"
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
  const [showEmoji, setShowEmoji] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const templates = useInbox((s) => s.templates);
  const quickReplies = useInbox((s) => s.quickReplies);
  const sendText = useInbox((s) => s.sendText);
  const sendTemplate = useInbox((s) => s.sendTemplate);
  const sendMedia = useInbox((s) => s.sendMedia);
  const enterSends = usePrefs((s) => s.prefs.enterSends);

  // El MODO lo dicta el servidor: cerrada = input deshabilitado, plantillas
  // como acción primaria (el único CTA — la WindowBar solo informa).
  const closed = windowView(conversation).mode === 'closed';

  // Autoexpandible con techo; vuelve a una línea al vaciarse.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text]);

  // Deep-link de Gourmetify: ?draft=<texto> precarga el composer UNA vez y
  // limpia el param (F5 no lo re-inserta). Si la ventana está cerrada, el
  // texto queda visible en el textarea deshabilitado — plantillas manda.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const draft = params.get('draft');
    if (!draft) return;
    setText(draft.slice(0, TEXT_LIMIT));
    params.delete('draft');
    const query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function insertEmoji(emoji: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = start + emoji.length;
    });
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
    <div className="border-t border-line bg-rice">
      {closed && (
        <div className="px-3 pt-2 text-sm font-medium text-sumi/75">
          La ventana de 24h venció — enviá una plantilla para retomar la charla
        </div>
      )}

      {pickingTemplate === 'list' && (
        <ul className="max-h-56 overflow-y-auto border-b border-line p-2" aria-label="Plantillas">
          {templates.length === 0 && (
            <li className="p-2 text-sm text-piedra">
              No hay plantillas aprobadas todavía — pedile al administrador que las cargue.
            </li>
          )}
          {templates.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setPickingTemplate(t)}
                className="min-h-12 w-full rounded-xl px-3 py-2 text-left hover:bg-ceramic"
              >
                <span className="block text-sm font-semibold">{t.name}</span>
                <span className="line-clamp-1 text-xs text-piedra">{t.bodyText}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {quickMatches.length > 0 && (
        <ul className="border-b border-line p-2" aria-label="Respuestas rápidas">
          {quickMatches.map((q) => (
            <li key={q.id}>
              <button
                onClick={() => setText(q.body)}
                className="min-h-12 w-full rounded-xl px-3 py-2 text-left hover:bg-ceramic"
              >
                <span className="mr-2 font-mono text-sm font-semibold text-nori">
                  {q.shortcut}
                </span>
                <span className="text-sm text-sumi/70">{q.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {fileError && (
        <p role="alert" className="px-3 pt-2 text-xs font-medium text-gari-ink">
          {fileError}
        </p>
      )}

      {text.length >= COUNTER_FROM && (
        <p
          className={`tnum px-3 pt-1 text-right font-mono text-xs ${
            text.length >= TEXT_LIMIT ? 'font-semibold text-gari-ink' : 'text-piedra'
          }`}
        >
          {text.length}/{TEXT_LIMIT}
        </p>
      )}

      <div className="flex items-end gap-1.5 p-2.5">
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

        <div className="relative shrink-0">
          <button
            onClick={() => setShowEmoji((v) => !v)}
            disabled={closed}
            aria-label="Elegir emoji"
            aria-expanded={showEmoji}
            className="flex h-12 w-12 items-center justify-center rounded-full text-xl hover:bg-ceramic disabled:opacity-30"
          >
            🙂
          </button>
          {showEmoji && !closed && (
            <EmojiPicker
              onPick={(emoji) => insertEmoji(emoji)}
              onClose={() => setShowEmoji(false)}
            />
          )}
        </div>

        <button
          onClick={() => fileInput.current?.click()}
          disabled={closed}
          aria-label="Adjuntar archivo"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl hover:bg-ceramic disabled:opacity-30"
        >
          📎
        </button>

        <label className="sr-only" htmlFor="composer-input">
          Mensaje
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          value={text}
          maxLength={TEXT_LIMIT}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const file = e.clipboardData?.files?.[0];
            if (file) {
              e.preventDefault();
              pickFile(file); // imagen del portapapeles → adjunto
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (quickMatches.length > 0) {
              e.preventDefault();
              setText(quickMatches[0].body); // Enter inserta el body
              return;
            }
            // Preferencia de dispositivo: Enter envía (default) o
            // Enter hace salto y Ctrl/Cmd+Enter envía.
            const sends = enterSends
              ? !e.shiftKey && !e.ctrlKey && !e.metaKey
              : e.ctrlKey || e.metaKey;
            if (sends) {
              e.preventDefault();
              void submitText();
            }
          }}
          disabled={closed}
          rows={1}
          placeholder={
            closed
              ? 'Solo plantillas hasta que el cliente vuelva a escribir'
              : 'Escribí un mensaje… ("/" para respuestas rápidas)'
          }
          className="min-h-12 flex-1 resize-none rounded-2xl border border-line bg-rice px-4 py-3 text-[15px] placeholder:text-piedra disabled:bg-piedra-soft disabled:text-piedra"
        />

        <button
          onClick={() => setPickingTemplate(pickingTemplate === 'list' ? null : 'list')}
          aria-label="Elegir plantilla"
          aria-expanded={pickingTemplate === 'list'}
          className={`flex h-12 shrink-0 items-center justify-center rounded-full px-4 text-sm font-semibold ${
            closed
              ? 'bg-nori text-rice hover:bg-nori-deep' // acción PRIMARIA con ventana cerrada
              : 'text-nori hover:bg-nori-soft'
          }`}
        >
          Plantillas
        </button>

        <button
          onClick={() => void submitText()}
          disabled={closed || !text.trim()}
          aria-label="Enviar mensaje"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-nori text-xl text-rice hover:bg-nori-deep disabled:opacity-30"
        >
          ➤
        </button>
      </div>
    </div>
  );
}
