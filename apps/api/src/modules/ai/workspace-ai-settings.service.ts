import { ForbiddenException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import type { Prisma} from '@prisma/client';
import { type WorkspaceAiSettings } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types';

// =============================================================================
// AI knobs. Singleton row (uniqueness enforced by `singleton` column).
//
// Public surface:
//   - `get(actor)` — returns the row, creating it on first call.
//   - `update(actor, patch)` — Admin only; clamps numeric ranges before write.
//   - `getDupThreshold()` — cached 30s helper used by the duplicate processor.
//   - `getEffectiveProvider(env, anthropicConfigured)` — resolves
//     `modelPreference` against env.
//
// Cache TTL = 30s. Long enough to absorb a request burst, short enough that
// a freshly-applied admin patch shows up to the duplicate processor within a
// minute.
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
  private cache: CacheEntry | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the singleton row. Creates it on first call with the schema
   * defaults. `updatedById` is set to the supplied actor when present;
   * otherwise we fall back to any Admin user.
   */
  async get(actorUserId?: string): Promise<WorkspaceAiSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.value;
    }
    let row = await this.prisma.workspaceAiSettings.findUnique({
      where: { singleton: 1 },
    });
    if (!row) {
      // First call ever. Try to derive a sensible `updatedById`:
      // caller > any Admin > error.
      const fallbackUserId = actorUserId ?? (await this.firstAdminUserId());
      if (!fallbackUserId) {
        throw new InternalServerErrorException(
          'Cannot bootstrap WorkspaceAiSettings: no actor and no Admin user exists yet',
        );
      }
      row = await this.prisma.workspaceAiSettings.create({
        data: {
          singleton: 1,
          updatedById: fallbackUserId,
        },
      });
    }
    this.cache = { value: row, at: Date.now() };
    return row;
  }

  /**
   * Admin-only patch. Validates ranges; throws on invalid input so the
   * controller returns 400, not 500.
   */
  async update(
    actor: AuthenticatedUser,
    patch: AiSettingsPatch,
  ): Promise<WorkspaceAiSettings> {
    if (!(actor.kind === 'internal' && actor.companyRole === 'Admin')) {
      throw new ForbiddenException('Admin only');
    }

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
      where: { singleton: 1 },
      data,
    });
    this.cache = { value: updated, at: Date.now() };
    return updated;
  }

  /** Helper used by the duplicate processor. Cached, see CACHE_TTL_MS. */
  async getDupThreshold(): Promise<number> {
    const settings = await this.get();
    return settings.dupThreshold;
  }

  /**
   * Resolve the actually-used LLM provider. `auto` defers to env; concrete
   * providers override only when their credentials are present, otherwise
   * we fall back to the env default.
   */
  async getEffectiveProvider(
    envProvider: 'ollama' | 'anthropic',
    anthropicConfigured: boolean,
  ): Promise<'ollama' | 'anthropic'> {
    const settings = await this.get();
    const pref = settings.modelPreference as ModelPreference;
    if (pref === 'anthropic' && anthropicConfigured) return 'anthropic';
    if (pref === 'ollama') return 'ollama';
    return envProvider;
  }

  /** Test/dev hook: forget the cached row. */
  invalidate(): void {
    this.cache = null;
  }

  // ---- internal --------------------------------------------------------

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
