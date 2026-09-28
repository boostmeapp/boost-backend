import { Types } from 'mongoose';
import { ConnectionsService } from './connections.service';

/**
 * The paging envelope and the follow flags on each row — the two things the
 * followers screens read.
 */
function setup(opts: { users?: any[]; total?: number; edges?: any[] } = {}) {
  const users = opts.users ?? [];

  const chain = (value: any) => {
    const q: any = {
      select: () => q,
      sort: () => q,
      skip: () => q,
      limit: () => q,
      lean: () => Promise.resolve(value),
    };
    return q;
  };

  const userModel = {
    find: jest.fn(() => chain(users)),
    findById: jest.fn(() => chain(null)),
    countDocuments: jest.fn(() => Promise.resolve(opts.total ?? users.length)),
  };

  const followModel = {
    find: jest.fn(() => chain(opts.edges ?? [])),
    countDocuments: jest.fn(() => Promise.resolve(0)),
    aggregate: jest.fn(() => Promise.resolve([])),
  };

  const mediaUrl = { toUrl: (v: any) => (v ? `https://cdn.test/${v}` : null) };

  const service = new ConnectionsService(
    followModel as any,
    userModel as any,
    mediaUrl as any,
  );

  return { service, followModel, userModel };
}

const id = () => new Types.ObjectId();

describe('ConnectionsService', () => {
  it('reports more pages while rows remain', async () => {
    const t = setup({ users: [{ _id: id(), username: 'aria' }], total: 25 });
    const page = await t.service.getSuggested(String(id()), { page: 1, limit: 10 });

    expect(page).toMatchObject({ page: 1, limit: 10, total: 25, hasMore: true });
    expect(page.items).toHaveLength(1);
  });

  it('reports no more pages on the last one', async () => {
    const t = setup({ users: [{ _id: id(), username: 'aria' }], total: 10 });
    const page = await t.service.getSuggested(String(id()), { page: 1, limit: 10 });

    expect(page.hasMore).toBe(false);
  });

  it('marks who follows the viewer and who the viewer follows', async () => {
    const person = id();
    const viewer = id();

    const t = setup({ users: [{ _id: person, username: 'aria', profileImage: 'a.jpg' }] });
    // Both directions exist, so the row is mutual.
    t.followModel.find = jest.fn((filter: any) => ({
      select: () => ({
        lean: () =>
          Promise.resolve(
            filter.following && filter.following.$in
              ? [{ following: person }]
              : [{ follower: person }],
          ),
      }),
    })) as any;

    const [row] = (await t.service.getSuggested(String(viewer), { limit: 10 })).items;

    expect(row).toMatchObject({
      id: String(person),
      name: 'aria',
      subtitle: 'Follows you',
      avatar: 'https://cdn.test/a.jpg',
      isFollowing: true,
      followsYou: true,
      isSelf: false,
    });
  });

  it('leaves a guest with no follow state', async () => {
    const t = setup({ users: [{ _id: id(), username: 'aria' }] });
    const [row] = (await t.service.getSuggested(undefined, {})).items;

    expect(row).toMatchObject({ isFollowing: false, followsYou: false });
  });

  it('has no mutuals with yourself', async () => {
    const me = String(id());
    const t = setup();

    expect(await t.service.getMutuals(me, me, {})).toMatchObject({ total: 0, items: [] });
  });

  it('rejects an id that cannot be a user', async () => {
    const t = setup();
    await expect(t.service.getFollowers('not-an-id', undefined, {})).rejects.toThrow();
  });
});
