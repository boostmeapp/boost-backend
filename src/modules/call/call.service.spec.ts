import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CallService } from './call.service';
import { StreamVideoService } from './stream-video.service';
import { CallErrorCode, STREAM_TOKEN_VALIDITY_SECONDS } from './call.constants';

const makeUser = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: new Types.ObjectId(),
    username: 'alexandra',
    profileImage: 'https://cdn.example.com/a.jpg',
    isActive: true,
    isBanned: false,
    ...overrides,
  }) as any;

describe('CallService.issueToken', () => {
  let streamVideo: jest.Mocked<
    Pick<StreamVideoService, 'getApiKey' | 'upsertUser' | 'generateUserToken'>
  >;
  let service: CallService;

  beforeEach(() => {
    streamVideo = {
      getApiKey: jest.fn().mockReturnValue('public-key'),
      upsertUser: jest.fn().mockResolvedValue(undefined),
      generateUserToken: jest.fn().mockReturnValue('signed-token'),
    };
    service = new CallService(streamVideo as unknown as StreamVideoService);
  });

  it('returns apiKey, token, userId, and a ~24h expiry', async () => {
    const user = makeUser();
    const before = Date.now();

    const res = await service.issueToken(user);

    expect(res.apiKey).toBe('public-key');
    expect(res.token).toBe('signed-token');
    expect(res.userId).toBe(user._id.toString());
    const expiresIn = Date.parse(res.expiresAt) - before;
    expect(Math.abs(expiresIn - STREAM_TOKEN_VALIDITY_SECONDS * 1000)).toBeLessThan(5_000);
    expect(streamVideo.generateUserToken).toHaveBeenCalledWith(
      user._id.toString(),
      STREAM_TOKEN_VALIDITY_SECONDS,
    );
  });

  it('upserts the Mongo id, display name, and avatar to Stream', async () => {
    const user = makeUser();

    await service.issueToken(user);

    expect(streamVideo.upsertUser).toHaveBeenCalledWith({
      id: user._id.toString(),
      name: 'alexandra',
      image: 'https://cdn.example.com/a.jpg',
    });
  });

  it('falls back to a generic name and omits a missing avatar', async () => {
    await service.issueToken(
      makeUser({ username: '  ', firstName: '', profileImage: undefined }),
    );

    expect(streamVideo.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Boostra user', image: undefined }),
    );
  });

  it('still returns a token when the Stream upsert fails', async () => {
    streamVideo.upsertUser.mockRejectedValue(new Error('Stream down'));

    await expect(service.issueToken(makeUser())).resolves.toMatchObject({
      token: 'signed-token',
    });
  });

  it('rejects banned users with ACCOUNT_BANNED and issues nothing', async () => {
    const err = await service
      .issueToken(makeUser({ isBanned: true }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe(CallErrorCode.AccountBanned);
    expect(streamVideo.generateUserToken).not.toHaveBeenCalled();
    expect(streamVideo.upsertUser).not.toHaveBeenCalled();
  });

  it('surfaces 503 when calling is disabled', async () => {
    streamVideo.getApiKey.mockImplementation(() => {
      throw new ServiceUnavailableException({
        message: 'Calling is not available',
        code: CallErrorCode.CallingUnavailable,
      });
    });

    await expect(service.issueToken(makeUser())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
