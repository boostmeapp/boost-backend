import { Types } from 'mongoose';
import { CallAccountCleanupService } from './call-account-cleanup.service';
import { CallEndReason, CallStatus } from './call.constants';

describe('CallAccountCleanupService.onUserDeleted', () => {
  let live: any[];
  let callModel: { find: jest.Mock; updateMany: jest.Mock };
  let callService: { terminateCall: jest.Mock };
  let streamVideo: { isEnabled: jest.Mock; deleteUser: jest.Mock };
  let service: CallAccountCleanupService;
  let userId: string;

  beforeEach(() => {
    userId = new Types.ObjectId().toString();
    live = [];
    callModel = {
      find: jest.fn(() => ({ select: () => ({ lean: async () => live }) })),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 3 }),
    };
    callService = { terminateCall: jest.fn().mockResolvedValue({ changed: true }) };
    streamVideo = {
      isEnabled: jest.fn().mockReturnValue(true),
      deleteUser: jest.fn().mockResolvedValue(undefined),
    };
    service = new CallAccountCleanupService(callModel as any, callService as any, streamVideo as any);
    for (const level of ['log', 'error'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation(() => undefined);
    }
  });

  it('ends their live calls with reason account_deleted', async () => {
    live = [
      { _id: new Types.ObjectId(), status: CallStatus.Active, streamCallId: 'default:a' },
      { _id: new Types.ObjectId(), status: CallStatus.Ringing, streamCallId: 'default:b' },
    ];

    await service.onUserDeleted(userId);

    expect(callService.terminateCall).toHaveBeenCalledTimes(2);
    expect(callService.terminateCall.mock.calls[0][1]).toEqual({
      actorId: null,
      reason: CallEndReason.AccountDeleted,
    });
  });

  it('3. strips their per-user data but keeps the records (the other person\'s history)', async () => {
    await service.onUserDeleted(userId);

    const [filter, update] = callModel.updateMany.mock.calls[0];
    expect(String(filter.participants)).toBe(userId);
    expect(update.$unset).toEqual({
      [`metadata.quality.${userId}`]: '',
      [`metadata.feedback.${userId}`]: '',
    });
    expect(String(update.$pull.hiddenFor)).toBe(userId);
    expect((callModel as any).deleteMany).toBeUndefined();
  });

  it('3b. deletes them from Stream', async () => {
    await service.onUserDeleted(userId);

    expect(streamVideo.deleteUser).toHaveBeenCalledWith(userId);
  });

  it('skips Stream when calling is unconfigured', async () => {
    streamVideo.isEnabled.mockReturnValue(false);

    await service.onUserDeleted(userId);

    expect(streamVideo.deleteUser).not.toHaveBeenCalled();
  });

  it('never throws — each step fails independently', async () => {
    callModel.find.mockImplementation(() => {
      throw new Error('Mongo down');
    });
    streamVideo.deleteUser.mockRejectedValue(new Error('Stream down'));

    await expect(service.onUserDeleted(userId)).resolves.toBeUndefined();
    expect(callModel.updateMany).toHaveBeenCalled(); // step 2 still ran
  });

  it('ignores a malformed id', async () => {
    await service.onUserDeleted('nope');

    expect(callModel.find).not.toHaveBeenCalled();
  });
});
