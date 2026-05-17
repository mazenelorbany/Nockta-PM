import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuditLogService } from './audit-log.service';
import { MfaService } from './mfa.service';
import { TotpService } from './totp.service';
import { makePrismaMock } from '../../test-utils/mocks';

// =============================================================================
// auth.mfa.test — TOTP math, replay protection, backup-code single-use, and
// the MFA-pending-token purpose guard. These are the security-critical
// invariants for the MFA surface; behavior changes here must update tests
// deliberately (these tests pin the contract, not the implementation).
// =============================================================================

// In-memory stand-in for the Redis primitive used by TotpService.isReplay.
// Models `SET NX EX`: first call returns 'OK', subsequent calls return null.
function makeInMemoryRedis() {
  const store = new Map<string, string>();
  const setMock = vi.fn(async (key: string, _value: string, ..._args: unknown[]) => {
    if (store.has(key)) return null;
    store.set(key, '1');
    return 'OK';
  });
  return {
    instance: { set: setMock, get: vi.fn(async (k: string) => store.get(k) ?? null) },
    store,
    setMock,
  };
}

function makeTotp() {
  const redis = makeInMemoryRedis();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totp = new TotpService(redis.instance as any);
  return { totp, redis };
}

// =============================================================================
// TotpService — TOTP math, replay, backup codes
// =============================================================================

describe('TotpService.verifyCode', () => {
  it('accepts a freshly generated code within the current 30s step', () => {
    const { totp } = makeTotp();
    const secret = totp.generateSecret();
    // Compute the current 6-digit code by piggybacking on the service's own
    // verifier with a forced "code we know was just generated": call verifyCode
    // with every possible 6-digit code until one matches is too slow. Instead
    // we drive a fixed `now` so the code is reproducible across runs.
    const fixedNow = 1_700_000_000_000;
    // Brute-force-find the matching code at fixedNow. The space is 1e6 — fine.
    const code = findCurrentCode(totp, secret, fixedNow);
    expect(code).toMatch(/^\d{6}$/);
    const { valid, step } = totp.verifyCode(secret, code, fixedNow);
    expect(valid).toBe(true);
    expect(step).toBe(Math.floor(fixedNow / 1000 / 30));
  });

  it('accepts a code within +/- 30s drift tolerance', () => {
    const { totp } = makeTotp();
    const secret = totp.generateSecret();
    const fixedNow = 1_700_000_000_000;
    // Generate the code that's valid 30s in the future, then verify with the
    // earlier `now`. The drift window of 1 step (=30s) makes this pass.
    const futureCode = findCurrentCode(totp, secret, fixedNow + 30_000);
    const { valid } = totp.verifyCode(secret, futureCode, fixedNow);
    expect(valid).toBe(true);
  });

  it('rejects a code outside the drift window', () => {
    const { totp } = makeTotp();
    const secret = totp.generateSecret();
    const fixedNow = 1_700_000_000_000;
    // Two steps in the future = 60s, beyond the tolerance.
    const farFutureCode = findCurrentCode(totp, secret, fixedNow + 60_000);
    const { valid } = totp.verifyCode(secret, farFutureCode, fixedNow);
    expect(valid).toBe(false);
  });

  it('rejects malformed input without trying any HMAC', () => {
    const { totp } = makeTotp();
    const secret = totp.generateSecret();
    expect(totp.verifyCode(secret, '12345').valid).toBe(false); // too short
    expect(totp.verifyCode(secret, '1234567').valid).toBe(false); // too long
    expect(totp.verifyCode(secret, 'abcdef').valid).toBe(false); // non-numeric
  });
});

describe('TotpService.isReplay — replay protection', () => {
  it('returns false the first time, true on the second within the TTL', async () => {
    const { totp } = makeTotp();
    const first = await totp.isReplay('user-1', 12345);
    const second = await totp.isReplay('user-1', 12345);
    expect(first).toBe(false);
    expect(second).toBe(true);
  });

  it('scopes the replay marker per user — same step, different user is fine', async () => {
    const { totp } = makeTotp();
    expect(await totp.isReplay('user-A', 9999)).toBe(false);
    expect(await totp.isReplay('user-B', 9999)).toBe(false);
    // Re-use the same (user, step) — that's the replay.
    expect(await totp.isReplay('user-A', 9999)).toBe(true);
  });
});

describe('TotpService.encryptSecret / decryptSecret', () => {
  it('round-trips a base32 secret', () => {
    const { totp } = makeTotp();
    const secret = totp.generateSecret();
    const cipher = totp.encryptSecret(secret);
    expect(cipher).not.toBe(secret);
    expect(totp.decryptSecret(cipher)).toBe(secret);
  });

  it('produces different ciphertexts for the same input (fresh IV)', () => {
    const { totp } = makeTotp();
    const secret = 'JBSWY3DPEHPK3PXP';
    const a = totp.encryptSecret(secret);
    const b = totp.encryptSecret(secret);
    expect(a).not.toBe(b);
  });
});

describe('TotpService.generateBackupCodes', () => {
  it('returns matching raw + hashed pairs of the requested count', () => {
    const { totp } = makeTotp();
    const { raw, hashed } = totp.generateBackupCodes(10);
    expect(raw).toHaveLength(10);
    expect(hashed).toHaveLength(10);
    for (let i = 0; i < raw.length; i++) {
      // SHA-256 hex digest is 64 chars.
      expect(hashed[i]).toMatch(/^[a-f0-9]{64}$/);
      const code = raw[i];
      expect(typeof code).toBe('string');
      expect(code).toMatch(/^[a-f0-9]{5}-[a-f0-9]{5}$/);
    }
  });

  it('matchBackupCode is case-insensitive + whitespace-tolerant', () => {
    const { totp } = makeTotp();
    const { raw, hashed } = totp.generateBackupCodes(3);
    const target = raw[1];
    if (!target) throw new Error('test setup');
    expect(totp.matchBackupCode(target.toUpperCase(), hashed)).toBe(1);
    expect(totp.matchBackupCode(`  ${target}\n`, hashed)).toBe(1);
    expect(totp.matchBackupCode('00000-00000', hashed)).toBe(-1);
  });
});

// =============================================================================
// MfaService — wires TOTP + Prisma + JWT + audit
// =============================================================================

function makeMfaService() {
  const prisma = makePrismaMock();
  const { totp, redis } = makeTotp();
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
    listForUser: vi.fn().mockResolvedValue([]),
  } as unknown as AuditLogService;
  const jwt = {
    signAsync: vi.fn().mockResolvedValue('mfa.pending.jwt'),
    verifyAsync: vi.fn(),
  };
  const service = new MfaService(prisma, jwt as never, totp, audit);
  return { service, prisma, totp, audit, jwt, redis };
}

describe('MfaService.verifyMfaChallenge — backup-code single-use', () => {
  it('accepts a backup code on first use and removes it from the stored list', async () => {
    const { service, prisma, totp, jwt } = makeMfaService();
    const { raw, hashed } = totp.generateBackupCodes(3);
    const targetCode = raw[0];
    if (!targetCode) throw new Error('test setup');

    vi.mocked(jwt.verifyAsync).mockResolvedValueOnce({ sub: 'u-1', purpose: 'mfa' });
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-1',
      totpSecret: totp.encryptSecret(totp.generateSecret()),
      mfaEnabled: true,
      mfaBackupCodes: hashed,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);

    const out = await service.verifyMfaChallenge('any.token', targetCode, {});
    expect(out.userId).toBe('u-1');

    const updateCall = vi.mocked(prisma.user.update).mock.calls[0]?.[0];
    const newCodes = updateCall?.data?.mfaBackupCodes as string[];
    expect(newCodes).toHaveLength(2);
    expect(newCodes).not.toContain(hashed[0]);
  });

  it('rejects a backup code on second use (single-use enforced)', async () => {
    const { service, prisma, totp, jwt } = makeMfaService();
    const { raw, hashed } = totp.generateBackupCodes(3);
    const targetCode = raw[0];
    if (!targetCode) throw new Error('test setup');

    // First call: code is in the list.
    vi.mocked(jwt.verifyAsync).mockResolvedValue({ sub: 'u-1', purpose: 'mfa' });
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-1',
      totpSecret: totp.encryptSecret(totp.generateSecret()),
      mfaEnabled: true,
      mfaBackupCodes: hashed,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValueOnce({} as never);
    await service.verifyMfaChallenge('any.token', targetCode, {});

    // Second call: stored list has been mutated (hash removed). Same code now
    // doesn't match anything → UnauthorizedException.
    const remaining = hashed.filter((_, i) => i !== 0);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-1',
      totpSecret: totp.encryptSecret(totp.generateSecret()),
      mfaEnabled: true,
      mfaBackupCodes: remaining,
    } as never);

    await expect(
      service.verifyMfaChallenge('any.token', targetCode, {}),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('MfaService.verifyMfaChallenge — TOTP replay protection', () => {
  it('accepts a TOTP code once then rejects it within the same 30s step', async () => {
    const { service, prisma, totp, jwt } = makeMfaService();
    const secret = totp.generateSecret();
    const fixedNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(fixedNow));
    const code = findCurrentCode(totp, secret, fixedNow);
    const encryptedSecret = totp.encryptSecret(secret);

    vi.mocked(jwt.verifyAsync).mockResolvedValue({ sub: 'u-1', purpose: 'mfa' });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: 'u-1',
      totpSecret: encryptedSecret,
      mfaEnabled: true,
      mfaBackupCodes: [],
    } as never);

    // First verify — accepted, step marker stored in the in-memory redis.
    const out1 = await service.verifyMfaChallenge('any.token', code, {});
    expect(out1.userId).toBe('u-1');

    // Second verify — same code, same step. Replay must reject.
    await expect(
      service.verifyMfaChallenge('any.token', code, {}),
    ).rejects.toThrow(/already used/i);

    vi.useRealTimers();
  });
});

describe('MfaService.verifyMfaChallenge — pending-token purpose guard', () => {
  it('rejects a token without purpose:"mfa" — including a regular access token', async () => {
    // This is the linchpin guard: a regular access token (no `purpose` claim)
    // MUST NOT be honored as an MFA challenge. If this regresses, anyone with
    // an existing session could call /auth/mfa/verify and bypass MFA.
    const { service, jwt } = makeMfaService();
    vi.mocked(jwt.verifyAsync).mockResolvedValueOnce({ sub: 'u-1' /* no purpose */ });

    await expect(
      service.verifyMfaChallenge('access-token-here', '123456', {}),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired/invalid pending-token before checking the code', async () => {
    const { service, jwt } = makeMfaService();
    vi.mocked(jwt.verifyAsync).mockRejectedValueOnce(new Error('jwt expired'));

    await expect(
      service.verifyMfaChallenge('expired', '123456', {}),
    ).rejects.toThrow(/expired|invalid/i);
  });
});

// =============================================================================
// Helpers
// =============================================================================

/// Find the 6-digit code that the service would accept at `now`. Brute-force —
/// 1e6 candidates max — but bounded and deterministic. Keeps tests free of any
/// dependency on the HOTP math leaking into the test file.
function findCurrentCode(totp: TotpService, secret: string, now: number): string {
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = i.toString().padStart(6, '0');
    if (totp.verifyCode(secret, candidate, now).valid) {
      // Verify happens across the drift window; we want the candidate that
      // matches the EXACT current step (not the ±30s neighbors) so the
      // returned step is deterministic.
      const step = Math.floor(now / 1000 / 30);
      const { step: matchedStep } = totp.verifyCode(secret, candidate, now);
      if (matchedStep === step) return candidate;
    }
  }
  throw new Error('Did not find a matching TOTP code in 1M attempts — math broken');
}
