// dotenv PRIMERO: los decoradores (p.ej. el cors del gateway) se evalúan al
// importar AppModule, antes de que ConfigModule cargue .env.
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureBodyParsers } from './http/body-parsers';
import { corsOrigins } from './http/cors';

async function bootstrap(): Promise<void> {
  // bodyParser: false — los parsers se registran a mano en
  // configureBodyParsers: /webhooks necesita el raw body exacto para la
  // firma HMAC y no puede morir 400 ante JSON inválido. Ver src/http/.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureBodyParsers(app);

  const origins = corsOrigins();
  app.enableCors({ origin: origins, credentials: true });
  if (origins === true) {
    new Logger('Bootstrap').warn(
      'CORS_ORIGINS sin setear: CORS abierto a cualquier origen (solo aceptable en dev)',
    );
  }

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`whatsapp-inbox API escuchando en :${port}`);
}

void bootstrap();
