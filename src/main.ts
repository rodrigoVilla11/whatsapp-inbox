import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody: true desde el día uno. La validación de X-Hub-Signature-256
  // (fase 2) firma sobre el raw body EXACTO que mandó Meta; firmar sobre el
  // objeto parseado y re-serializado nunca coincide.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`whatsapp-inbox API escuchando en :${port}`);
}

void bootstrap();
