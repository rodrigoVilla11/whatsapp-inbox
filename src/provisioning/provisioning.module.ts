import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { checkGraphCredentials, GRAPH_CREDENTIALS_CHECK } from './graph-credentials';
import { ProvisioningAuthMiddleware } from './provisioning-auth.middleware';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';

/**
 * Provisioning servicio-a-servicio (Gourmetify → inbox). SIN auth de
 * sesión (no hay usuario, hay otro backend): su guard es el secreto
 * compartido del ProvisioningAuthMiddleware. Igual que /webhooks, este
 * módulo JAMÁS aplica SessionAuthMiddleware.
 */
@Module({
  controllers: [ProvisioningController],
  providers: [
    ProvisioningService,
    { provide: GRAPH_CREDENTIALS_CHECK, useValue: checkGraphCredentials },
  ],
})
export class ProvisioningModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ProvisioningAuthMiddleware).forRoutes(ProvisioningController);
  }
}
