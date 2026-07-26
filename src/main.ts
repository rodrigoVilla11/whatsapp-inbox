// dotenv PRIMERO: los decoradores (p.ej. el cors del gateway) se evalúan al
// importar AppModule, antes de que ConfigModule cargue .env.
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsOrigins } from './http/cors';
import { configureApp } from './http/app-setup';
import { registerGracefulShutdown } from './http/shutdown';
import { createRootLogger, PinoNestLogger, requestLogger } from './logging/logger';

async function bootstrap(): Promise<void> {
  const logger = createRootLogger();

  // bodyParser: false — los parsers se registran a mano en configureApp:
  // /api/webhooks necesita el raw body exacto para la firma HMAC y no puede
  // morir 400 ante JSON inválido. Ver src/http/.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(new PinoNestLogger(logger));
  app.use(requestLogger(logger));
  configureApp(app); // prefijo /api + trust proxy + parsers (igual que los e2e)

  // CORS solo importa en dev (web :3000 contra api :3001). En producción,
  // con UN SOLO ORIGEN (fase 10b), el browser no manda preflights.
  const origins = corsOrigins();
  app.enableCors({ origin: origins, credentials: true });
  if (origins === true && process.env.NODE_ENV === 'production') {
    logger.warn(
      'CORS_ORIGINS sin setear con NODE_ENV=production: correcto SOLO si todo vive bajo el mismo origen',
    );
  }

  registerGracefulShutdown(app, logger); // orden documentado en http/shutdown.ts

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  logger.info({ port, prefix: '/api' }, 'whatsapp-inbox API escuchando');
}

void bootstrap();
