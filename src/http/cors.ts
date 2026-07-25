/**
 * Orígenes CORS desde env (CORS_ORIGINS, lista separada por comas), para
 * REST y para el gateway WS. Sin la env: origin true (abierto) — SOLO dev,
 * con warning en el boot.
 */
export function corsOrigins(): string[] | true {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) return true;
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
