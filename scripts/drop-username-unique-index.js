/**
 * One-off: usernames are the display name now and are deliberately NOT unique.
 * The schema no longer declares `unique`, but Mongo keeps an index once it has
 * been built, so it has to be dropped by hand on every environment.
 *
 *   node scripts/drop-username-unique-index.js
 *
 * Safe to run twice: it does nothing when the index is already gone.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  await mongoose.connect(uri);
  const users = mongoose.connection.db.collection('users');
  const existing = await users.indexes();
  const unique = existing.find(
    (i) => JSON.stringify(i.key) === '{"username":1}' && i.unique,
  );

  if (!unique) {
    console.log('No unique username index — nothing to do.');
  } else {
    await users.dropIndex(unique.name);
    console.log(`Dropped ${unique.name}. Mongoose recreates it without "unique" on boot.`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
