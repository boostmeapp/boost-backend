/**
 * Backfill usernames for existing users.
 *
 * The username is the display name now (see common/utils/display-name.util),
 * but accounts created before that have none, so they fall back to their
 * first/last name or show as "Anonymous". This gives every account a username:
 *
 *   1. firstName + lastName  → "John Smith"
 *   2. whichever one exists  → "John"
 *   3. neither               → a readable random one, e.g. "Crocodile482"
 *
 * Accounts that already have a username are never touched, so the script is
 * safe to run again — a second run only picks up whatever is still missing.
 * Usernames are deliberately NOT unique, so nothing here checks for clashes.
 *
 *   node scripts/backfill-usernames.js --dry-run   # report only, no writes
 *   node scripts/backfill-usernames.js             # apply
 *   node scripts/backfill-usernames.js --force     # allow a non-dev database
 *
 * Refuses to touch a database whose name doesn't look like development
 * unless --force is passed, and stops early if a unique username index is
 * still in place (run scripts/drop-username-unique-index.js first).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const ANIMALS = [
  'Crocodile', 'Tiger', 'Falcon', 'Panda', 'Otter', 'Dolphin', 'Leopard',
  'Badger', 'Heron', 'Lynx', 'Puffin', 'Koala', 'Jaguar', 'Walrus', 'Osprey',
  'Gecko', 'Marmot', 'Pelican', 'Bison', 'Mantis',
];

/** e.g. "Crocodile482" — readable, and not meant to be unique. */
const randomUsername = () => {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${animal}${Math.floor(100 + Math.random() * 900)}`;
};

const usernameFor = (user) => {
  const first = String(user.firstName || '').trim();
  const last = String(user.lastName || '').trim();
  const fromName = `${first} ${last}`.trim();

  return fromName ? { username: fromName, source: 'name' } : { username: randomUsername(), source: 'generated' };
};

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  const dbName = uri.match(/@[^/]+\/([^?]+)/)?.[1] || '(unknown)';
  const looksLikeDev = /dev|local|staging|test/i.test(dbName);

  if (!looksLikeDev && !FORCE) {
    console.error(
      `Refusing to run against "${dbName}": it does not look like a development database.\n` +
        'Re-run with --force if this really is the database you mean.',
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  const users = mongoose.connection.db.collection('users');

  // Two accounts can legitimately share a name, so a leftover unique index
  // would reject part of the backfill.
  const uniqueIndex = (await users.indexes()).find(
    (i) => JSON.stringify(i.key) === '{"username":1}' && i.unique,
  );
  if (uniqueIndex && !FORCE) {
    console.error(
      `A unique username index (${uniqueIndex.name}) is still in place, so duplicate names would fail.\n` +
        'Run: node scripts/drop-username-unique-index.js\n' +
        '(If a server is running older code, restart it afterwards or it recreates the index.)',
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  // Missing, null or empty — the same three cases the display name treats as absent.
  const missing = {
    $or: [{ username: { $exists: false } }, { username: null }, { username: '' }],
  };

  const total = await users.countDocuments({});
  const candidates = await users
    .find(missing, { projection: { firstName: 1, lastName: 1 } })
    .toArray();

  console.log(`Database:            ${dbName}${DRY_RUN ? '  (dry run)' : ''}`);
  console.log(`Users total:         ${total}`);
  console.log(`Without a username:  ${candidates.length}`);
  console.log(`Already have one:    ${total - candidates.length} (skipped)`);

  let fromName = 0;
  let generated = 0;
  const operations = [];

  for (const user of candidates) {
    const { username, source } = usernameFor(user);
    if (source === 'name') fromName += 1;
    else generated += 1;

    // The filter repeats the "missing" condition so a concurrent write can't
    // be overwritten between reading and updating.
    operations.push({
      updateOne: {
        filter: { _id: user._id, ...missing },
        update: { $set: { username } },
      },
    });

    if (candidates.length <= 20) {
      console.log(`  ${user._id} → "${username}" (${source})`);
    }
  }

  let modified = 0;
  let failed = 0;
  if (!DRY_RUN && operations.length) {
    // Batched so a large user base doesn't go over the write limit, and
    // unordered so one bad write can't stop the rest.
    for (let i = 0; i < operations.length; i += 500) {
      const batch = operations.slice(i, i + 500);
      try {
        const res = await users.bulkWrite(batch, { ordered: false });
        modified += res.modifiedCount;
      } catch (err) {
        modified += err.result?.nModified ?? 0;
        failed += err.writeErrors?.length ?? batch.length;
        console.error(`  batch error: ${err.message}`);
      }
    }
  }

  console.log('---');
  console.log(`From first/last name: ${fromName}`);
  console.log(`Generated:            ${generated}`);
  console.log(`Updated:              ${DRY_RUN ? 0 : modified}${DRY_RUN ? '  (dry run — nothing written)' : ''}`);
  if (failed) console.log(`Failed:               ${failed}`);

  const remaining = await users.countDocuments(missing);
  console.log(`Still without one:    ${remaining}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
