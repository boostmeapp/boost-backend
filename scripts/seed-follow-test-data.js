/**
 * Seed a follow graph for testing the followers screens.
 *
 * Builds a realistic web around two test accounts so every case on the
 * Followers / Following / Mutuals tabs has something to show:
 *
 *   - followers both accounts share
 *   - followers unique to each one
 *   - people each account follows who follow the other, which is what the
 *     "Followed by … and N others" strip reads
 *   - more than one page of rows, so load-more-on-scroll can be tested
 *
 * Existing users are reused — nothing is created. Rows are upserted and the
 * follower/following counts are recomputed from the follows collection
 * afterwards, so running it twice changes nothing.
 *
 *   node scripts/seed-follow-test-data.js --dry-run   # report only, no writes
 *   node scripts/seed-follow-test-data.js             # apply
 *   node scripts/seed-follow-test-data.js --undo      # remove only what it added
 *   node scripts/seed-follow-test-data.js --force     # allow a non-dev database
 *
 * Refuses to touch a database whose name doesn't look like development unless
 * --force is passed.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');
const UNDO = process.argv.includes('--undo');
const FORCE = process.argv.includes('--force');

const ACCOUNTS = {
  shayan: 'shayanjamil500@gmail.com',
  alex: 'alexbrad1717@gmail.com',
};

/**
 * Slices of the candidate list, kept as ranges so the graph is easy to read
 * and identical on every run (candidates are sorted by _id).
 *
 *   0–7    follow both accounts        → shared followers
 *   0–8    followed by alex            → mutuals on shayan's profile (9)
 *   8–23   follow shayan only          → shayan's unique followers
 *   24–31  follow alex only            → alex's unique followers
 *   24–29  followed by shayan          → mutuals on alex's profile (6)
 *   32–34  followed by alex, no follow back
 *   35–42  followed by shayan, no follow back
 */
const PLAN = {
  followsShayan: [[0, 24]],
  followsAlex: [
    [0, 8],
    [24, 32],
  ],
  alexFollows: [
    [0, 9],
    [32, 35],
  ],
  shayanFollows: [
    [24, 30],
    [35, 43],
  ],
};

const NEEDED = 43;

const expand = (ranges, list) =>
  ranges.flatMap(([from, to]) => list.slice(from, to));

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  const dbName = uri.split('/').pop().split('?')[0];
  if (!/dev|test|local/i.test(dbName) && !FORCE) {
    throw new Error(`Refusing to touch "${dbName}" — looks like production. Use --force.`);
  }

  await mongoose.connect(uri);
  console.log(`\nDatabase: ${dbName}${DRY_RUN ? '  (dry run)' : ''}\n`);

  const users = mongoose.connection.collection('users');
  const follows = mongoose.connection.collection('follows');

  const shayan = await users.findOne({ email: ACCOUNTS.shayan });
  const alex = await users.findOne({ email: ACCOUNTS.alex });

  if (!shayan) throw new Error(`No user with email ${ACCOUNTS.shayan}`);
  if (!alex) throw new Error(`No user with email ${ACCOUNTS.alex}`);

  console.log(`shayan: ${shayan._id} (${shayan.username})`);
  console.log(`alex:   ${alex._id} (${alex.username})\n`);

  // Everyone else who could appear in a list, in a stable order.
  const candidates = await users
    .find(
      {
        _id: { $nin: [shayan._id, alex._id] },
        isActive: true,
        isBanned: { $ne: true },
      },
      { projection: { username: 1, firstName: 1 } },
    )
    .sort({ _id: 1 })
    .toArray();

  console.log(`Candidate users: ${candidates.length} (need ${NEEDED})`);
  if (candidates.length < NEEDED) {
    throw new Error(`Only ${candidates.length} usable users; need ${NEEDED}.`);
  }

  // follower -> following, both directions of the two accounts included.
  const edges = [
    ...expand(PLAN.followsShayan, candidates).map((u) => [u._id, shayan._id]),
    ...expand(PLAN.followsAlex, candidates).map((u) => [u._id, alex._id]),
    ...expand(PLAN.alexFollows, candidates).map((u) => [alex._id, u._id]),
    ...expand(PLAN.shayanFollows, candidates).map((u) => [shayan._id, u._id]),
    [shayan._id, alex._id],
    [alex._id, shayan._id],
  ];

  const key = (a, b) => `${a}:${b}`;
  const unique = new Map(edges.map(([a, b]) => [key(a, b), [a, b]]));

  console.log(`Follow rows in the plan: ${unique.size}`);

  const now = new Date();
  const ops = [...unique.values()].map(([follower, following], i) => ({
    updateOne: {
      filter: { follower, following },
      // Spread the timestamps a minute apart so "newest first" has an order.
      update: {
        $setOnInsert: {
          follower,
          following,
          createdAt: new Date(now.getTime() - i * 60_000),
          updatedAt: now,
        },
      },
      upsert: true,
    },
  }));

  if (UNDO) {
    const filters = [...unique.values()].map(([follower, following]) => ({
      follower,
      following,
    }));

    if (DRY_RUN) {
      console.log(`Would delete up to ${filters.length} follow rows.`);
    } else {
      const res = await follows.deleteMany({ $or: filters });
      console.log(`Deleted ${res.deletedCount} follow rows.`);
    }
  } else if (DRY_RUN) {
    const existing = await follows.countDocuments({
      $or: [...unique.values()].map(([follower, following]) => ({ follower, following })),
    });
    console.log(`Already present: ${existing}. Would insert: ${unique.size - existing}.`);
  } else {
    const res = await follows.bulkWrite(ops, { ordered: false });
    console.log(`Inserted ${res.upsertedCount}, already present ${unique.size - res.upsertedCount}.`);
  }

  // Counts are denormalised on the user, so bring every touched account back
  // in line with the rows that actually exist.
  const touched = [
    ...new Set([...unique.values()].flatMap(([a, b]) => [String(a), String(b)])),
  ].map((id) => new mongoose.Types.ObjectId(id));

  if (!DRY_RUN) {
    const [followerCounts, followingCounts] = await Promise.all([
      follows.aggregate([{ $match: { following: { $in: touched } } }, { $group: { _id: '$following', n: { $sum: 1 } } }]).toArray(),
      follows.aggregate([{ $match: { follower: { $in: touched } } }, { $group: { _id: '$follower', n: { $sum: 1 } } }]).toArray(),
    ]);

    const followerMap = new Map(followerCounts.map((r) => [String(r._id), r.n]));
    const followingMap = new Map(followingCounts.map((r) => [String(r._id), r.n]));

    await users.bulkWrite(
      touched.map((id) => ({
        updateOne: {
          filter: { _id: id },
          update: {
            $set: {
              followerCount: followerMap.get(String(id)) || 0,
              followingCount: followingMap.get(String(id)) || 0,
            },
          },
        },
      })),
      { ordered: false },
    );

    console.log(`Recounted ${touched.length} users.`);
  }

  // What the screens should now show.
  const report = async (self, other, label) => {
    const [followers, following] = await Promise.all([
      follows.distinct('follower', { following: self._id }),
      follows.distinct('following', { follower: other._id }),
    ]);

    const followerIds = new Set(followers.map(String));
    const mutual = following.filter((id) => followerIds.has(String(id)));

    console.log(
      `${label}: ${followerIds.size} followers, ` +
        `${mutual.length} mutual with ${other.username}`,
    );
  };

  console.log('');
  await report(shayan, alex, 'shayan');
  await report(alex, shayan, 'alex  ');

  await mongoose.disconnect();
  console.log('\nDone.\n');
})().catch((err) => {
  console.error('\nFailed:', err.message, '\n');
  process.exit(1);
});
