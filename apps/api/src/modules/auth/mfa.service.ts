import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from './audit-log.service';
import { TotpService } from './totp.service';

// =============================================================================
// MfaService — TOTP enrollment, verification, and disable flow.
//
// Enroll: generate secret + 10 backup codes → store encrypted secret +
// sha256 hashes; set mfaEnabled=false until the user verifies the first code
// (so a partial enrollment doesn't lock anyone out).
//
// Verify: accept TOTP OR a backup code. Backup codes are consumed in place
// (matching hash removed from the array). Replay protection lives in
// TotpService.isReplay — same code within the same 30s step is rejected.
//
// MFA-pending token: a short-lived JWT issued after primary auth when the
// user has MFA enabled. Carries `purpose: 'mfa'` so it can't be used as a
// real access token by /mfa/verify or anything else.
// =============================================================================

const MFA_PENDING_PURPOSE = 'mfa' as const;

interface MfaPendingPayload {
  sub: string;
  purpose: typeof MFA_PENDING_PURPOSE;
}

export interface EnrollStartResult {
  qrUrl: string;
  secret: string;
  backupCodes: string[];
}

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly totp: TotpService,
    private readonly audit: AuditLogService,
  ) {}

  // ---------- Enroll ----------

  /// Step 1 — generate a fresh secret and backup codes, store them as
  /// pending (mfaEnabled stays false). Returns the QR URL + raw codes to
  /// show the user once. The caller is expected to follow up with verifyEnrollment.
  async startEnrollment(userId: string): Promise<EnrollStartResult> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, mfaEnabled: true },
    });
    if (user.mfaEnabled) {
      throw new BadRequestException(
        'MFA is already enabled. Disable it first to re-enroll.',
      );
    }
    const secret = this.totp.generateSecret();
    const { raw, hashed } = this.totp.generateBackupCodes(10);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpSecret: this.totp.encryptSecret(secret),
        mfaBackupCodes: hashed,
        // mfaEnabled stays false until verifyEnrollment succeeds.
      },
    });
    const qrUrl = this.totp.buildOtpAuthUrl(user.email, secret);
    return { qrUrl, secret, backupCodes: raw };
  }

  /// Step 2 — user submits the first 6-digit code. We verify against the
  /// just-stored secret and flip mfaEnabled=true. After this point the
  /// user MUST present a TOTP (or backup code) on every login.
  async verifyEnrollment(
    userId: string,
    code: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ enabled: true }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, mfaEnabled: true },
    });
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled.');
    }
    if (!user.totpSecret) {
      throw new BadRequestException('MFA enrollment has not been started.');
    }
    const secret = this.totp.decryptSecret(user.totpSecret);
    const { valid, step } = this.totp.verifyCode(secret, code);
    if (!valid || step === null) {
      await this.audit.record({
        userId,
        action: 'mfa.failed',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { stage: 'enroll' },
      });
      throw new UnauthorizedException('Invalid TOTP code');
    }
    // Stamp the step so a replay within ~90s of the enrollment success
    // can't be re-used as a login. Same rule as the login path.
    await this.totp.isReplay(userId, step);
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });
    await this.audit.record({
      userId,
      action: 'mfa.enrolled',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { enabled: true };
  }

  // ---------- Pending-token issuance + verification ----------

  /// Issue the short-lived "MFA challenge" token used between primary auth
  /// and TOTP verify. Carries purpose='mfa' so it can't be confused with a
  /// real access token. Caller stores the user id only.
  async issuePendingToken(userId: string): Promise<string> {
    const payload: MfaPendingPayload = { sub: userId, purpose: MFA_PENDING_PURPOSE };
    return this.jwt.signAsync(payload, {
      secret: Env.JWT_ACCESS_SECRET,
      expiresIn: Env.MFA_PENDING_TTL_SECONDS,
    });
  }

  /// Verify a TOTP or backup code against a pending-token. The pending token
  /// itself is validated (correct signature + purpose='mfa' + not expired)
  /// before the code is checked, so a regular access token won't be honored
  /// here even if it happens to be signed with the same JWT secret.
  async verifyMfaChallenge(
    pendingToken: string,
    code: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ userId: string }> {
    let payload: MfaPendingPayload;
    try {
      payload = await this.jwt.verifyAsync<MfaPendingPayload>(pendingToken, {
        secret: Env.JWT_ACCESS_SECRET,
      });
    } catch {
      throw new UnauthorizedException('MFA challenge expired or invalid');
    }
    if (payload.purpose !== MFA_PENDING_PURPOSE) {
      // A regular access token (purpose undefined) MUST NOT pass here. This
      // is the single line that prevents privilege escalation by replaying
      // an existing access token at /auth/mfa/verify.
      throw new UnauthorizedException('Token is not an MFA challenge');
    }
    const userId = payload.sub;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, totpSecret: true, mfaEnabled: true, mfaBackupCodes: true },
    });
    if (!user || !user.mfaEnabled || !user.totpSecret) {
      throw new UnauthorizedException('MFA not configured for this user');
    }

    const normalized = code.trim();
    // 1) Try TOTP first — it's the common path. 6 digits exactly.
    if (/^\d{6}$/.test(normalized)) {
      const secret = this.totp.decryptSecret(user.totpSecret);
      const { valid, step } = this.totp.verifyCode(secret, normalized);
      if (valid && step !== null) {
        const replay = await this.totp.isReplay(userId, step);
        if (replay) {
          await this.audit.record({
            userId,
            action: 'mfa.failed',
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            metadata: { reason: 'replay' },
          });
          throw new UnauthorizedException('TOTP code already used');
        }
        await this.audit.record({
          userId,
          action: 'mfa.verified',
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          metadata: { method: 'totp' },
        });
        return { userId };
      }
    }

    // 2) Backup code. Match against the stored hash list and consume on hit.
    const idx = this.totp.matchBackupCode(normalized, user.mfaBackupCodes);
    if (idx >= 0) {
      const remaining = user.mfaBackupCodes.filter((_, i) => i !== idx);
      await this.prisma.user.update({
        where: { id: userId },
        data: { mfaBackupCodes: remaining },
      });
      await this.audit.record({
        userId,
        action: 'mfa.backup_code_used',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { remaining: remaining.length },
      });
      return { userId };
    }

    await this.audit.record({
      userId,
      action: 'mfa.failed',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw new UnauthorizedException('Invalid MFA code');
  }

  // ---------- Disable ----------

  /// Disable MFA. Requires a valid TOTP/backup code to prevent an attacker
  /// who has stolen a session from removing the second factor.
  async disable(
    userId: string,
    code: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ enabled: false }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, mfaEnabled: true, mfaBackupCodes: true },
    });
    if (!user.mfaEnabled || !user.totpSecret) {
      throw new BadRequestException('MFA is not enabled.');
    }
    const normalized = code.trim();
    let ok = false;
    if (/^\d{6}$/.test(normalized)) {
      const secret = this.totp.decryptSecret(user.totpSecret);
      const { valid, step } = this.totp.verifyCode(secret, normalized);
      if (valid && step !== null && !(await this.totp.isReplay(userId, step))) {
        ok = true;
      }
    }
    if (!ok && this.totp.matchBackupCode(normalized, user.mfaBackupCodes) >= 0) {
      ok = true;
    }
    if (!ok) {
      await this.audit.record({
        userId,
        action: 'mfa.failed',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { stage: 'disable' },
      });
      throw new UnauthorizedException('Invalid MFA code');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, totpSecret: null, mfaBackupCodes: [] },
    });
    await this.audit.record({
      userId,
      action: 'mfa.disabled',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { enabled: false };
  }
}
