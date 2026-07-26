import type { RawBodyRequest } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { WEBHOOKS_PATH } from '../webhooks/webhooks.constants';
import { API_PREFIX } from './api-prefix';

/**
 * La app arranca con bodyParser: false y registra sus parsers acá, porque
 * /webhooks tiene dos requisitos que el json parser global rompería:
 *
 * 1. La firma X-Hub-Signature-256 es HMAC del RAW BODY exacto. Se necesita
 *    el Buffer intacto, no una re-serialización del objeto parseado.
 * 2. Un body con firma válida pero JSON inválido debe responder 200 (se
 *    audita y listo). Con express.json() delante, el parser corta con 400
 *    antes de llegar al controller — y un no-2xx hace que Meta reintente.
 *
 * Por eso /webhooks recibe SOLO raw (el JSON.parse lo hace el service en
 * try/catch) y el resto de la API usa los parsers estándar.
 */
/**
 * Techo de tamaño para el endpoint público del webhook. Los payloads de
 * Meta son de pocos KB; 1MB deja margen de sobra. Lo impone express.raw
 * (raw-body por debajo): Content-Length > limit → 413 inmediato SIN leer
 * el stream; body chunked → aborta la lectura al cruzar el techo. Nadie
 * bufferea un body arbitrario antes de poder validar la firma.
 */
const WEBHOOK_BODY_LIMIT = '1mb';

export function configureBodyParsers(app: NestExpressApplication): void {
  app.use(
    `/${API_PREFIX}${WEBHOOKS_PATH}`, // el prefijo global también aplica acá
    raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    (req: RawBodyRequest<Request>, _res: Response, next: NextFunction) => {
      // express.raw deja Buffer solo cuando hubo body; normalizamos el resto
      // (GET de verificación, POST vacío) a undefined.
      req.rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
      next();
    },
  );
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
}
