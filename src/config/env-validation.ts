/**
 * Validación de entorno AL BOOT (fase 10). Si falta una crítica en
 * producción, el proceso NO arranca y dice cuál falta — un contenedor que
 * bootea "bien" sin ENCRYPTION_KEY y explota en el primer request es el
 * peor modo de fallo.
 *
 * Sin dependencias: la lista declarativa de abajo ES la documentación de
 * requeridas vs opcionales (espejada en .env.production.example).
 */

interface EnvRule {
  name: string;
  /** 'always' = requerida siempre; 'production' = requerida solo en prod. */
  required: 'always' | 'production' | 'optional';
  hint: string;
}

const RULES: EnvRule[] = [
  { name: 'DATABASE_URL', required: 'always', hint: 'postgresql://…' },
  {
    name: 'REDIS_URL',
    required: 'production',
    hint: 'redis://… (en dev cae al redis del compose, :6380)',
  },
  // ENCRYPTION_KEY o ENCRYPTION_KEYS — regla especial más abajo.
  { name: 'PORT', required: 'optional', hint: 'default 3001' },
  { name: 'LOG_LEVEL', required: 'optional', hint: 'default info (prod) / debug (dev)' },
  { name: 'CORS_ORIGINS', required: 'optional', hint: 'solo dev cross-origin; en prod (mismo origen) no va' },
  {
    name: 'PROVISIONING_SECRET',
    required: 'optional',
    hint: 'habilita la API de provisioning para Gourmetify (sin esto: 503)',
  },
  {
    name: 'PUBLIC_API_URL',
    required: 'optional',
    hint: 'base pública de la API para armar Callback URLs (ej: https://inbox.gourmetify.pro/inbox/api)',
  },
  {
    name: 'GROQ_API_KEY',
    required: 'optional',
    hint: 'habilita la transcripción de audios (console.groq.com); sin esto el botón no aparece',
  },
  { name: 'TRANSCRIPTION_LANGUAGE', required: 'optional', hint: "default 'es'" },
  { name: 'ENCRYPTION_ACTIVE_KEY_VERSION', required: 'optional', hint: 'default 1' },
  // R2: grupo todo-o-nada; en producción es requerido (la media vive ahí).
  {
    name: 'R2_ACCOUNT_ID',
    required: 'production',
    hint: 'Account ID de Cloudflare (32 hex) — el endpoint S3 se deriva de él',
  },
  { name: 'R2_ACCESS_KEY_ID', required: 'production', hint: 'credencial R2' },
  { name: 'R2_SECRET_ACCESS_KEY', required: 'production', hint: 'credencial R2' },
  { name: 'R2_BUCKET', required: 'production', hint: 'bucket de media' },
];

/**
 * El endpoint sale de R2_ACCOUNT_ID; R2_ENDPOINT se acepta como override
 * explícito, así que para el grupo cualquiera de los dos alcanza.
 */
const R2_GROUP = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

/** Devuelve la lista de problemas (vacía = todo bien). Pura y testeable. */
export function envProblems(env: Record<string, string | undefined>): string[] {
  const production = env.NODE_ENV === 'production';
  const problems: string[] = [];
  const missing = (name: string): boolean => !env[name]?.trim();

  for (const rule of RULES) {
    const requiredNow =
      rule.required === 'always' || (rule.required === 'production' && production);
    // R2_ENDPOINT explícito cubre a R2_ACCOUNT_ID (de él sale el endpoint).
    if (rule.name === 'R2_ACCOUNT_ID' && !missing('R2_ENDPOINT')) continue;
    if (requiredNow && missing(rule.name)) {
      problems.push(`${rule.name} (${rule.hint})`);
    }
  }

  // Cifrado: una de las dos formas, siempre.
  if (missing('ENCRYPTION_KEY') && missing('ENCRYPTION_KEYS')) {
    problems.push(
      'ENCRYPTION_KEY o ENCRYPTION_KEYS (32 bytes base64 — node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")',
    );
  }

  // R2 parcial es SIEMPRE error (aunque sea dev): tres de cuatro credenciales
  // configuradas es un typo, no una decisión.
  const r2Has = (name: string): boolean =>
    name === 'R2_ACCOUNT_ID'
      ? !missing('R2_ACCOUNT_ID') || !missing('R2_ENDPOINT')
      : !missing(name);
  const r2Present = R2_GROUP.filter(r2Has);
  if (r2Present.length > 0 && r2Present.length < R2_GROUP.length) {
    const faltantes = R2_GROUP.filter((name) => !r2Has(name));
    problems.push(`grupo R2 incompleto — faltan: ${faltantes.join(', ')}`);
  }

  return [...new Set(problems)];
}

/** Para ConfigModule.forRoot({ validate }): tira con el detalle si algo falta. */
export function validateEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const problems = envProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `Entorno inválido — el proceso no arranca. Falta/n:\n  - ${problems.join('\n  - ')}`,
    );
  }
  return env;
}
