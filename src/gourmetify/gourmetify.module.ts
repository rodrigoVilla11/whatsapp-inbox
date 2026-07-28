import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ProvisioningAuthMiddleware } from '../provisioning/provisioning-auth.middleware';
import { GourmetifyOrdersController } from './orders.controller';
import { GourmetifyOrdersService } from './orders.service';

/**
 * Ingesta de pedidos desde Gourmetify (webhook servicio-a-servicio):
 * mismo guard por secreto compartido que el provisioning, jamás
 * SessionAuthMiddleware. La LECTURA de pedidos (con sesión) vive en
 * InboxModule, que importa este módulo por el service.
 */
@Module({
  controllers: [GourmetifyOrdersController],
  providers: [GourmetifyOrdersService],
  exports: [GourmetifyOrdersService],
})
export class GourmetifyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ProvisioningAuthMiddleware).forRoutes(GourmetifyOrdersController);
  }
}
