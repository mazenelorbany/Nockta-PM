import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/types';

/**
 * Project ids the actor can read. Mirrors the same predicate used by
 * SearchService so analytics scopes match what users see in search.
 */
export async function accessibleProjectIds(
  prisma: PrismaService,
  actor: AuthenticatedUser,
): Promise<string[]> {
  if (actor.kind === 'internal' && actor.companyRole === 'Admin') {
    const all = await prisma.project.findMany({
      where: { archivedAt: null }, select: { id: true },
    });
    return all.map((p) => p.id);
  }
  if (actor.kind === 'internal') {
    const memberships = await prisma.teamMember.findMany({
      where: { userId: actor.id }, select: { teamId: true },
    });
    const teamIds = memberships.map((m) => m.teamId);
    const projects = await prisma.project.findMany({
      where: {
        archivedAt: null,
        OR: [
          { visibility: 'public' },
          { accessGrants: { some: { userId: actor.id, subjectKind: 'user' } } },
          ...(teamIds.length > 0
            ? [{ accessGrants: { some: { subjectKind: 'team' as const, teamId: { in: teamIds } } } }]
            : []),
        ],
      },
      select: { id: true },
    });
    return projects.map((p) => p.id);
  }
  const projects = await prisma.project.findMany({
    where: {
      archivedAt: null,
      accessGrants: { some: { userId: actor.id, role: 'Client', subjectKind: 'user' } },
    },
    select: { id: true },
  });
  return projects.map((p) => p.id);
}
