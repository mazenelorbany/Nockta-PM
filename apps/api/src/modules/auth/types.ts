import type { CompanyRole, UserKind } from '@prisma/client';

/** JWT body — kept small. */
export interface JwtPayload {
  sub: string;                     // user id
  kind: UserKind;
  email: string;
  role: CompanyRole | null;        // null for clients
  jti: string;                     // unique per token, used for revocation
}

/** Attached to req.user after JwtAuthGuard passes. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  kind: UserKind;
  companyRole: CompanyRole | null;
  jti: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;  // ISO timestamp
  refreshTokenExpiresAt: string;
}
