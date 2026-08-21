/**
 * Repairs Video.thumbnailUrl values poisoned by the broken upload path (D-19/D-20).
 *
 * 🚫 DO NOT RUN AGAINST PRODUCTION MONGO — dev env first. See 02-POSTER-PIPELINE.md §5.5.
 *
 *   node scripts/repair-thumbnails.js --dry
 *   node scripts/repair-thumbnails.js
 *   node scripts/repair-thumbnails.js --collection=users --field=profileImage
 */
const mongoose = require('mongoose');
require('dotenv').config();

const DRY = process.argv.includes('--dry');
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const COLLECTION = argOf('collection', 'videos');
const FIELD = argOf('field', 'thumbnailUrl');
const KEY_FIELD = COLLECTION === 'videos' && FIELD === 'thumbnailUrl' ? 'thumbnailKey' : null;

// From env, so this follows whichever bucket the target environment uses.
const BUCKET = process.env.AWS_S3_BUCKET;
const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET_HOST = `https://${BUCKET}.s3.${REGION}.amazonaws.com/`;

const VIDEO_EXT = /\.(mp4|mov|webm|avi|m4v|mkv)$/i;

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!BUCKET) throw new Error('AWS_S3_BUCKET is not set');

  console.log({ DRY, COLLECTION, FIELD, BUCKET_HOST, mongo: process.env.MONGODB_URI.replace(/:[^:@]+@/, ':***@') });

  await mongoose.connect(process.env.MONGODB_URI);
  const coll = mongoose.connection.collection(COLLECTION);

  const cursor = coll.find(
    { [FIELD]: { $nin: [null, ''] } },
    { projection: { [FIELD]: 1 } },
  );

  let cleared = 0, converted = 0, untouched = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const raw = String(doc[FIELD]);
    const path = raw.split('?')[0];                       // strip presign query

    // Case A: it points at a video file. Unrecoverable — there is no cover image.
    if (VIDEO_EXT.test(path)) {
      cleared++;
      if (!DRY) {
        const update = { $set: { [FIELD]: '' } };
        if (KEY_FIELD) update.$unset = { [KEY_FIELD]: '' };
        await coll.updateOne({ _id: doc._id }, update);
      }
      continue;
    }

    // Case B: a presigned image URL. The object exists; rebuild a permanent URL.
    if (raw.includes('X-Amz-Signature') && path.startsWith(BUCKET_HOST)) {
      const key = decodeURIComponent(path.slice(BUCKET_HOST.length));
      converted++;
      if (!DRY) {
        const $set = { [FIELD]: BUCKET_HOST + key };
        if (KEY_FIELD) $set[KEY_FIELD] = key;
        await coll.updateOne({ _id: doc._id }, { $set });
      }
      continue;
    }

    // Case C: already a clean public image URL. Backfill the key if we can.
    if (KEY_FIELD && path.startsWith(BUCKET_HOST)) {
      const key = decodeURIComponent(path.slice(BUCKET_HOST.length));
      if (!DRY) await coll.updateOne({ _id: doc._id }, { $set: { [KEY_FIELD]: key } });
    }
    untouched++;
  }

  console.log({ DRY, cleared, converted, untouched });
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
