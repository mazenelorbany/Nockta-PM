import type {
  CanActivate} from '@nestjs/common';
import {
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { CompanyRole } from '@prisma/client';

import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../types';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<CompanyRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user || !user.companyRole) {
      throw new ForbiddenException('Insufficient company role');
    }
    if (!required.includes(user.companyRole)) {
      throw new ForbiddenException(
        `Requires one of: ${required.join(', ')}; have: ${user.companyRole}`,
      );
    }
    return true;
  }
}
