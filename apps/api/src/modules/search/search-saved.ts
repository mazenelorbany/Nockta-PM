import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

import type { SearchInput } from './postgres-search';

// Saved-search CRUD + the promote endpoints that bridge the SavedSearch /
// SavedView discriminator.
//
// Historical note: an earlier version of this module imagined a separate
// `SavedView` model alongside `SavedSearch`. That model was never created —
// the board "Views" dropdown and the search "Saved" list both store rows in
// the single `SavedSearch` table. SavedViewsService writes to the same
// table from a different controller. A previous version of listSaved read
// SavedSearch twice and concat'd the results (every row showed up twice in
// the UI); we now do one read and one delete.

export function listSaved(prisma: PrismaService, actor: AuthenticatedUser) {
  return prisma.savedSearch.findMany({
    where: { userId: actor.id },
    orderBy: { createdAt: 'desc' },
  });
}

export function saveSearch(
  prisma: PrismaService,
  actor: AuthenticatedUser,
  name: string,
  query: SearchInput,
) {
  return prisma.savedSearch.create({
    data: { userId: actor.id, name, query: query as unknown as Prisma.InputJsonValue },
  });
}

export async function deleteSaved(
  prisma: PrismaService,
  actor: AuthenticatedUser,
  id: string,
) {
  await prisma.savedSearch.deleteMany({ where: { id, userId: actor.id } });
  return { ok: true };
}

// ----- promote between SavedSearch and SavedView -----
//
// History: SavedView and SavedSearch were originally meant to be separate
// models. They've collapsed into one Prisma model (`savedSearch`) where the
// `query.kind` discriminator says which surface the row drives. The
// promote-to-X endpoints copy the query JSON across that discriminator and
// wire `query.linkedId` both directions so the UI can hide the
// "Promote" button once a row is already cross-linked. Both endpoints are
// idempotent: replaying a promote that's already wired returns the existing
// counterpart row instead of creating a duplicate.

export function promoteToView(
  prisma: PrismaService,
  actor: AuthenticatedUser,
  savedSearchId: string,
) {
  return promote(prisma, actor, savedSearchId, 'view');
}

export function promoteToSearch(
  prisma: PrismaService,
  actor: AuthenticatedUser,
  savedViewId: string,
) {
  return promote(prisma, actor, savedViewId, 'search');
}

async function promote(
  prisma: PrismaService,
  actor: AuthenticatedUser,
  sourceId: string,
  targetKind: 'view' | 'search',
) {
  const source = await prisma.savedSearch.findUnique({ where: { id: sourceId } });
  if (!source) throw new NotFoundException('Saved row not found');
  if (source.userId !== actor.id) {
    // Cross-user reads/writes are blocked at every other writeable endpoint;
    // this one is no exception.
    throw new BadRequestException('Not your saved row');
  }
  const srcQuery =
    (source.query as Record<string, unknown> | null) ?? {};
  const linkedId = typeof srcQuery['linkedId'] === 'string' ? (srcQuery['linkedId'] as string) : undefined;
  // Idempotent path: if the cross-link already exists AND points at a row
  // that's still alive AND that row carries the right kind, return it
  // verbatim. Anything else (stale linkedId, dangling, kind drift) falls
  // through to creation.
  if (linkedId) {
    const existing = await prisma.savedSearch.findUnique({ where: { id: linkedId } });
    if (existing && existing.userId === actor.id) {
      const existingQuery = (existing.query as Record<string, unknown> | null) ?? {};
      if (existingQuery['kind'] === targetKind) {
        return existing;
      }
    }
  }
  // Strip prior cross-link metadata so we copy the FILTER JSON, not the
  // bookkeeping. The new row gets its own kind + linkedId.
  const { linkedId: _ignoreLinked, kind: _ignoreKind, ...filterPayload } = srcQuery;
  const target = await prisma.savedSearch.create({
    data: {
      userId: actor.id,
      name: source.name,
      query: {
        ...filterPayload,
        kind: targetKind,
        linkedId: source.id,
      } as Prisma.InputJsonValue,
    },
  });
  // Back-link the source so the inverse promote is a no-op next time.
  await prisma.savedSearch.update({
    where: { id: source.id },
    data: {
      query: {
        ...srcQuery,
        kind: targetKind === 'view' ? 'search' : 'view',
        linkedId: target.id,
      } as Prisma.InputJsonValue,
    },
  });
  return target;
}
