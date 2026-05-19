import { createHash } from 'node:crypto';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { makeEventsMock, makePrismaMock } from '../../test-utils/mocks';
import type { PrismaService } from '../../prisma/prisma.service';

import { AuthService } from './auth.service';

// =============================================================================
// auth.service — the highest-blast-radius surface in the API. Each test pins
// one security claim. We exercise behavior, not implementation: tests assert
// "X path produces Y observable side-effect" without caring whether it goes
// through JwtService.signAsync first or last.
// =============================================================================

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

interface Mocks {
  prisma: PrismaService;
  jwt: { signAsync: ReturnType<typeof vi.fn> };
  mail: { send: ReturnType<typeof vi.fn> };
  sessions: { revokeJti: ReturnType<typeof vi.fn> };
  events: ReturnType<typeof makeEventsMock>;
  mfa: { issuePendingToken: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn>; listForUser: ReturnType<typeof vi.fn> };
}

function buildService(overrides: Partial<Mocks> = {}): {
  service: AuthService;
  mocks: Mocks;
} {
  const prisma = overrides.prisma ?? makePrismaMock();
  const jwt = overrides.jwt ?? {
    // Returns a deterministic stub token so the test can assert on it without
    // pulling in the real JwtService.
    signAsync: vi.fn().mockResolvedValue('signed.access.token'),
  };
  const mail = overrides.mail ?? { send: vi.fn().mockResolvedValue(undefined) };
  const sessions = overrides.sessions ?? { revokeJti: vi.fn() };
  const events = overrides.events ?? makeEventsMock();
  const mfa = overrides.mfa ?? {
    issuePendingToken: vi.fn().mockResolvedValue('mfa.pending.token'),
  };
  const audit = overrides.audit ?? {
    record: vi.fn().mockResolvedValue(undefined),
    listForUser: vi.fn().mockResolvedValue([]),
  };

   
  const service = new AuthService(
    prisma,
    jwt as never,
    mail as never,
    sessions as never,
    events.instance,
    audit as never,
  );
  return { service, mocks: { prisma, jwt, mail, sessions, events, mfa, audit } };
}

describe('AuthService.loginWithGoogle', () => {
  it('upserts the user, mints a token pair, and emits user.login', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.user.upsert).mockResolvedValueOnce({
      id: 'u1',
      email: 'alice@nockta.com',
      kind: 'internal',
      companyRole: 'Member',
      archivedAt: null,
    } as never);
    vi.mocked(mocks.prisma.refreshToken.create).mockResolvedValueOnce({} as never);

    const outcome = await service.loginWithGoogle(
      {
        id: 'google-123',
        email: 'alice@nockta.com',
        name: 'Alice',
        avatarUrl: 'https://example.com/a.png',
      },
      '127.0.0.1',
    );

    expect(outcome.accessToken).toBe('signed.access.token');
    expect(typeof outcome.refreshToken).toBe('string');
    expect(outcome.refreshToken.length).toBeGreaterThan(20);
    expect(mocks.prisma.user.upsert).toHaveBeenCalledOnce();
    expect(mocks.events.emit).toHaveBeenCalledWith('user.login', {
      userId: 'u1',
      ip: '127.0.0.1',
      method: 'google',
    });
  });

  it('rejects archived users', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.user.upsert).mockResolvedValueOnce({
      id: 'u1',
      email: 'archived@nockta.com',
      kind: 'internal',
      companyRole: 'Member',
      archivedAt: new Date('2024-01-01'),
    } as never);

    await expect(
      service.loginWithGoogle({
        id: 'google-x',
        email: 'archived@nockta.com',
        name: 'Archived',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('persists the refresh token hashed — never the raw value', async () => {
    // Reuse-resistance hinges on us never writing the raw token to the DB.
    // If a future refactor stores the raw value, this test breaks loudly.
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.user.upsert).mockResolvedValueOnce({
      id: 'u1',
      email: 'alice@nockta.com',
      kind: 'internal',
      companyRole: 'Member',
      archivedAt: null,
    } as never);
    vi.mocked(mocks.prisma.refreshToken.create).mockResolvedValueOnce({} as never);

    const outcome = await service.loginWithGoogle({
      id: 'google-123',
      email: 'alice@nockta.com',
      name: 'Alice',
    });

    const createCall = vi.mocked(mocks.prisma.refreshToken.create).mock.calls[0]?.[0];
    expect(createCall?.data?.tokenHash).toBe(sha256(outcome.refreshToken));
    expect(createCall?.data?.tokenHash).not.toBe(outcome.refreshToken);
  });
});

describe('AuthService.requestMagicLink', () => {
  it('refuses to send a link to a company-domain address', async () => {
    // Internal accounts must use Google OAuth. Without this guard a curious
    // internal user could bypass SSO via the magic-link path.
    const { service, mocks } = buildService();

    await expect(service.requestMagicLink('person@nockta.com')).rejects.toThrow(
      BadRequestException,
    );
    expect(mocks.prisma.magicLink.create).not.toHaveBeenCalled();
    expect(mocks.mail.send).not.toHaveBeenCalled();
  });

  it('hashes the token before persisting and emails the raw value', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValueOnce(null);
    vi.mocked(mocks.prisma.magicLink.create).mockResolvedValueOnce({} as never);

    await service.requestMagicLink('client@external.test', '10.0.0.1');

    const createCall = vi.mocked(mocks.prisma.magicLink.create).mock.calls[0]?.[0];
    expect(createCall?.data?.email).toBe('client@external.test');
    expect(typeof createCall?.data?.tokenHash).toBe('string');
    // 64 hex chars from sha256.
    expect(createCall?.data?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // Intent reflects whether the user existed yet — pins the contract.
    expect(createCall?.data?.intent).toBe('client_signup');

    expect(mocks.mail.send).toHaveBeenCalledOnce();
    const mailArgs = mocks.mail.send.mock.calls[0]?.[0];
    // The emailed token must NOT equal the stored hash — otherwise anyone
    // who sees the DB could log in as the client.
    expect(mailArgs?.text).toContain('token=');
    const emailedToken = /token=([^&\s]+)/.exec(mailArgs?.text ?? '')?.[1];
    expect(emailedToken).toBeTruthy();
    expect(emailedToken).not.toBe(createCall?.data?.tokenHash);
  });

  it('marks intent as client_login when the user already exists', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.user.findUnique).mockResolvedValueOnce({
      id: 'u-existing',
    } as never);
    vi.mocked(mocks.prisma.magicLink.create).mockResolvedValueOnce({} as never);

    await service.requestMagicLink('client@external.test');

    const createCall = vi.mocked(mocks.prisma.magicLink.create).mock.calls[0]?.[0];
    expect(createCall?.data?.intent).toBe('client_login');
  });
});

describe('AuthService.verifyMagicLink', () => {
  it('rejects an unknown token', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.magicLink.findUnique).mockResolvedValueOnce(null);

    await expect(
      service.verifyMagicLink('client@external.test', 'fake-token'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token bound to a different email (mismatched envelope attack)', async () => {
    // The link looks valid by hash but was issued for a different email.
    // We reject rather than honor the hash so phishing can't redirect a
    // signed link to a different account.
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.magicLink.findUnique).mockResolvedValueOnce({
      id: 'ml-1',
      email: 'real@external.test',
      tokenHash: sha256('raw-token'),
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    await expect(
      service.verifyMagicLink('attacker@external.test', 'raw-token'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an already-used token', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.magicLink.findUnique).mockResolvedValueOnce({
      id: 'ml-1',
      email: 'real@external.test',
      tokenHash: sha256('raw-token'),
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    } as never);

    await expect(
      service.verifyMagicLink('real@external.test', 'raw-token'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.magicLink.findUnique).mockResolvedValueOnce({
      id: 'ml-1',
      email: 'real@external.test',
      tokenHash: sha256('raw-token'),
      usedAt: null,
      expiresAt: new Date(Date.now() - 1),
    } as never);

    await expect(
      service.verifyMagicLink('real@external.test', 'raw-token'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('marks the link as used and issues tokens on the happy path', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.magicLink.findUnique).mockResolvedValueOnce({
      id: 'ml-1',
      email: 'client@external.test',
      tokenHash: sha256('raw-token'),
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    } as never);
    vi.mocked(mocks.prisma.magicLink.update).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.user.upsert).mockResolvedValueOnce({
      id: 'u-client',
      email: 'client@external.test',
      kind: 'client',
      companyRole: null,
      archivedAt: null,
    } as never);
    vi.mocked(mocks.prisma.refreshToken.create).mockResolvedValueOnce({} as never);

    const pair = await service.verifyMagicLink('client@external.test', 'raw-token');

    expect(pair.accessToken).toBe('signed.access.token');
    expect(mocks.prisma.magicLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ml-1' },
        data: expect.objectContaining({ usedAt: expect.any(Date) as Date }),
      }),
    );
  });
});

describe('AuthService.refresh — rotation + reuse detection', () => {
  it('rejects unknown refresh tokens', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.refreshToken.findUnique).mockResolvedValueOnce(null);

    await expect(service.refresh('mystery-token')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects revoked refresh tokens', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.refreshToken.findUnique).mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'u1',
      tokenHash: sha256('raw'),
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rotatedToId: null,
      user: { id: 'u1', kind: 'internal', companyRole: 'Member', archivedAt: null },
    } as never);

    await expect(service.refresh('raw')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects expired refresh tokens', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.refreshToken.findUnique).mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'u1',
      tokenHash: sha256('raw'),
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1),
      rotatedToId: null,
      user: { id: 'u1', kind: 'internal', companyRole: 'Member', archivedAt: null },
    } as never);

    await expect(service.refresh('raw')).rejects.toThrow(UnauthorizedException);
  });

  it('detects reuse of an already-rotated token and revokes ALL the user tokens', async () => {
    // The classic refresh-rotation reuse attack: a stolen token gets rotated
    // by the attacker. When the legitimate user later tries to refresh with
    // the OLD token, we know one of them is compromised — revoke everything.
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.refreshToken.findUnique).mockResolvedValueOnce({
      id: 'rt-old',
      userId: 'u1',
      tokenHash: sha256('raw'),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      rotatedToId: 'rt-new', // <-- this is the smoking gun
      user: { id: 'u1', kind: 'internal', companyRole: 'Member', archivedAt: null },
    } as never);
    vi.mocked(mocks.prisma.refreshToken.updateMany).mockResolvedValueOnce({
      count: 5,
    } as never);

    await expect(service.refresh('raw')).rejects.toThrow(
      /reuse detected/i,
    );

    // Critically: the system MUST have revoked every active refresh token
    // for the user as a side-effect. If we only rejected this call, the
    // attacker's session would survive.
    expect(mocks.prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) as Date }),
      }),
    );
    expect(mocks.events.emit).toHaveBeenCalledWith(
      'auth.refresh_reuse',
      expect.objectContaining({ userId: 'u1' }),
    );
  });

  it('happy path rotates the old token and points it at the new one', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.refreshToken.findUnique).mockResolvedValueOnce({
      id: 'rt-old',
      userId: 'u1',
      tokenHash: sha256('raw'),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      rotatedToId: null,
      user: {
        id: 'u1',
        email: 'alice@nockta.com',
        kind: 'internal',
        companyRole: 'Member',
        archivedAt: null,
      },
    } as never);
    // issueTokens() inserts the new token then looks it up via findUniqueOrThrow.
    vi.mocked(mocks.prisma.refreshToken.create).mockResolvedValueOnce({} as never);
    vi.mocked(mocks.prisma.refreshToken.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'rt-new',
    } as never);
    vi.mocked(mocks.prisma.refreshToken.update).mockResolvedValueOnce({} as never);

    const pair = await service.refresh('raw');

    expect(pair.refreshToken).not.toBe('raw');
    // The old row gets marked as rotated-to. This is the breadcrumb future
    // reuse-detection relies on; if it's missing, reuse detection is dead.
    expect(mocks.prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt-old' },
        data: { rotatedToId: 'rt-new' },
      }),
    );
  });

  it('refuses to refresh for an archived user even with a valid token', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.refreshToken.findUnique).mockResolvedValueOnce({
      id: 'rt-1',
      userId: 'u1',
      tokenHash: sha256('raw'),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      rotatedToId: null,
      user: {
        id: 'u1',
        email: 'archived@nockta.com',
        kind: 'internal',
        companyRole: 'Member',
        archivedAt: new Date(),
      },
    } as never);

    await expect(service.refresh('raw')).rejects.toThrow(UnauthorizedException);
  });
});

describe('AuthService.revokeAllRefreshTokens', () => {
  it('marks every active refresh token revoked for a single user', async () => {
    const { service, mocks } = buildService();
    vi.mocked(mocks.prisma.refreshToken.updateMany).mockResolvedValueOnce({
      count: 3,
    } as never);

    await service.revokeAllRefreshTokens('u1');

    expect(mocks.prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', revokedAt: null },
      }),
    );
  });
});
