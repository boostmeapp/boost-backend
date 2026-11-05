import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { issuedBeforeRevocation } from './token.service';
import { AuthProvider } from '../../database/schemas/user/user.schema';

/** Just enough of a Mongoose document for the sign-in path. */
const makeDoc = (fields: Record<string, any>) => {
  const doc: Record<string, any> = {
    _id: `id-${Math.random().toString(36).slice(2)}`,
    authProviders: [AuthProvider.PASSWORD],
    isActive: true,
    isBanned: false,
    isEmailVerified: false,
    ...fields,
  };
  doc.get = (k: string) => doc[k];
  doc.set = (k: string, v: unknown) => (doc[k] = v);
  doc.save = jest.fn(async () => doc);
  doc.toObject = () => {
    const { get, set, save, toObject, ...plain } = doc;
    return plain;
  };
  return doc;
};

describe('AuthService social sign-in (Google + Apple)', () => {
  let users: Record<string, any>[];
  let service: AuthService;
  let google: { verify: jest.Mock };
  let apple: { verify: jest.Mock; exchangeCode: jest.Mock };
  let updateOne: jest.Mock;

  const appleDto = (extra: Record<string, string> = {}) => ({
    identityToken: 'x'.repeat(30),
    nonce: 'n'.repeat(20),
    ...extra,
  });

  beforeEach(() => {
    users = [];
    updateOne = jest.fn(async () => ({}));
    const userModel = {
      updateOne,
      findOne: jest.fn(
        async (q: Record<string, unknown>) =>
          users.find((u) => Object.entries(q).every(([k, v]) => u[k] === v)) ??
          null,
      ),
      create: jest.fn(async (data: Record<string, unknown>) => {
        const doc = makeDoc(data);
        users.push(doc);
        return doc;
      }),
    };
    google = { verify: jest.fn() };
    apple = { verify: jest.fn(), exchangeCode: jest.fn() };

    service = new AuthService(
      { ensureAdminRole: jest.fn(async (u) => u) } as any,
      {
        generateTokens: jest.fn(async () => ({
          accessToken: 'a',
          refreshToken: 'r',
        })),
      } as any,
      { countDocuments: jest.fn(async () => 0) } as any,
      userModel as any,
      {} as any,
      google as any,
      apple as any,
    );
  });

  describe('Google (regression)', () => {
    beforeEach(() => {
      google.verify.mockResolvedValue({
        googleId: 'g-1',
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
      });
    });

    it('creates a new verified, password-less account', async () => {
      const res = await service.loginWithGoogle('id-token');
      expect(res.user).toMatchObject({
        email: 'jane@example.com',
        googleId: 'g-1',
        firstName: 'Jane',
        isEmailVerified: true,
        isPrivateEmail: false,
        authProviders: [AuthProvider.GOOGLE],
      });
      expect(res.accessToken).toBe('a');
      expect(users).toHaveLength(1);
    });

    it('links an existing verified password account by email', async () => {
      users.push(
        makeDoc({
          email: 'jane@example.com',
          firstName: 'Janet',
          isEmailVerified: true,
        }),
      );
      const res = await service.loginWithGoogle('id-token');
      expect(users).toHaveLength(1);
      expect(res.user).toMatchObject({
        googleId: 'g-1',
        firstName: 'Janet', // never overwritten
        lastName: 'Doe', // blank filled
        isEmailVerified: true,
        authProviders: [AuthProvider.PASSWORD, AuthProvider.GOOGLE],
      });
      // A verified owner keeps their password and sessions.
      expect(updateOne).not.toHaveBeenCalled();
      expect(res.user).not.toHaveProperty('sessionsRevokedAt');
    });

    it('records EULA acceptance on a new account', async () => {
      const res = await service.loginWithGoogle('id-token');
      expect(res.user.eulaAcceptedAt).toBeInstanceOf(Date);
    });
  });

  describe('Apple', () => {
    it('creates an account for a Hide-My-Email user', async () => {
      apple.verify.mockResolvedValue({
        appleId: 'a-1',
        email: 'abc@privaterelay.appleid.com',
        isPrivateEmail: true,
      });
      const res = await service.loginWithApple(
        appleDto({ firstName: '  Jane ', lastName: 'Doe' }),
      );
      expect(res.user).toMatchObject({
        email: 'abc@privaterelay.appleid.com',
        appleId: 'a-1',
        firstName: 'Jane',
        isPrivateEmail: true,
        isEmailVerified: true,
        authProviders: [AuthProvider.APPLE],
      });
      expect(res.user).not.toHaveProperty('googleId');
    });

    it('finds a repeat sign-in by appleId even without an email', async () => {
      users.push(
        makeDoc({
          email: 'jane@example.com',
          appleId: 'a-1',
          firstName: 'Jane',
          authProviders: [AuthProvider.APPLE],
        }),
      );
      apple.verify.mockResolvedValue({ appleId: 'a-1', isPrivateEmail: false });
      const res = await service.loginWithApple(appleDto());
      expect(users).toHaveLength(1);
      expect(res.user).toMatchObject({
        email: 'jane@example.com',
        firstName: 'Jane',
      });
    });

    describe('authorization code', () => {
      /** The exchange is fire-and-forget; let it settle. */
      const settle = () => new Promise((r) => setImmediate(r));

      beforeEach(() => {
        apple.verify.mockResolvedValue({
          appleId: 'a-1',
          email: 'jane@example.com',
          isPrivateEmail: false,
        });
      });

      it('stores the refresh token outside the returned user', async () => {
        apple.exchangeCode.mockResolvedValue('apple-refresh');
        const res = await service.loginWithApple(
          appleDto({ authorizationCode: 'code' }),
        );
        await settle();

        expect(apple.exchangeCode).toHaveBeenCalledWith('code');
        expect(updateOne).toHaveBeenCalledWith(
          { _id: res.user._id },
          { $set: { appleRefreshToken: 'apple-refresh' } },
        );
        expect(res.user).not.toHaveProperty('appleRefreshToken');
      });

      it('signs in even when the exchange fails', async () => {
        apple.exchangeCode.mockRejectedValue(new Error('Apple down'));
        await expect(
          service.loginWithApple(appleDto({ authorizationCode: 'code' })),
        ).resolves.toHaveProperty('accessToken');
        await settle();
        expect(updateOne).not.toHaveBeenCalled();
      });

      it('stores nothing when Apple returns no token', async () => {
        apple.exchangeCode.mockResolvedValue(null);
        await service.loginWithApple(appleDto({ authorizationCode: 'code' }));
        await settle();
        expect(updateOne).not.toHaveBeenCalled();
      });

      it('does not call Apple without a code', async () => {
        await service.loginWithApple(appleDto());
        expect(apple.exchangeCode).not.toHaveBeenCalled();
      });
    });

    it('explains how to recover when there is no account and no email', async () => {
      apple.verify.mockResolvedValue({ appleId: 'a-9', isPrivateEmail: false });
      await expect(service.loginWithApple(appleDto())).rejects.toThrow(
        /Stop Using/,
      );
      expect(users).toHaveLength(0);
    });

    it('links to an account that already uses Google', async () => {
      users.push(
        makeDoc({
          email: 'jane@example.com',
          googleId: 'g-1',
          authProviders: [AuthProvider.GOOGLE],
        }),
      );
      apple.verify.mockResolvedValue({
        appleId: 'a-1',
        email: 'jane@example.com',
        isPrivateEmail: false,
      });
      const res = await service.loginWithApple(appleDto());
      expect(res.user).toMatchObject({
        googleId: 'g-1',
        appleId: 'a-1',
        authProviders: [AuthProvider.GOOGLE, AuthProvider.APPLE],
      });
    });

    it('never overwrites an existing, different appleId', async () => {
      users.push(makeDoc({ email: 'jane@example.com', appleId: 'a-old' }));
      apple.verify.mockResolvedValue({
        appleId: 'a-new',
        email: 'jane@example.com',
        isPrivateEmail: false,
      });
      const res = await service.loginWithApple(appleDto());
      expect(res.user).toMatchObject({ appleId: 'a-old' });
    });

    it('does not add the provider twice', async () => {
      users.push(
        makeDoc({
          email: 'jane@example.com',
          appleId: 'a-1',
          authProviders: [AuthProvider.APPLE],
        }),
      );
      apple.verify.mockResolvedValue({
        appleId: 'a-1',
        email: 'jane@example.com',
        isPrivateEmail: false,
      });
      const res = await service.loginWithApple(appleDto());
      expect(res.user.authProviders).toEqual([AuthProvider.APPLE]);
    });
  });

  describe('account state (both providers)', () => {
    beforeEach(() => {
      apple.verify.mockResolvedValue({
        appleId: 'a-1',
        email: 'jane@example.com',
        isPrivateEmail: false,
      });
      google.verify.mockResolvedValue({
        googleId: 'g-1',
        email: 'jane@example.com',
      });
    });

    it('blocks banned accounts', async () => {
      users.push(makeDoc({ email: 'jane@example.com', isBanned: true }));
      await expect(service.loginWithApple(appleDto())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.loginWithGoogle('t')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('blocks deactivated accounts', async () => {
      users.push(makeDoc({ email: 'jane@example.com', isActive: false }));
      await expect(service.loginWithApple(appleDto())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(service.loginWithGoogle('t')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it.each([
      ['Google', () => service.loginWithGoogle('t')],
      ['Apple', () => service.loginWithApple(appleDto())],
    ])(
      '%s reclaims an unverified pre-registration: drops its password and sessions',
      async (_provider, signIn) => {
        const squatter = makeDoc({
          email: 'jane@example.com',
          authProviders: [AuthProvider.PASSWORD],
          isEmailVerified: false,
        });
        users.push(squatter);

        const res = await signIn();

        expect(updateOne).toHaveBeenCalledWith(
          { _id: squatter._id },
          { $unset: { password: 1 } },
        );
        expect(res.user.authProviders).not.toContain(AuthProvider.PASSWORD);
        expect(res.user.sessionsRevokedAt).toBeInstanceOf(Date);
        expect(res.user.isEmailVerified).toBe(true);
      },
    );
  });

  describe('concurrent first sign-in', () => {
    it('uses the account a parallel request just created', async () => {
      const winner = makeDoc({
        email: 'jane@example.com',
        appleId: 'a-1',
        authProviders: [AuthProvider.APPLE],
      });
      const userModel = {
        // Neither lookup finds it: the other request has not committed yet.
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(winner),
        create: jest.fn(async () => {
          throw Object.assign(new Error('E11000 duplicate key'), {
            code: 11000,
          });
        }),
      };
      service = new AuthService(
        { ensureAdminRole: jest.fn(async (u) => u) } as any,
        {
          generateTokens: jest.fn(async () => ({
            accessToken: 'a',
            refreshToken: 'r',
          })),
        } as any,
        { countDocuments: jest.fn(async () => 0) } as any,
        userModel as any,
        {} as any,
        google as any,
        apple as any,
      );
      apple.verify.mockResolvedValue({
        appleId: 'a-1',
        email: 'jane@example.com',
        isPrivateEmail: false,
      });

      const res = await service.loginWithApple(appleDto());

      expect(res.user._id).toBe(winner._id);
      expect(userModel.findOne).toHaveBeenLastCalledWith({
        $or: [{ appleId: 'a-1' }, { email: 'jane@example.com' }],
      });
    });

    it('rethrows errors other than a duplicate key', async () => {
      apple.verify.mockResolvedValue({
        appleId: 'a-1',
        email: 'jane@example.com',
        isPrivateEmail: false,
      });
      const boom = new Error('connection lost');
      (service as any).userModel.create = jest.fn(async () => {
        throw boom;
      });
      await expect(service.loginWithApple(appleDto())).rejects.toBe(boom);
    });
  });
});

describe('issuedBeforeRevocation', () => {
  const at = (iso?: string) =>
    ({ sessionsRevokedAt: iso ? new Date(iso) : undefined }) as any;
  const secs = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it('accepts every token when nothing was revoked', () => {
    expect(issuedBeforeRevocation(at(), 0)).toBe(false);
  });

  it('rejects a token issued before the cut-off', () => {
    expect(
      issuedBeforeRevocation(
        at('2026-10-28T12:00:00.500Z'),
        secs('2026-10-28T11:59:59Z'),
      ),
    ).toBe(true);
  });

  it('keeps the token issued in the same second as the revocation', () => {
    expect(
      issuedBeforeRevocation(
        at('2026-10-28T12:00:00.900Z'),
        secs('2026-10-28T12:00:00.100Z'),
      ),
    ).toBe(false);
  });

  it('rejects a token without iat once sessions were revoked', () => {
    expect(issuedBeforeRevocation(at('2026-10-28T12:00:00Z'))).toBe(true);
  });
});
