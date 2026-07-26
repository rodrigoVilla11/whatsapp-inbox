import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { LoginRateLimiter } from './login-rate-limit';
import { RolesGuard } from './roles';
import { SessionAuthMiddleware } from './session-auth.middleware';
import { SessionsService } from './sessions.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Auth de fase 8. Global: SessionsService y el middleware los consumen los
 * módulos del dominio (inbox, media, messaging) y el gateway WS.
 *
 * /auth/login y /auth/logout quedan SIN middleware de sesión (login no la
 * tiene todavía; logout debe funcionar con cookie inválida). /auth/me y
 * /auth/change-password sí lo llevan. /webhooks/* jamás lo lleva: su auth
 * es la firma HMAC de Meta.
 */
@Global()
@Module({
  controllers: [AuthController, UsersController],
  providers: [SessionsService, LoginRateLimiter, SessionAuthMiddleware, RolesGuard, UsersService],
  exports: [SessionsService, SessionAuthMiddleware],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(SessionAuthMiddleware)
      .forRoutes('auth/me', 'auth/change-password', UsersController);
  }
}
