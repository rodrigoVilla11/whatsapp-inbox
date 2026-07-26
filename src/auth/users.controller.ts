import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { getTenantContext } from '../tenant/tenant-context';
import { MinRole, roleAtLeast, RolesGuard } from './roles';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(RolesGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Cualquier rol: DTO chico para el selector de asignación. Con
   * ?management=true (ADMIN+): lista completa con email e inactivos.
   */
  @Get()
  async list(@Req() req: Request, @Query('management') management?: string): Promise<unknown[]> {
    const context = getTenantContext(req);
    if (management === 'true' && roleAtLeast(context.role, 'ADMIN')) {
      return this.users.listForManagement(context.tenantId);
    }
    return this.users.listForAssignment(context.tenantId);
  }

  @Post()
  @MinRole('ADMIN')
  async create(
    @Body() body: { email?: string; name?: string; role?: string; password?: string },
    @Req() req: Request,
  ): Promise<unknown> {
    return this.users.create(getTenantContext(req), body ?? {});
  }

  @Patch(':id')
  @MinRole('ADMIN')
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; role?: string; isActive?: boolean },
    @Req() req: Request,
  ): Promise<unknown> {
    return this.users.update(getTenantContext(req), id, body ?? {});
  }
}
