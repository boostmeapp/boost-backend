import { Types } from 'mongoose';
import { VideoService } from './video.service';

/**
 * Share counting only: one per signed-in user per video, none for guests.
 */
function setup(opts: { duplicate?: boolean; shareCount?: number } = {}) {
  const count = opts.shareCount ?? 5;

  const lean = (value: any) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });

  const videoModel = {
    findById: jest.fn(() => lean({ shareCount: count })),
    findByIdAndUpdate: jest.fn(() => lean({ shareCount: count + 1 })),
  };
  const videoShareModel = {
    create: jest.fn(() =>
      opts.duplicate ? Promise.reject({ code: 11000 }) : Promise.resolve({}),
    ),
  };

  const service = new VideoService(
    videoModel as any,
    videoShareModel as any,
    {} as any, // boostModel
    {} as any, // likesService
    {} as any, // followsService
    {} as any, // mediaUrl
    {} as any, // uploadService
  );

  return { service, videoModel, videoShareModel };
}

const videoId = () => String(new Types.ObjectId());

describe('VideoService.incrementShareCount', () => {
  it('counts a signed-in user’s first share', async () => {
    const t = setup({ shareCount: 5 });
    const res = await t.service.incrementShareCount(videoId(), String(new Types.ObjectId()));

    expect(res).toEqual({ shareCount: 6, counted: true });
    expect(t.videoModel.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('does not count the same user twice', async () => {
    const t = setup({ duplicate: true, shareCount: 6 });
    const res = await t.service.incrementShareCount(videoId(), String(new Types.ObjectId()));

    expect(res).toEqual({ shareCount: 6, counted: false });
    expect(t.videoModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('does not count a guest share', async () => {
    const t = setup({ shareCount: 6 });
    const res = await t.service.incrementShareCount(videoId());

    expect(res).toEqual({ shareCount: 6, counted: false });
    expect(t.videoShareModel.create).not.toHaveBeenCalled();
    expect(t.videoModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects an id that cannot be a video', async () => {
    const t = setup();
    await expect(t.service.incrementShareCount('not-an-id', 'u1')).rejects.toThrow();
  });
});
