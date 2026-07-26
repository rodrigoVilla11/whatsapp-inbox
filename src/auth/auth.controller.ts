import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { getTenantContext } from '../tenant/tenant-context';
import { clearSessionCookie, parseCookies, SESSION_COOKIE, setSessionCookie } from './cookies';
import { LoginRateLimiter } from './login-rate-limit';
import { hashPassword, passwordPolicyError, verifyPassword } from './passwords';
import { assertOriginAllowed } from './session-auth.middleware';
import { SessionsService } from './sessions.service';

/** DTO del usuario logueado — nunca el hash, nunca emails de otros. */
export function serializeAuthUser(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

// Mensaje ÚNICO: no distinguir "email no existe" de "password mal".
const LOGIN_FAILED = 'Email o contraseña incorrectos';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  /** Sin sesión previa (obvio) — pero con el cinturón de Origin igual. */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    assertOriginAllowed(req);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) throw new UnauthorizedException(LOGIN_FAILED);

    const ip = req.ip ?? 'sin-ip';
    const retryAfterMs = await this.rateLimiter.retryAfterMs(email, ip);
    if (retryAfterMs !== null) {
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      throw new HttpException(
        `Demasiados intentos — esperá ${Math.max(1, Math.ceil(retryAfterMs / 60000))} min y probá de nuevo`,
        429,
      );
    }

    // Email global (findFirst): hoy un email vive en un solo tenant; si
    // Gourmetify algún día comparte emails entre tenants, el login pasa a
    // pedir el tenant (slug en el subdominio) — anotado, no bloquea.
    const user = (await this.prisma.db.user.findFirst({
      where: { email, isActive: true },
    })) as User | null;

    const verdict = await verifyPassword(user?.passwordHash ?? null, password);
    if (!user || !verdict.ok) {
      await this.rateLimiter.recordFailure(email, ip);
      throw new UnauthorizedException(LOGIN_FAILED);
    }

    await this.rateLimiter.reset(email, ip);
    if (verdict.needsRehash) {
      // migración de hash en caliente (parámetros nuevos) — best effort
      await this.prisma.db.user
        .update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } })
        .catch(() => undefined);
    }

    const { token } = await this.sessions.create(user, req.headers['user-agent'] ?? null);
    setSessionCookie(res, token);
    return { user: serializeAuthUser(user) };
  }

  /** Idempotente: cookie inválida o ausente → igual limpia y 200. */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    await this.sessions.revokeByToken(token);
    clearSessionCookie(res);
    return { ok: true };
  }

  /** Bootstrap del frontend: quién soy + mi tenant. (Con middleware de sesión.) */
  @Get('me')
  async me(@Req() req: Request): Promise<unknown> {
    const context = getTenantContext(req);
    const [user, tenant] = await Promise.all([
      this.prisma.db.user.findUnique({ where: { id: context.userId } }),
      this.prisma.db.tenant.findUnique({ where: { id: context.tenantId } }),
    ]);
    if (!user || !tenant) throw new UnauthorizedException('Necesitás iniciar sesión');
    return {
      user: serializeAuthUser(user as User),
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        timezone: tenant.timezone,
      },
    };
  }

  /**
   * Cambio de password (incluye el forzado del primer login). Pide SIEMPRE
   * la actual. Revoca las demás sesiones del usuario; la actual sigue.
   */
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Req() req: Request,
  ): Promise<unknown> {
    const context = getTenantContext(req);
    const currentPassword =
      typeof body?.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';

    const policyError = passwordPolicyError(newPassword);
    if (policyError) throw new BadRequestException(policyError);

    const user = (await this.prisma.db.user.findUnique({
      where: { id: context.userId },
    })) as User | null;
    if (!user) throw new UnauthorizedException('Necesitás iniciar sesión');

    const verdict = await verifyPassword(user.passwordHash, currentPassword);
    if (!verdict.ok) throw new BadRequestException('La contraseña actual no es correcta');

    await this.prisma.db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
    });
    await this.sessions.revokeAllForUser(user.id, context.sessionId);
    return { user: serializeAuthUser({ ...user, mustChangePassword: false }) };
  }
}
