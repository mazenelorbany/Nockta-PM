import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { Env } from '../../config/env';
import { REDIS_CLIENT } from '../redis/redis.module';

// =============================================================================
// TotpService — RFC 6238 TOTP, RFC 4648 base32, AES-256-GCM secret encryption.
//
// Replay protection: on a successful TOTP verify we stamp Redis with
//   `auth:mfa:totp-used:<userId>:<step>` for 90s (3 × 30s step window). Any
// second submission of the SAME 6-digit code during that window is rejected
// — even if the code is still in the time-skew tolerance. Backup codes have
// single-use built in (matching hash is removed from the array on consumption).
//
// No new npm dependency: the math is small enough that pulling in `otpauth`
// or `speakeasy` would more than triple the install footprint for this one
// service. Tests live in auth.mfa.test.ts.
// =============================================================================

const TOTP_DIGITS = 6;
const TOTP_STEP_SECONDS = 30;
/// Tolerance in steps each direction. ±1 step = ±30s. Matches every reference
/// implementation (Google Authenticator, Authy) so users in mild clock-drift
/// regions still verify successfully.
const TOTP_DRIFT_STEPS = 1;

// RFC 4648 base32 alphabet, no padding (the way every authenticator app expects).
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const REDIS_TOTP_USED_PREFIX = 'auth:mfa:totp-used';
const REDIS_TOTP_USED_TTL_SECONDS = 90; // 3 × 30s steps

@Injectable()
export class TotpService {
  private readonly logger = new Logger(TotpService.name);
  private readonly encryptionKey: Buffer;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    this.encryptionKey = resolveEncryptionKey();
  }

  // ---------- Secret generation + encoding ----------

  /// Generate a fresh base32-encoded TOTP secret (160 bits / 20 bytes —
  /// matches the RFC 6238 reference implementation).
  generateSecret(): string {
    const raw = randomBytes(20);
    return base32Encode(raw);
  }

  buildOtpAuthUrl(email: string, secret: string): string {
    const issuer = 'Nockta';
    const label = encodeURIComponent(`${issuer}:${email}`);
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: String(TOTP_DIGITS),
      period: String(TOTP_STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  // ---------- Encryption at rest ----------

  /// AES-256-GCM. Output format: base64(iv ‖ authTag ‖ ciphertext). 12-byte
  /// IV, 16-byte auth tag — both canonical for GCM.
  encryptSecret(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  decryptSecret(encrypted: string): string {
    const buf = Buffer.from(encrypted, 'base64');
    if (buf.length < 12 + 16 + 1) {
      throw new Error('Encrypted TOTP secret is malformed');
    }
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  // ---------- TOTP verify ----------

  /// Verify a 6-digit TOTP code against a base32-encoded secret. Returns
  /// `{ valid, step }` — `step` is the time-step the code matched at, useful
  /// for replay marking. Returns valid=false for any failure (no error info
  /// leak about which code was tried at which step).
  verifyCode(
    base32Secret: string,
    code: string,
    now: number = Date.now(),
  ): { valid: boolean; step: number | null } {
    if (!/^\d{6}$/.test(code)) return { valid: false, step: null };
    const key = base32Decode(base32Secret);
    const currentStep = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    // Constant-time compare each candidate step. Don't short-circuit on first
    // match — keeps the wall-clock independent of which drift offset matched.
    let matched: number | null = null;
    for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift++) {
      const step = currentStep + drift;
      const candidate = computeHotp(key, step);
      if (timingSafeEqualString(candidate, code)) {
        matched = step;
      }
    }
    return { valid: matched !== null, step: matched };
  }

  /// Replay protection — call AFTER `verifyCode` returns valid. Returns
  /// `true` if the code/step pair was already used recently for the same
  /// user; the caller should treat that as an invalid code and reject.
  async isReplay(userId: string, step: number): Promise<boolean> {
    const key = `${REDIS_TOTP_USED_PREFIX}:${userId}:${step}`;
    const set = await this.redis.set(key, '1', 'EX', REDIS_TOTP_USED_TTL_SECONDS, 'NX');
    // `SET ... NX` returns null if the key already exists → it's a replay.
    return set === null;
  }

  // ---------- Backup codes ----------

  /// Generate N (default 10) one-time backup codes. Returns `{ raw, hashed }`
  /// — hashed go in the DB, raw are shown to the user exactly ONCE.
  generateBackupCodes(count = 10): { raw: string[]; hashed: string[] } {
    const raw: string[] = [];
    const hashed: string[] = [];
    for (let i = 0; i < count; i++) {
      // 10 hex chars (40 bits) — readable, copy-pasteable, 1 in 1T odds.
      // Format as `xxxxx-xxxxx` so the user can transcribe without losing track.
      const bytes = randomBytes(5);
      const hex = bytes.toString('hex');
      const formatted = `${hex.slice(0, 5)}-${hex.slice(5, 10)}`;
      raw.push(formatted);
      hashed.push(hashBackupCode(formatted));
    }
    return { raw, hashed };
  }

  /// Returns the index of the matching hash in `hashedCodes`, or -1. Caller
  /// is responsible for removing that index from the array (consuming the
  /// code). Normalization strips whitespace + lowercases so the user can
  /// type the code with arbitrary casing.
  matchBackupCode(rawInput: string, hashedCodes: readonly string[]): number {
    const normalized = rawInput.trim().toLowerCase();
    if (normalized.length === 0) return -1;
    const expected = hashBackupCode(normalized);
    for (let i = 0; i < hashedCodes.length; i++) {
      const candidate = hashedCodes[i];
      if (typeof candidate !== 'string') continue;
      if (timingSafeEqualString(expected, candidate)) return i;
    }
    return -1;
  }
}

// =============================================================================
// Internals — pure functions, easier to test in isolation.
// =============================================================================

function resolveEncryptionKey(): Buffer {
  if (Env.MFA_ENCRYPTION_KEY) {
    const buf = Buffer.from(Env.MFA_ENCRYPTION_KEY, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        'MFA_ENCRYPTION_KEY must be a 32-byte (256-bit) value base64-encoded. ' +
          "Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`.",
      );
    }
    return buf;
  }
  if (Env.NODE_ENV === 'production') {
    throw new Error(
      'MFA_ENCRYPTION_KEY is required in production. Generate one with ' +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        'and set it in your production .env.',
    );
  }
  // Dev fallback — derive a 32-byte key from JWT_ACCESS_SECRET so tests +
  // local dev work without an extra env var. Production refuses this path.
  return createHash('sha256').update(Env.JWT_ACCESS_SECRET).digest();
}

function computeHotp(key: Buffer, counter: number): string {
  // 8-byte big-endian counter.
  const counterBuf = Buffer.alloc(8);
  // JavaScript bitwise ops only work on 32 bits — write hi/lo halves.
  const hi = Math.floor(counter / 2 ** 32);
  const lo = counter >>> 0;
  counterBuf.writeUInt32BE(hi, 0);
  counterBuf.writeUInt32BE(lo, 4);

  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  const code = bin % 10 ** TOTP_DIGITS;
  return code.toString().padStart(TOTP_DIGITS, '0');
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      const idx = (value >>> (bits - 5)) & 0x1f;
      out += BASE32_ALPHABET[idx];
      bits -= 5;
    }
  }
  if (bits > 0) {
    const idx = (value << (5 - bits)) & 0x1f;
    out += BASE32_ALPHABET[idx];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const normalized = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of normalized) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error('Invalid base32 character');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hashBackupCode(raw: string): string {
  return createHash('sha256').update(raw.trim().toLowerCase()).digest('hex');
}

/// Constant-time equality for strings of equal expected length. Falls back to
/// `false` when lengths differ rather than throwing.
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
