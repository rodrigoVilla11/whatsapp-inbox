import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX } from './api-prefix';
import { configureBodyParsers } from './body-parsers';

/**
 * Configuración de app COMPARTIDA entre main.ts y los tests e2e: los tests
 * corren con el mismo prefijo /api y los mismos parsers que producción —
 * lo que pasa en verde es lo que se deploya.
 */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  // Detrás del proxy de Easypanel (Traefik): la IP real llega por
  // X-Forwarded-For (el rate limit de login depende de esto) y Express
  // debe saber que el TLS termina en el proxy (cookies Secure).
  app.set('trust proxy', 1);
  configureBodyParsers(app);
}
