import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type WorkspaceAiSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';
import { WorkspaceContextService } from '../workspace/workspace-context.service';

// =============================================================================
// Workspace-wide AI knobs. ONE row per workspace (uniqueness enforced by
// migration 0009's UNIQUE INDEX on workspaceId). The legacy global singleton
// shape (`singleton = 1` unique) has been promoted to per-workspace.
//
// Public surface:
//   - `get(actor)` — returns the actor's workspace row, creating it on first
//     call.
//   - `update(actor, patch)` — Admin only; clamps numeric ranges before write.
//   - `getDupThreshold(workspaceId)` — cached 30s helper used by the
//     duplicate processor.
//   - `getEffectiveProvider(workspaceId, env, anthropicConfigured)` —
//     resolves `modelPreference` against env.
//
// Cache keyed by workspaceId. A workspace's settings change rarely; 30s TTL
// is long enough to absorb a request burst, short enough that a freshly-
// applied admin patch shows up to the duplicate processor within a minute.
// =============================================================================

export interface PriorityWeights {
  deadline: number;
  blocked: number;
  customerImpact: number;
  [key: string]: number;
}

export type ModelPreference = 'auto' | 'ollama' | 'anthropic';

export interface AiSettingsPatch {
  dupThreshold?: number;
  priorityWeights?: PriorityWeights;
  autoSuggestEnabled?: boolean;
  modelPreference?: ModelPreference;
}

const CACHE_TTL_MS = 30 * 1000;
const DUP_THRESHOLD_MIN = 0.7;
const DUP_THRESHOLD_MAX = 0.99;
const WEIGHT_MIN = 0;
const WEIGHT_MAX = 5;

interface CacheEntry {
  value: WorkspaceAiSettings;
  at: number;
}

@Injectable()
export class WorkspaceAiSettingsService {
  private readonly logger = new Logger(WorkspaceAiSettingsService.name);
  /** Per-workspace cache. Keyed by workspaceId so multi-tenant deployments
   *  don't accidentally serve W1's threshold to W2's processor. */
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceCtx?: WorkspaceContextService,
  ) {}

  /**
   * Read the per-workspace row. Creates it on first call with the schema
   * defaults. `updatedById` is set to the supplied actor when present;
   * otherwise we fall back to any Admin user in the workspace.
   *
   * The `actorUserId` parameter, when supplied, also resolves the
   * workspaceId via WorkspaceContextService. Callers that already know
   * their workspace can pass it as a second arg to skip the lookup —
   * useful for cron/processor paths that aren't user-initiated.
   */
  async get(
    actorUserId?: string,
    explicitWorkspaceId?: string,
  ): Promise<WorkspaceAiSettings> {
    const workspaceId = await this.resolveWorkspaceId(actorUserId, explicitWorkspaceId);
    const cached = this.cache.get(workspaceId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
    let row = await this.prisma.workspaceAiSettings.findUnique({
      where: { workspaceId },
    });
    if (!row) {
      // First call ever for this workspace. Try to derive a sensible
      // `updatedById`: caller > any Admin > error.
      const fallbackUserId = actorUserId ?? (await this.firstAdminUserId());
      if (!fallbackUserId) {
        throw new Error(
          'Cannot bootstrap WorkspaceAiSettings: no actor and no Admin user exists yet',
        );
      }
      row = await this.prisma.workspaceAiSettings.create({
        data: {
          singleton: 1,
          workspaceId,
          updatedById: fallbackUserId,
        },
      });
    }
    this.cache.set(workspaceId, { value: row, at: Date.now() });
    return row;
  }

  /**
   * Admin-only patch. Validates ranges; throws on invalid input so the
   * controller returns 400, not 500. Scoped to the actor's workspace —
   * an Admin in W1 cannot patch W2.
   */
  async update(
    actor: AuthenticatedUser,
    patch: AiSettingsPatch,
  ): Promise<WorkspaceAiSettings> {
    if (!(actor.kind === 'internal' && actor.companyRole === 'Admin')) {
      throw new ForbiddenException('Admin only');
    }

    const workspaceId = await this.resolveWorkspaceId(actor.id);
    const data: Prisma.WorkspaceAiSettingsUpdateInput = { updatedById: actor.id };
    if (patch.dupThreshold !== undefined) {
      data.dupThreshold = clamp(patch.dupThreshold, DUP_THRESHOLD_MIN, DUP_THRESHOLD_MAX);
    }
    if (patch.priorityWeights !== undefined) {
      data.priorityWeights = clampWeights(patch.priorityWeights);
    }
    if (patch.autoSuggestEnabled !== undefined) {
      data.autoSuggestEnabled = patch.autoSuggestEnabled;
    }
    if (patch.modelPreference !== undefined) {
      data.modelPreference = patch.modelPreference;
    }

    // Ensure the row exists before update. We use the same get() path so the
    // first-write also works as a bootstrap.
    await this.get(actor.id);
    const updated = await this.prisma.workspaceAiSettings.update({
      where: { workspaceId },
      data,
    });
    this.cache.set(workspaceId, { value: updated, at: Date.now() });
    return updated;
  }

  /** Helper used by the duplicate processor. Cached, see CACHE_TTL_MS.
   *  Accepts an explicit workspaceId so background processors (no actor
   *  context) can resolve their workspace via the event payload or a
   *  static default. */
  async getDupThreshold(workspaceId?: string): Promise<number> {
    const settings = await this.get(undefined, workspaceId);
    return settings.dupThreshold;
  }

  /**
   * Resolve the actually-used LLM provider. `auto` defers to env; concrete
   * providers override only when their credentials are present, otherwise
   * we fall back to the env default (so a misconfigured workspace doesn't
   * silently break every AI call).
   */
  async getEffectiveProvider(
    envProvider: 'ollama' | 'anthropic',
    anthropicConfigured: boolean,
    workspaceId?: string,
  ): Promise<'ollama' | 'anthropic'> {
    const settings = await this.get(undefined, workspaceId);
    const pref = settings.modelPreference as ModelPreference;
    if (pref === 'anthropic' && anthropicConfigured) return 'anthropic';
    if (pref === 'ollama') return 'ollama';
    return envProvider;
  }

  /** Test/dev hook: forget every cached row. */
  invalidate(): void {
    this.cache.clear();
  }

  // ---- internal --------------------------------------------------------

  /**
   * Determine the workspaceId for a get/update call.
   *
   * Order of precedence:
   *   1. `explicitWorkspaceId` argument — used by background processors
   *      that know their tenant from the event payload.
   *   2. WorkspaceContextService.resolveForUser(actorUserId) — the
   *      normal path for controllers calling on behalf of an authenticated
   *      user.
   *   3. WorkspaceContextService.getDefault() — fallback for legacy
   *      bootstrap calls (e.g. AI-cron firing before any user exists).
   *   4. The bare 'default' constant — final safety net for tests that
   *      construct this service without a WorkspaceContextService.
   */
  private async resolveWorkspaceId(
    actorUserId?: string,
    explicitWorkspaceId?: string,
  ): Promise<string> {
    if (explicitWorkspaceId) return explicitWorkspaceId;
    if (this.workspaceCtx && actorUserId) {
      return this.workspaceCtx.resolveForUser(actorUserId);
    }
    if (this.workspaceCtx) {
      return this.workspaceCtx.getDefault();
    }
    return 'default';
  }

  private async firstAdminUserId(): Promise<string | null> {
    const admin = await this.prisma.user.findFirst({
      where: { kind: 'internal', companyRole: 'Admin', archivedAt: null },
      select: { id: true },
    });
    return admin?.id ?? null;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampWeights(weights: PriorityWeights): PriorityWeights {
  const out: PriorityWeights = { deadline: 1, blocked: 2, customerImpact: 1.5 };
  for (const [k, v] of Object.entries(weights)) {
    out[k] = clamp(typeof v === 'number' ? v : Number(v), WEIGHT_MIN, WEIGHT_MAX);
  }
  return out;
}
