import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthProvider } from '../../database/schemas/user/user.schema';

describe('AuthService.handleAppleNotification', () => {
  let service: AuthService;
  let apple: { verifyNotification: jest.Mock };
  let userModel: { findOne: jest.Mock; updateOne: jest.Mock };

  const user = (fields: Record<string, unknown> = {}) => ({
    _id: 'u-1',
    email: 'jane@example.com',
    appleId: 'a-1',
    authProviders: [AuthProvider.APPLE],
    isPrivateEmail: false,
    ...fields,
  });

  /** The $set / $unset sent for the user, if any. */
  const update = () => userModel.updateOne.mock.calls[0]?.[1];

  beforeEach(() => {
    apple = { verifyNotification: jest.fn() };
    userModel = {
      findOne: jest.fn(async () => user()),
      updateOne: jest.fn(async () => ({})),
    };
    service = new AuthService(
      {} as any,
      {} as any,
      {} as any,
      userModel as any,
      {} as any,
      {} as any,
      apple as any,
    );
  });

  const event = (type: string, extra: Record<string, unknown> = {}) =>
    apple.verifyNotification.mockResolvedValue({
      type,
      appleId: 'a-1',
      isPrivateEmail: false,
      ...extra,
    });

  it('rejects a payload that is not from Apple', async () => {
    apple.verifyNotification.mockResolvedValue(null);
    await expect(
      service.handleAppleNotification('forged'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userModel.findOne).not.toHaveBeenCalled();
  });

  it('acknowledges events for an unknown Apple ID without changing anything', async () => {
    event('consent-revoked');
    userModel.findOne.mockResolvedValue(null);
    await expect(service.handleAppleNotification('p')).resolves.toEqual({
      received: true,
    });
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('consent-revoked ends sessions and drops the Apple token, keeping appleId', async () => {
    event('consent-revoked');
    await service.handleAppleNotification('p');

    expect(userModel.findOne).toHaveBeenCalledWith({ appleId: 'a-1' });
    expect(update().$set.sessionsRevokedAt).toBeInstanceOf(Date);
    expect(update().$set).not.toHaveProperty('isActive');
    expect(update().$unset).toEqual({ appleRefreshToken: 1 });
    expect(JSON.stringify(update())).not.toContain('appleId');
  });

  it('account-delete deactivates an Apple-only, Hide-My-Email account', async () => {
    event('account-delete', { isPrivateEmail: true });
    userModel.findOne.mockResolvedValue(user({ isPrivateEmail: true }));
    await service.handleAppleNotification('p');
    expect(update().$set).toMatchObject({ isActive: false });
  });

  it.each([
    ['it also has a password', { authProviders: [AuthProvider.APPLE, AuthProvider.PASSWORD] }],
    ['its email is real (it can still reset a password)', { isPrivateEmail: false }],
  ])('account-delete keeps the account active when %s', async (_case, fields) => {
    event('account-delete');
    userModel.findOne.mockResolvedValue(user(fields));
    await service.handleAppleNotification('p');
    expect(update().$set.sessionsRevokedAt).toBeInstanceOf(Date);
    expect(update().$set).not.toHaveProperty('isActive');
  });

  it.each(['email-disabled', 'email-enabled', 'something-new'])(
    '%s is acknowledged and changes nothing',
    async (type) => {
      event(type);
      await expect(service.handleAppleNotification('p')).resolves.toEqual({
        received: true,
      });
      expect(userModel.updateOne).not.toHaveBeenCalled();
    },
  );

  it('lets database errors through so Apple retries', async () => {
    event('consent-revoked');
    userModel.updateOne.mockRejectedValue(new Error('db down'));
    await expect(service.handleAppleNotification('p')).rejects.toThrow(
      'db down',
    );
  });
});
