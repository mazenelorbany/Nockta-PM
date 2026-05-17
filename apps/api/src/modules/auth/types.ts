import type { CompanyRole, UserKind } from '@prisma/client';

/** JWT body — kept small. */
export interface JwtPayload {
  sub: string;                     // user id
  kind: UserKind;
  email: string;
  role: CompanyRole | null;        // null for clients
  jti: string;                     // unique per token, used for revocation
  /// Workspace boundary — Round 6 Pass A. Optional in the type so legacy
  /// tokens issued before the migration still decode; missing values fall
  /// back to the bootstrap 'default' workspace via WorkspaceContextService.
  /// New tokens always include this claim.
  workspaceId?: string;
}

/** Attached to req.user after JwtAuthGuard passes. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  kind: UserKind;
  companyRole: CompanyRole | null;
  jti: string;
  /// Resolved at token-issuance time from the user's WorkspaceMember rows
  /// (first membership wins; fall back to 'default'). Always populated by
  /// JwtStrategy.validate on new tokens; declared optional only so legacy
  /// test fixtures that construct AuthenticatedUser literals without it
  /// keep compiling. Treat as required at runtime — every caller can rely
  /// on it being a non-empty string after JwtAuthGuard.
  workspaceId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;  // ISO timestamp
  refreshTokenExpiresAt: string;
}
