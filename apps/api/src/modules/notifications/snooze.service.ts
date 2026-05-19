import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// NotificationSnoozeService — per-user weekly DND rules. The dispatcher
// consults `isWithinSnoozeWindow` BEFORE enqueueing; matches during the
// window are dropped (NOT deferred — see notification-dispatcher.service.ts
// for the rationale).
//
// Window semantics: `daysOfWeek` is a string array of ISO day tokens
// ('mon'..'sun'). `startHour` / `endHour` are UTC hour-of-day integers
// 0..23. If `endHour < startHour` the window wraps midnight — meaning the
// rule is active from `startHour` today through `endHour` the next day.
// =============================================================================

export const ISO_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type IsoDay = (typeof ISO_DAYS)[number];

export interface SnoozeRuleInput {
  daysOfWeek: IsoDay[];
  startHour: number;
  endHour: number;
  enabled?: boolean;
}

@Injectable()
export class NotificationSnoozeService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- CRUD ----------

  async list(userId: string) {
    return this.prisma.notificationSnoozeRule.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(userId: string, input: SnoozeRuleInput) {
    this.validate(input);
    return this.prisma.notificationSnoozeRule.create({
      data: {
        userId,
        daysOfWeek: input.daysOfWeek,
        startHour: input.startHour,
        endHour: input.endHour,
        enabled: input.enabled ?? true,
      },
    });
  }

  async update(userId: string, id: string, input: Partial<SnoozeRuleInput>) {
    if (
      input.startHour !== undefined &&
      input.endHour !== undefined &&
      input.daysOfWeek
    ) {
      this.validate({
        startHour: input.startHour,
        endHour: input.endHour,
        daysOfWeek: input.daysOfWeek,
      });
    }
    // Scope by userId in the where so cross-user edits are impossible.
    const existing = await this.prisma.notificationSnoozeRule.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== userId) {
      throw new BadRequestException('Rule not found');
    }
    return this.prisma.notificationSnoozeRule.update({
      where: { id },
      data: {
        ...(input.daysOfWeek ? { daysOfWeek: input.daysOfWeek } : {}),
        ...(input.startHour !== undefined ? { startHour: input.startHour } : {}),
        ...(input.endHour !== undefined ? { endHour: input.endHour } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.prisma.notificationSnoozeRule.deleteMany({
      where: { id, userId },
    });
  }

  // ---------- Hot path ----------

  /// Returns true if `now` falls inside ANY enabled rule for the user.
  /// Falls back to false on zero rules so dispatcher cost is one cheap
  /// SELECT for users who never configured DND.
  async isWithinSnoozeWindow(userId: string, now: Date = new Date()): Promise<boolean> {
    const rules = await this.prisma.notificationSnoozeRule.findMany({
      where: { userId, enabled: true },
    });
    if (rules.length === 0) return false;
    return rules.some((r) => isNowInsideRule(r, now));
  }

  private validate(input: SnoozeRuleInput): void {
    if (!Array.isArray(input.daysOfWeek) || input.daysOfWeek.length === 0) {
      throw new BadRequestException('daysOfWeek must list at least one day');
    }
    for (const d of input.daysOfWeek) {
      if (!(ISO_DAYS as readonly string[]).includes(d)) {
        throw new BadRequestException(`Invalid day "${d}"`);
      }
    }
    if (
      !Number.isInteger(input.startHour) ||
      input.startHour < 0 ||
      input.startHour > 23
    ) {
      throw new BadRequestException('startHour must be an integer 0..23');
    }
    if (
      !Number.isInteger(input.endHour) ||
      input.endHour < 0 ||
      input.endHour > 23
    ) {
      throw new BadRequestException('endHour must be an integer 0..23');
    }
    if (input.startHour === input.endHour) {
      throw new BadRequestException(
        'startHour and endHour must differ — a zero-length window is meaningless',
      );
    }
  }
}

// =============================================================================
// Pure logic helpers — exported for the test file to exercise without spinning
// up a Prisma mock.
// =============================================================================

interface RuleShape {
  daysOfWeek: string[];
  startHour: number;
  endHour: number;
}

export function isNowInsideRule(rule: RuleShape, now: Date): boolean {
  const hour = now.getUTCHours();
  const todayKey = ISO_DAYS[now.getUTCDay()];
  if (!todayKey) return false;

  const wraps = rule.endHour < rule.startHour;
  if (!wraps) {
    // Simple window: [startHour, endHour) on the listed days.
    if (!rule.daysOfWeek.includes(todayKey)) return false;
    return hour >= rule.startHour && hour < rule.endHour;
  }

  // Wrapping window — e.g. start=22, end=6 means "10pm today → 6am tomorrow".
  // We're inside the rule when EITHER:
  //   * today is a listed day AND hour >= startHour, OR
  //   * yesterday was a listed day AND hour < endHour.
  // The second branch is what makes the "tomorrow morning" part work.
  const yesterdayKey = ISO_DAYS[(now.getUTCDay() + 6) % 7];
  if (rule.daysOfWeek.includes(todayKey) && hour >= rule.startHour) return true;
  if (yesterdayKey && rule.daysOfWeek.includes(yesterdayKey) && hour < rule.endHour) {
    return true;
  }
  return false;
}
