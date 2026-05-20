import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { AuthenticatedUser } from '../auth/types';
import { defaultTransitionsFor } from '../tasks/workflow';

// =============================================================================
// ProjectWorkflowService — runtime source of truth for a project's columns,
// statuses, and the bridge between them. Replaces the preset-string lookups
// (`WORKFLOW_STATUSES`) that used to live in tasks/workflow.ts; that file
// keeps the preset DEFAULTS so we can seed new projects + reset to defaults
// without re-querying the DB.
//
// Naming convention
// -----------------
// `Task.status` is a string holding the status' NAME (not its id). The name
// is unique per project (enforced by Prisma @@unique). Renaming a status
// therefore needs to cascade across:
//   1. ProjectStatus.name
//   2. Task.status (every task currently in that status)
//   3. ProjectWorkflowTransition.fromStatus / .toStatus
// We do that in one $transaction in `renameStatus()` so concurrent reads
// never see a half-renamed state.
//
// Deletion semantics
// ------------------
// A status cannot be deleted while any task is still in it — the service
// returns a friendly 409 with the task count so the UI can offer "move N
// tasks to ___ first". A column cannot be deleted while it still contains
// statuses; you have to move or delete the statuses first.
// =============================================================================

export interface ColumnDto {
  id: string;
  name: string;
  position: number;
  color: string | null;
}

export interface StatusDto {
  id: string;
  columnId: string;
  name: string;
  position: number;
  color: string | null;
  isInitialStatus: boolean;
  isDoneStatus: boolean;
}

export interface WorkflowSnapshot {
  columns: ColumnDto[];
  statuses: StatusDto[];
}

/**
 * Hardcoded preset defaults for seeding a fresh project + resetting an
 * existing one. Mirrors migration 0029 — keep them in sync. The shape is
 * (column name, isDone? – the initial status is always position 0).
 */
const PRESET_DEFAULTS: Record<
  'engineering' | 'design' | 'generic',
  ReadonlyArray<{ name: string; isDone: boolean }>
> = {
  engineering: [
    { name: 'Todo', isDone: false },
    { name: 'In Progress', isDone: false },
    { name: 'In Review', isDone: false },
    { name: 'Testing', isDone: false },
    { name: 'Done', isDone: true },
  ],
  design: [
    { name: 'Todo', isDone: false },
    { name: 'In Progress', isDone: false },
    { name: 'In Review', isDone: false },
    { name: 'Approved', isDone: true },
    { name: 'Done', isDone: true },
  ],
  generic: [
    { name: 'Todo', isDone: false },
    { name: 'In Progress', isDone: false },
    { name: 'Done', isDone: true },
  ],
};

const MAX_NAME_LEN = 60;

@Injectable()
export class ProjectWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  // ----- reads -----

  async snapshot(actor: AuthenticatedUser, projectId: string): Promise<WorkflowSnapshot> {
    await this.permissions.assertAtLeast(actor, projectId, 'Viewer');
    return this.snapshotInternal(this.prisma, projectId);
  }

  private async snapshotInternal(
    db: PrismaService | Prisma.TransactionClient,
    projectId: string,
  ): Promise<WorkflowSnapshot> {
    const [cols, sts] = await Promise.all([
      db.projectColumn.findMany({
        where: { projectId },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, position: true, color: true },
      }),
      db.projectStatus.findMany({
        where: { projectId },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          columnId: true,
          name: true,
          position: true,
          color: true,
          isInitialStatus: true,
          isDoneStatus: true,
        },
      }),
    ]);
    return { columns: cols, statuses: sts };
  }

  // ----- name lookups used by tasks.service -----

  async statusNames(projectId: string): Promise<{
    valid: Set<string>;
    initial: string | null;
    done: Set<string>;
  }> {
    const sts = await this.prisma.projectStatus.findMany({
      where: { projectId },
      select: { name: true, isInitialStatus: true, isDoneStatus: true, position: true },
      orderBy: { position: 'asc' },
    });
    const valid = new Set(sts.map((s) => s.name));
    const done = new Set(sts.filter((s) => s.isDoneStatus).map((s) => s.name));
    const initial = sts.find((s) => s.isInitialStatus)?.name ?? sts[0]?.name ?? null;
    return { valid, initial, done };
  }

  // ----- columns CRUD -----

  async createColumn(
    actor: AuthenticatedUser,
    projectId: string,
    input: { name: string; color?: string | null; position?: number },
  ): Promise<ColumnDto> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const name = this.sanitizeName(input.name);
    const existing = await this.prisma.projectColumn.findFirst({
      where: { projectId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = input.position ?? (existing ? existing.position + 1 : 0);
    try {
      const c = await this.prisma.projectColumn.create({
        data: { projectId, name, position, color: input.color ?? null },
        select: { id: true, name: true, position: true, color: true },
      });
      return c;
    } catch (e) {
      throw this.mapUniqueError(e, 'A column with this name already exists');
    }
  }

  async renameColumn(
    actor: AuthenticatedUser,
    projectId: string,
    columnId: string,
    name: string,
  ): Promise<ColumnDto> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const sanitized = this.sanitizeName(name);
    const existing = await this.prisma.projectColumn.findUnique({
      where: { id: columnId },
      select: { projectId: true },
    });
    if (!existing || existing.projectId !== projectId) throw new NotFoundException('Column not found');
    try {
      const updated = await this.prisma.projectColumn.update({
        where: { id: columnId },
        data: { name: sanitized },
        select: { id: true, name: true, position: true, color: true },
      });
      return updated;
    } catch (e) {
      throw this.mapUniqueError(e, 'Another column already uses this name');
    }
  }

  async reorderColumns(
    actor: AuthenticatedUser,
    projectId: string,
    orderedIds: string[],
  ): Promise<ColumnDto[]> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const existing = await this.prisma.projectColumn.findMany({
      where: { projectId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((c) => c.id));
    if (
      orderedIds.length !== existing.length ||
      orderedIds.some((id) => !existingIds.has(id))
    ) {
      throw new BadRequestException(
        'orderedIds must contain every column id for this project exactly once',
      );
    }
    await this.prisma.$transaction(
      orderedIds.map((id, i) =>
        this.prisma.projectColumn.update({ where: { id }, data: { position: i } }),
      ),
    );
    return this.prisma.projectColumn.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
      select: { id: true, name: true, position: true, color: true },
    });
  }

  async deleteColumn(actor: AuthenticatedUser, projectId: string, columnId: string): Promise<void> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const col = await this.prisma.projectColumn.findUnique({
      where: { id: columnId },
      select: { projectId: true, statuses: { select: { id: true } } },
    });
    if (!col || col.projectId !== projectId) throw new NotFoundException('Column not found');
    if (col.statuses.length > 0) {
      throw new ConflictException({
        message:
          'Move or delete the statuses inside this column first; deleting a column with statuses would orphan tasks.',
        statusCount: col.statuses.length,
      });
    }
    await this.prisma.projectColumn.delete({ where: { id: columnId } });
  }

  // ----- statuses CRUD -----

  async createStatus(
    actor: AuthenticatedUser,
    projectId: string,
    input: {
      columnId: string;
      name: string;
      color?: string | null;
      isInitialStatus?: boolean;
      isDoneStatus?: boolean;
      position?: number;
    },
  ): Promise<StatusDto> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const name = this.sanitizeName(input.name);
    const col = await this.prisma.projectColumn.findUnique({
      where: { id: input.columnId },
      select: { projectId: true },
    });
    if (!col || col.projectId !== projectId) {
      throw new BadRequestException('columnId does not belong to this project');
    }
    const tail = await this.prisma.projectStatus.findFirst({
      where: { projectId, columnId: input.columnId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = input.position ?? (tail ? tail.position + 1 : 0);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // If isInitialStatus=true, demote any other initial first so the
        // "exactly one initial per project" invariant holds without needing
        // a partial unique index.
        if (input.isInitialStatus) {
          await tx.projectStatus.updateMany({
            where: { projectId, isInitialStatus: true },
            data: { isInitialStatus: false },
          });
        }
        return tx.projectStatus.create({
          data: {
            projectId,
            columnId: input.columnId,
            name,
            position,
            color: input.color ?? null,
            isInitialStatus: input.isInitialStatus ?? false,
            isDoneStatus: input.isDoneStatus ?? false,
          },
          select: {
            id: true,
            columnId: true,
            name: true,
            position: true,
            color: true,
            isInitialStatus: true,
            isDoneStatus: true,
          },
        });
      });
    } catch (e) {
      throw this.mapUniqueError(e, 'A status with this name already exists');
    }
  }

  /**
   * Update a status. Renames cascade across Task.status and the workflow
   * transition table in a single $transaction so reads can't see a
   * half-renamed state.
   */
  async updateStatus(
    actor: AuthenticatedUser,
    projectId: string,
    statusId: string,
    patch: {
      name?: string;
      columnId?: string;
      color?: string | null;
      isInitialStatus?: boolean;
      isDoneStatus?: boolean;
      position?: number;
    },
  ): Promise<StatusDto> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const existing = await this.prisma.projectStatus.findUnique({
      where: { id: statusId },
      select: { projectId: true, name: true, columnId: true },
    });
    if (!existing || existing.projectId !== projectId) throw new NotFoundException('Status not found');

    const newName = patch.name !== undefined ? this.sanitizeName(patch.name) : existing.name;
    const renaming = patch.name !== undefined && newName !== existing.name;

    if (patch.columnId !== undefined && patch.columnId !== existing.columnId) {
      const col = await this.prisma.projectColumn.findUnique({
        where: { id: patch.columnId },
        select: { projectId: true },
      });
      if (!col || col.projectId !== projectId) {
        throw new BadRequestException('columnId does not belong to this project');
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (patch.isInitialStatus === true) {
          // Demote other initial statuses first.
          await tx.projectStatus.updateMany({
            where: { projectId, isInitialStatus: true, NOT: { id: statusId } },
            data: { isInitialStatus: false },
          });
        }

        if (renaming) {
          // Cascade the new name to tasks + transitions BEFORE updating the
          // status row, so a reader observing the row update + the
          // transition tables midway doesn't see a stale (status,
          // transition) pair.
          await tx.task.updateMany({
            where: { projectId, status: existing.name },
            data: { status: newName },
          });
          await tx.projectWorkflowTransition.updateMany({
            where: { projectId, fromStatus: existing.name },
            data: { fromStatus: newName },
          });
          await tx.projectWorkflowTransition.updateMany({
            where: { projectId, toStatus: existing.name },
            data: { toStatus: newName },
          });
        }

        return tx.projectStatus.update({
          where: { id: statusId },
          data: {
            ...(patch.name !== undefined ? { name: newName } : {}),
            ...(patch.columnId !== undefined ? { columnId: patch.columnId } : {}),
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.isInitialStatus !== undefined ? { isInitialStatus: patch.isInitialStatus } : {}),
            ...(patch.isDoneStatus !== undefined ? { isDoneStatus: patch.isDoneStatus } : {}),
            ...(patch.position !== undefined ? { position: patch.position } : {}),
          },
          select: {
            id: true,
            columnId: true,
            name: true,
            position: true,
            color: true,
            isInitialStatus: true,
            isDoneStatus: true,
          },
        });
      });
    } catch (e) {
      throw this.mapUniqueError(e, 'Another status already uses this name');
    }
  }

  async deleteStatus(actor: AuthenticatedUser, projectId: string, statusId: string): Promise<void> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const status = await this.prisma.projectStatus.findUnique({
      where: { id: statusId },
      select: { projectId: true, name: true, isInitialStatus: true },
    });
    if (!status || status.projectId !== projectId) throw new NotFoundException('Status not found');
    if (status.isInitialStatus) {
      throw new ConflictException(
        'Cannot delete the initial status — mark another status as initial first.',
      );
    }
    const taskCount = await this.prisma.task.count({
      where: { projectId, status: status.name },
    });
    if (taskCount > 0) {
      throw new ConflictException({
        message: `Cannot delete a status with ${taskCount} task${taskCount === 1 ? '' : 's'} still in it. Move the tasks to a different status first.`,
        taskCount,
      });
    }
    // Cascade-drop any transitions referencing this status name so the
    // workflow matrix doesn't reference a ghost edge afterwards.
    await this.prisma.$transaction([
      this.prisma.projectWorkflowTransition.deleteMany({
        where: {
          projectId,
          OR: [{ fromStatus: status.name }, { toStatus: status.name }],
        },
      }),
      this.prisma.projectStatus.delete({ where: { id: statusId } }),
    ]);
  }

  // ----- reset / seed -----

  /**
   * Seed default columns + statuses for a freshly-created project. Called
   * from ProjectsService.create + createFromTemplate inside the same
   * transaction that creates the project row (we accept a tx client so
   * the seeding is atomic with the project insert).
   */
  async seedDefaults(
    tx: Prisma.TransactionClient,
    projectId: string,
    preset: 'engineering' | 'design' | 'generic',
  ): Promise<void> {
    const defs = PRESET_DEFAULTS[preset];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      if (!def) continue;
      const col = await tx.projectColumn.create({
        data: { projectId, name: def.name, position: i },
        select: { id: true },
      });
      await tx.projectStatus.create({
        data: {
          projectId,
          columnId: col.id,
          name: def.name,
          position: 0,
          isInitialStatus: i === 0,
          isDoneStatus: def.isDone,
        },
      });
    }
    // Also seed transitions — the workflow-transition feature shipped
    // earlier already does this on project create, but call sites that
    // hit seedDefaults directly (e.g. resetWorkflow) need it too.
    const edges = defaultTransitionsFor(preset);
    if (edges.length > 0) {
      await tx.projectWorkflowTransition.createMany({
        data: edges.map(([fromStatus, toStatus]) => ({ projectId, fromStatus, toStatus })),
      });
    }
  }

  /**
   * Reset columns + statuses + transitions back to the project's preset
   * defaults. Refuses if any task is in a status outside the preset's
   * default set (otherwise tasks would be silently orphaned).
   */
  async resetToDefaults(actor: AuthenticatedUser, projectId: string): Promise<WorkflowSnapshot> {
    await this.permissions.assertAtLeast(actor, projectId, 'Manager');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workflowPreset: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const presetNames = new Set(PRESET_DEFAULTS[project.workflowPreset].map((d) => d.name));
    const offending = await this.prisma.task.findMany({
      where: { projectId, status: { notIn: Array.from(presetNames) } },
      select: { id: true, status: true },
      take: 5,
    });
    if (offending.length > 0) {
      const statuses = Array.from(new Set(offending.map((t) => t.status)));
      throw new ConflictException({
        message:
          `Reset would orphan tasks currently in non-default status(es): ${statuses.join(', ')}. ` +
          'Move those tasks first.',
        offendingStatuses: statuses,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.projectStatus.deleteMany({ where: { projectId } });
      await tx.projectColumn.deleteMany({ where: { projectId } });
      await tx.projectWorkflowTransition.deleteMany({ where: { projectId } });
      await this.seedDefaults(tx, projectId, project.workflowPreset);
    });
    return this.snapshot(actor, projectId);
  }

  // ----- helpers -----

  private sanitizeName(name: string): string {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > MAX_NAME_LEN) {
      throw new BadRequestException(`Name too long (max ${MAX_NAME_LEN} characters)`);
    }
    return trimmed;
  }

  private mapUniqueError(err: unknown, message: string): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException(message);
    }
    return err as Error;
  }
}
