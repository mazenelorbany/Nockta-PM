import { SetMetadata } from '@nestjs/common';
import type { CompanyRole } from '@prisma/client';

export const ROLES_KEY = 'requiredRoles';

/** Restrict an endpoint to specific company roles (Admin / Member). */
export const RequireCompanyRoles = (
  ...roles: CompanyRole[]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
