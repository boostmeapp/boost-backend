import { UnauthorizedException } from '@nestjs/common';
import { createHash, generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { AppleAuthService } from './apple-auth.service';
import { ENV } from '../../config';

const BUNDLE_ID = 'com.boostra.mobile';
const NONCE = 'raw-nonce-0123456789abcdef';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('AppleAuthService', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid' };

  let service: AppleAuthService;
  let fetchMock: jest.SpyInstance;

  /** A token as Apple would issue it, overridable per test. */
  const token = (
    claims: Record<string, unknown> = {},
    opts: jwt.SignOptions = {},
  ) =>
    jwt.sign(
      {
        sub: 'apple-sub-1',
        email: 'Jane@Example.com',
        email_verified: 'true',
        is_private_email: 'false',
        nonce: sha256(NONCE),
        ...claims,
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: 'test-kid',
        issuer: 'https://appleid.apple.com',
        audience: BUNDLE_ID,
        expiresIn: '5m',
        ...opts,
      },
    );

  beforeAll(() => {
    ENV.init({ get: (_k: string, fallback: unknown) => fallback } as any);
  });

  beforeEach(() => {
    service = new AppleAuthService();
    // Stand in for https://appleid.apple.com/auth/keys with our own test key.
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [jwk] }),
    } as Response);
  });

  afterEach(() => fetchMock.mockRestore());

  it('fetches Apple keys once and reuses them', async () => {
    await service.verify(token(), NONCE);
    await service.verify(token(), NONCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://appleid.apple.com/auth/keys',
    );
  });

  it('rejects an unknown key id without refetching on every request', async () => {
    await service.verify(token(), NONCE);
    const t = token({}, { keyid: 'unknown-kid' });
    await expect(service.verify(t, NONCE)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the identity from a valid token', async () => {
    await expect(service.verify(token(), NONCE)).resolves.toEqual({
      appleId: 'apple-sub-1',
      email: 'jane@example.com',
      isPrivateEmail: false,
    });
  });

  it('accepts boolean claims as well as "true" strings', async () => {
    const t = token({ email_verified: true, is_private_email: true });
    await expect(service.verify(t, NONCE)).resolves.toMatchObject({
      isPrivateEmail: true,
    });
  });

  it('allows a token without an email (repeat sign-in)', async () => {
    const t = token({ email: undefined, email_verified: undefined });
    await expect(service.verify(t, NONCE)).resolves.toEqual({
      appleId: 'apple-sub-1',
      email: undefined,
      isPrivateEmail: false,
    });
  });

  it.each([
    ['a different nonce', () => token(), 'another-raw-nonce-123456'],
    ['the hash sent instead of the raw nonce', () => token(), sha256(NONCE)],
    ['a missing nonce claim', () => token({ nonce: undefined }), NONCE],
    [
      'another app as audience',
      () => token({}, { audience: 'com.other.app' }),
      NONCE,
    ],
    [
      'another issuer',
      () => token({}, { issuer: 'https://evil.example' }),
      NONCE,
    ],
    ['an expired token', () => token({}, { expiresIn: -10 }), NONCE],
    ['an unverified email', () => token({ email_verified: 'false' }), NONCE],
    ['a junk token', () => 'not-a-real-token-at-all-xxxxxxxx', NONCE],
  ])('rejects %s', async (_case, makeToken, nonce) => {
    await expect(service.verify(makeToken(), nonce)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed by a key Apple does not hold', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = jwt.sign(
      { sub: 'x', nonce: sha256(NONCE) },
      other.privateKey,
      {
        algorithm: 'RS256',
        keyid: 'test-kid',
        issuer: 'https://appleid.apple.com',
        audience: BUNDLE_ID,
      },
    );
    await expect(service.verify(forged, NONCE)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the signing key cannot be fetched', async () => {
    fetchMock.mockRejectedValue(new Error('Apple unreachable'));
    await expect(service.verify(token(), NONCE)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
