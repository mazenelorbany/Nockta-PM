// =============================================================================
// Shared types for the MembersTab sub-components.
// =============================================================================

export interface MemberUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string | null;
  companyRole: 'Admin' | 'Member' | null;
  kind?: 'internal' | 'client';
  archivedAt?: string | null;
  createdAt?: string;
  lastSeenAt?: string | null;
  teams?: Array<{ id: string; slug: string; name: string }>;
}

export type KindFilter = 'internal' | 'client' | 'archived';
export type CompanyRole = 'Admin' | 'Member';
export type SortField = 'name' | 'role' | 'joined' | 'lastSeen';
export type SortDir = 'asc' | 'desc';

export interface UserDetail {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string | null;
  kind: 'internal' | 'client';
  companyRole: 'Admin' | 'Member' | null;
  archivedAt: string | null;
  createdAt: string;
  teams: Array<{ id: string; slug: string; name: string; description: string | null }>;
  projects: Array<{
    id: string;
    key: string;
    name: string;
    visibility: 'public' | 'teams' | 'private';
    role: 'Manager' | 'Contributor' | 'Viewer' | 'Client';
    source: 'admin' | 'user' | 'team' | 'public';
    grantId: string | null;
  }>;
}
