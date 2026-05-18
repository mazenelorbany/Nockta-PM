import { createParamDecorator, InternalServerErrorException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../types';

/**
 * @CurrentUser() — pulls the user attached by JwtAuthGuard onto req.user.
 * Throws (via undefined) if used on a route without auth; pair with @Public()
 * or expect the route to be guarded.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!req.user) {
      throw new InternalServerErrorException('CurrentUser used on an unauthenticated route');
    }
    return req.user;
  },
);
