'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { AutoReplyConfig, AutoReplyRange } from '@/lib/types';
import { usePending } from '@/lib/use-pending';

const DAYS: Array<{ key: string; label: string }> = [
  { key: '1', label: 'Lunes' },
  { key: '2', label: 'Martes' },
  { key: '3', label: 'Miércoles' },
  { key: '4', label: 'Jueves' },
  { key: '5', label: 'Viernes' },
  { key: '6', label: 'Sábado' },
  { key: '0', label: 'Domingo' },
];

const EMPTY: AutoReplyConfig = { enabled: false, message: '', schedule: {} };

/**
 * Auto-respuesta fuera de horario (ADMIN+). Horarios por día con hasta 2
 * turnos (mediodía/noche); un rango que cruza medianoche (19:30–00:30)
 * vale y significa lo obvio. Todo en la hora local del restaurante.
 */
export function AutoReplySettings() {
  const [config, setConfig] = useState<AutoReplyConfig>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const save = usePending();

  useEffect(() => {
    api.autoReply
      .get()
      .then((c) => {
        setConfig(c);
        setLoaded(true);
      })
      .catch(() => setLoaded(true)); // 401/403: la página ya gestiona el acceso
  }, []);

  function patch(partial: Partial<AutoReplyConfig>): void {
    setConfig((c) => ({ ...c, ...partial }));
    setDirty(true);
  }

  function setRange(day: string, index: number, range: AutoReplyRange | null): void {
    setConfig((c) => {
      const current = [...(c.schedule[day] ?? [])];
      if (range === null) current.splice(index, 1);
      else current[index] = range;
      return { ...c, schedule: { ...c.schedule, [day]: current.filter(Boolean) } };
    });
    setDirty(true);
  }

  function doSave(): void {
    save.run(async () => {
      try {
        const saved = await api.autoReply.update(config);
        setConfig(saved);
        setDirty(false);
        toast('Auto-respuesta guardada');
      } catch (error) {
        toast(error instanceof Error ? error.message : 'No se pudo guardar');
      }
    });
  }

  if (!loaded) return null;

  return (
    <section className="mb-4 rounded-2xl border border-line bg-rice p-2">
      <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-piedra">
        Auto-respuesta fuera de horario
      </h2>

      <button
        role="switch"
        aria-checked={config.enabled}
        onClick={() => patch({ enabled: !config.enabled })}
        className="flex min-h-14 w-full items-center justify-between gap-4 rounded-xl px-3 py-2 text-left hover:bg-ceramic"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">Responder cuando está cerrado</span>
          <span className="block text-xs text-piedra">
            El cliente que escribe fuera de horario recibe el mensaje de abajo (máx. 1 cada 6 hs).
          </span>
        </span>
        <span
          aria-hidden
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
            config.enabled ? 'bg-nori' : 'bg-piedra/40'
          }`}
        >
          <span
            className={`absolute top-1 h-5 w-5 rounded-full bg-rice shadow transition-transform ${
              config.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </span>
      </button>

      {config.enabled && (
        <div className="space-y-3 px-3 pb-3 pt-1">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sumi/70">Mensaje</span>
            <textarea
              value={config.message}
              onChange={(e) => patch({ message: e.target.value })}
              rows={3}
              maxLength={1000}
              placeholder="¡Hola! 🍣 Ahora estamos cerrados — abrimos a las 19:30. Dejanos tu pedido y te confirmamos apenas abramos."
              className="w-full resize-none rounded-xl border border-line bg-rice px-3 py-2 text-sm placeholder:text-piedra"
            />
          </label>

          <div>
            <p className="mb-1.5 text-xs font-medium text-sumi/70">
              Horario de atención (hora local del restaurante; sin rangos = cerrado ese día)
            </p>
            <div className="space-y-1.5">
              {DAYS.map(({ key, label }) => {
                const ranges = config.schedule[key] ?? [];
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 text-sm">{label}</span>
                    {ranges.length === 0 && (
                      <span className="rounded-full bg-piedra-soft px-2 py-0.5 text-[11px] text-sumi/60">
                        cerrado
                      </span>
                    )}
                    {ranges.map((range, i) => (
                      <span key={i} className="flex items-center gap-1">
                        <input
                          type="time"
                          value={range.from}
                          onChange={(e) => setRange(key, i, { ...range, from: e.target.value })}
                          className="min-h-10 rounded-lg border border-line bg-rice px-2 font-mono text-sm"
                          aria-label={`${label}: apertura del turno ${i + 1}`}
                        />
                        <span className="text-piedra">–</span>
                        <input
                          type="time"
                          value={range.to}
                          onChange={(e) => setRange(key, i, { ...range, to: e.target.value })}
                          className="min-h-10 rounded-lg border border-line bg-rice px-2 font-mono text-sm"
                          aria-label={`${label}: cierre del turno ${i + 1}`}
                        />
                        <button
                          onClick={() => setRange(key, i, null)}
                          aria-label={`Quitar turno ${i + 1} de ${label}`}
                          className="flex h-10 w-10 items-center justify-center rounded-lg text-piedra hover:bg-ceramic hover:text-sumi"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    {ranges.length < 2 && (
                      <button
                        onClick={() =>
                          setRange(key, ranges.length, { from: '19:30', to: '23:30' })
                        }
                        className="min-h-10 rounded-lg px-2 text-xs font-medium text-nori hover:bg-nori-soft"
                      >
                        + turno
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-piedra">
              Un turno que cruza medianoche (ej. 19:30–00:30) vale y significa hasta la madrugada.
            </p>
          </div>
        </div>
      )}

      {dirty && (
        <div className="px-3 pb-3">
          <button
            onClick={doSave}
            disabled={save.pending}
            className="min-h-11 w-full rounded-xl bg-nori text-sm font-semibold text-rice hover:bg-nori-deep disabled:opacity-50"
          >
            {save.pending ? 'Guardando…' : 'Guardar auto-respuesta'}
          </button>
        </div>
      )}
    </section>
  );
}
