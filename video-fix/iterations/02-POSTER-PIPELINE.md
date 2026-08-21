# Iteration 2 — Poster / Thumbnail Pipeline

**Scope:** frontend + backend + AWS bucket/IAM permissions (§5.0) + a one-off data repair
script that is **written now and run later** (§5.5).
**Closes:** D-17 … D-24.
**Depends on:** Iteration 1 (a deterministic active item, so "did the poster show" is answerable).
**Production posture:** the app is live and the S3 bucket is production. §5.0 is read-only
and additive; §5.5 is blocked on a dev environment. See
[00-OVERVIEW.md → Constraints #9](video-fix/iterations/00-OVERVIEW.md).

---

## 1. Objective

Kill the black screen. After this iteration, every feed item paints something meaningful
the instant it scrolls into view — a real cover frame for videos that have one, and a
deterministic branded placeholder for the ones that do not — and newly uploaded videos
always get a real, permanently-valid cover image.

Three separate things have to be true for that:

1. Thumbnail uploads must **stop failing silently** (they currently 400 on every single
   upload).
2. The failure path must **stop poisoning the database** with the video's own URL.
3. The buffering player must **stop opening a second full download of the same MP4** just
   to guess at a frame.

---

## 2. Problems addressed

### 2.1 The thumbnail upload has never worked (D-17, D-18, D-19)

A three-link chain, every link broken:

**Link 1** — [UploadScreen.jsx:136-148](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L136-L148)
asks for a thumbnail upload:

```js
const thumbUpload = await uploadService.uploadFile(customThumbnail.uri, 'profile_image');
```

**Link 2** — [uploadService.js:22](newboostraapp/src/services/uploadService.js#L22) ignores
the second argument for routing purposes:

```js
const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.UPLOAD.DIRECT}`;   // ALWAYS /upload/video
...
parameters: { type: type },        // sent as a multipart form field
```

`API_CONFIG.ENDPOINTS.UPLOAD.DIRECT` is `'/upload/video'`
([api.config.js:47](newboostraapp/src/config/api.config.js#L47)). The `type` parameter is a
form field. `UploadController.uploadVideo` never reads a `type` field — its signature is
`(@CurrentUser() user, @UploadedFile() file)`.

**Link 3** — [upload.controller.ts:112-119](boost-backend/src/modules/upload/upload.controller.ts#L112-L119):

```ts
fileFilter: (_, file, cb) => {
  if (!file.mimetype.startsWith('video/')) {
    return cb(new BadRequestException('Only video files allowed'), false);
  }
```

A JPEG is rejected. `thumbUpload.success` is `false`, so `realThumbnailUrl` stays `null`.
The fallback block at [UploadScreen.jsx:151-161](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L151-L161)
regenerates the frame and calls the **same broken function**, so it fails identically. Then:

```js
// UploadScreen.jsx:174
thumbnailUrl: realThumbnailUrl || upload.data.url,   // ← the VIDEO's presigned URL
```

That string is what `POST /videos` persists into `Video.thumbnailUrl`.

The same bug exists on the edit path:
[FeedPostItem.jsx:146](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L146)
also calls `uploadService.uploadFile(newThumbnailFile, 'profile_image')`. Changing a
video's cover from the feed has never worked either.

### 2.2 The frontend defends against the poison, producing a black screen (D-19 cont.)

[HomeScreen.jsx:183-193](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L183-L193)
correctly refuses to hand an `.mp4` URL to `<Image>`:

```js
if (lower.endsWith('.mp4') || lower.endsWith('.mov') || ...) return null;
```

So `posterUri` is `null` for essentially every app-uploaded video, and
[FeedPostItem.jsx:487](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L487)
renders nothing:

```jsx
{(!isVideoLoaded || !isPlaying) && posterUri ? <Image .../> : null}
```

Nothing covers the buffering player. The player's own surface is black. That is the black
screen.

Note the extension check is also incomplete — a poisoned URL is a **presigned** URL
(`...mp4?X-Amz-Algorithm=...&X-Amz-Signature=...`). The code does
`thumb.toLowerCase().split('?')[0]` first, so it does strip the query and the check does
catch it. That part is correct.

### 2.3 Anything that *did* persist expires in 24 hours (D-20)

[upload.service.ts:224-234](boost-backend/src/modules/upload/upload.service.ts#L224-L234):

```ts
await this.s3Client.send(command);
const { url: signedUrl } = await this.generateDownloadUrl(key);
return { key, url: signedUrl };
```

`DOWNLOAD_URL_EXPIRATION = 86400`. Every URL this function has ever returned — including
every `profileImage` written by `POST /upload/profile-image`
([upload.controller.ts:52-61](boost-backend/src/modules/upload/upload.controller.ts#L52-L61))
— is dead 24 hours after upload. Meanwhile `getPublicUrl(key)` exists two functions above
([upload.service.ts:188-191](boost-backend/src/modules/upload/upload.service.ts#L188-L191))
and is used only by `generateProfileImageUploadUrl`, which nothing calls.

### 2.4 The live poster path competes with playback (D-21)

[FeedPostItem.jsx:443-450](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L443-L450):

```js
if (isFocused && item.videoUrl?.startsWith('http')) {
    VideoThumbnails.getThumbnailAsync(item.videoUrl, { time: 500 })
```

`expo-video-thumbnails` against a **remote** URL has to fetch enough of the file to decode
a frame at 500 ms. On a non-faststart MP4 (D-44 — no `-movflags +faststart` anywhere) the
`moov` atom is at the *end* of the file, so "enough of the file" can mean the whole file.

This runs `if (isFocused)` — that is, on exactly the item that is simultaneously trying to
buffer for playback, over the same connection to the same bucket. It is a self-inflicted
denial of bandwidth, and by construction it can never produce a poster before the video is
already playing.

### 2.5 The poster is painted twice, and inconsistently across surfaces (D-22, D-24)

- `FeedPostItem` draws the poster as an overlay `<Image>` (487-493) **and** passes
  `usePoster` / `posterSource` / `posterStyle` to `<Video>` (502-504). Two surfaces, two
  different lifecycles. (Iteration 1 already removed the `usePoster` half.)
- `HomeScreen` sanitises `thumbnailUrl` through `resolveThumbnail`;
  [video/[id].jsx:36](newboostraapp/src/app/video/[id].jsx#L36) does
  `thumbnailUrl: v.thumbnailUrl || v.thumbnail` with **no guard at all**, so on that surface
  the poisoned `.mp4` URL is handed straight to `<Image>`.
- `FeedPostItem` has its *own third* copy of the sanitiser at lines 429-441, with the S3
  hostname hardcoded again at line 437.

### 2.6 No `Cache-Control` on any uploaded object (D-23)

[upload.service.ts:211-222](boost-backend/src/modules/upload/upload.service.ts#L211-L222)
sets `ContentType` and `Metadata` and nothing else. Every poster fetch and every re-watch
is a cold origin round-trip to Stockholm. This also means iteration 5's CloudFront
distribution would have nothing to honour.

---

## 3. Approach

**Backend**

1. Add a real `POST /upload/thumbnail` endpoint — image mimetype filter, `memoryStorage`,
   `UploadType.THUMBNAIL` keying (`thumbnails/{userId}/...`).
2. Make `UploadService.uploadFile` return a **public, non-expiring** URL for image types and
   set `CacheControl` on every `PutObjectCommand`.
3. Make `thumbnailUrl` optional on `CreateVideoDto` and on the schema, and add an additive
   optional `thumbnailKey`. A video with no cover is a legitimate state; a video with a
   cover that is secretly an MP4 is not.
4. **Write** a one-off repair script that clears poisoned `thumbnailUrl` values and converts
   recoverable presigned ones to public URLs. **Running it against production is deferred**
   until a separate dev environment exists — see the gate in §5.5 and
   [00-OVERVIEW.md → Constraints #9](video-fix/iterations/00-OVERVIEW.md).

0. Before any of the above: prepare the bucket — one additive bucket-policy statement and
   one IAM grant for the new `thumbnails/` prefix. See §5.0, which is read-only and
   additive throughout and is safe to perform on the live bucket.

**Frontend**

5. Add `uploadService.uploadThumbnail(uri)` pointing at the new endpoint; switch both call
   sites (`UploadScreen` and `FeedPostItem.handleSaveEdit`) to it.
6. **Delete** the `thumbnailUrl: realThumbnailUrl || upload.data.url` fallback. Never send
   a video URL as a thumbnail, ever, under any failure mode.
7. **Delete** the remote `VideoThumbnails.getThumbnailAsync` call. It goes away and is not
   replaced in this iteration.
8. Centralise URL resolution into one `src/utils/media.js` used by all three surfaces.
9. Add a `<FeedPoster>` component: real cover image when there is one, otherwise a
   deterministic gradient derived from the video id plus the creator avatar — never black.
10. Prefetch the next two items' poster images with `Image.prefetch`.

---

## 4. Why this approach

**Why a new endpoint rather than making `uploadFile` respect its `type` argument.** Both
work. A dedicated route is better here because the mimetype filter, the size limit and the
storage engine all differ per type and are configured *in the decorator*, not in the
handler body — `/upload/video` uses `diskStorage({ destination: '/tmp' })` and a 500 MB
limit, which is exactly wrong for a 200 KB JPEG. You cannot branch a `FileInterceptor`
config on a form field that multer hasn't parsed yet. Separate routes, separate configs.

**Why public URLs instead of longer-lived presigned URLs.** A presigned URL is a *capability*,
and capabilities do not belong in a database row that is served to every viewer of a public
feed. Raising `expiresIn` from 24 h to a year would work for exactly as long as nobody
rotates the IAM key, and it makes every poster URL unique-per-generation, which defeats
both HTTP caching and CloudFront. The bucket already serves videos unsigned, so the
security posture does not change — see the verification step in §5.1.

**Why make `thumbnailUrl` optional rather than requiring the client to always produce one.**
Because the client *cannot* always produce one — `VideoThumbnails.getThumbnailAsync` on a
local file can fail on exotic codecs, and the current code's response to that failure is
what created this entire bug. Given the choice between "no cover" and "a cover that is
secretly a 40 MB MP4", the schema should permit the first and forbid the second. The
placeholder in §5.7 makes "no cover" visually acceptable.

**Why delete the remote frame extraction outright rather than fix it.** There is no fix.
Extracting a frame from a remote non-faststart MP4 requires downloading it. The correct
sources of a poster are (a) an image uploaded at publish time — restored by this iteration —
and (b) a frame extracted from a **locally cached** copy, which becomes possible in
iteration 4 and costs nothing extra once the file is already on disk. Until then, deleting
the call is a strict improvement: it frees the bandwidth the visible video needs.

**Why a deterministic gradient rather than a generic grey placeholder.** There is a long
tail of already-uploaded videos whose covers are unrecoverable (the source frame was never
uploaded, and the backend has no ffmpeg to extract one — D-44). Those items need to look
intentional rather than broken. Deriving the hue from a hash of `item.id` means the same
video always shows the same colour, which reads as design rather than as a loading failure.

---

## 5. Exact backend changes

### 5.0 AWS / S3 preparation (do this first — it gates everything else)

> ### ⚠️ Production safety
>
> `boostme-storage` is the **live production bucket** and the app is live against it. Local
> development currently points at a private Mongo but at this **same production bucket**, so
> anything you upload while testing lands in prod.
>
> Everything in this section is either a **read-only check** or an **additive permission
> change**. Nothing here rewrites, re-tags or deletes an existing object.
>
> **Do not**, at any point in this iteration:
> - run `aws s3 cp --recursive`, `aws s3 sync`, or any `--metadata-directive REPLACE` sweep;
> - run the repair script in §5.5 against the production database (see the gate there);
> - **replace** the existing bucket policy — only add a statement to it (§5.0.4).
>
> The object-mutating and row-mutating work in this plan is deferred until a separate
> development environment exists on Render. See
> [00-OVERVIEW.md → Constraints #9](video-fix/iterations/00-OVERVIEW.md).

#### 5.0.1 What lives where in the bucket

Keys are minted by `generateS3Key()`
([upload.service.ts:135-150](boost-backend/src/modules/upload/upload.service.ts#L135)).
S3 has no directories — a prefix exists the moment the first object is PUT under it, so
there is nothing to "create". What you create is the *permission* for it.

| Prefix | Written by | Read as | Action needed |
|---|---|---|---|
| `videos/{userId}/…` | `POST /upload/video` | Unsigned public URL composed by the app | None — already works |
| `profiles/{userId}/…` | `POST /upload/profile-image`, `POST /upload/image` | Presigned today → **public** after §5.2 | **Verify public read** (5.0.3) |
| `thumbnails/{userId}/…` | *nothing yet* → `POST /upload/thumbnail` (§5.1) | Public URL | **New — grant read + write** |
| `uploads/{userId}/…` | `default:` branch of `generateS3Key` | — | Unreachable; all three `UploadType` values map explicitly. Ignore. |

Bucket: `boostme-storage`. Region: `eu-north-1`. Public URL shape, from `getPublicUrl()`:
`https://{bucket}.s3.{region}.amazonaws.com/{key}`.

#### 5.0.2 Read-only verification (safe on prod — run these first)

```bash
# 1. A video object — should be 200 and already works (the app plays these unsigned)
curl -sI "https://boostme-storage.s3.eu-north-1.amazonaws.com/<paste a real rawVideoKey>" | head -5

# 2. An image object under profiles/ — this is the one that matters
curl -sI "https://boostme-storage.s3.eu-north-1.amazonaws.com/<paste a real profiles/... key>" | head -5
```

Both must return `HTTP/1.1 200`. If (1) is 200 and (2) is 403, the bucket policy is scoped
to a prefix and you must extend it (5.0.4) before deploying §5.2 — otherwise you ship
broken avatars the moment `uploadFile` starts returning public URLs.

**Why (2) can lie to you today:** avatars currently work through *presigned* URLs, which
succeed regardless of the bucket policy. Only an unsigned request tells you the truth, and
§5.2 makes every image URL unsigned. This check is the whole point of §5.0.

#### 5.0.3 Bucket policy — add `thumbnails/*`, confirm `profiles/*`

This is the **single most likely way this iteration ships broken** (§9). Videos already
serve unsigned, so a public-read statement exists; the open question is whether its
`Resource` is scoped to `videos/*`.

The read side must cover all three prefixes:

```json
{
  "Sid": "PublicReadMedia",
  "Effect": "Allow",
  "Principal": "*",
  "Action": "s3:GetObject",
  "Resource": [
    "arn:aws:s3:::boostme-storage/videos/*",
    "arn:aws:s3:::boostme-storage/profiles/*",
    "arn:aws:s3:::boostme-storage/thumbnails/*"
  ]
}
```

**Edit additively.** If a statement already grants `videos/*`, extend its `Resource` array —
do not paste a replacement policy. Narrowing the existing grant by accident breaks video
playback for every live user instantly, with no deploy and no rollback step to undo it.
Copy the current policy to a local file before touching it.

This is a permission change, not a data change, and it is reversible — it is safe to do on
prod, unlike anything in §5.5.

#### 5.0.4 Block Public Access — confirm the policy-level toggles are off

`BlockPublicPolicy` and `RestrictPublicBuckets` must both be **off**, or the bucket policy
in 5.0.3 is inert no matter what it says. Videos already serve unsigned so this is almost
certainly already the case — confirm it in the same sitting rather than debugging a 403
later. Do not change the ACL-related toggles (see 5.0.7).

#### 5.0.5 IAM — the write side (the curl checks do **not** cover this)

5.0.2 verifies *read*. It says nothing about whether the backend's IAM identity can *write*
to a prefix that has never been written to.

Check the policy attached to the `AWS_ACCESS_KEY_ID` identity. If its `Resource` is
`arn:aws:s3:::boostme-storage/*`, there is nothing to do. If it is prefix-scoped, add
`thumbnails/*` to the `s3:PutObject` grant:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
  "Resource": [
    "arn:aws:s3:::boostme-storage/videos/*",
    "arn:aws:s3:::boostme-storage/profiles/*",
    "arn:aws:s3:::boostme-storage/thumbnails/*"
  ]
}
```

Symptom if you skip this: `POST /upload/thumbnail` returns `400 Failed to upload file to
S3: Access Denied`, which reads exactly like a code bug in the new endpoint. Rule it out
here rather than there.

#### 5.0.6 `AWS_REGION` must be set to `eu-north-1` in every deployed environment

Both the S3 client and `getPublicUrl()` read
`configService.get('AWS_REGION') || 'us-east-1'`
([upload.service.ts:38](boost-backend/src/modules/upload/upload.service.ts#L38),
[:189](boost-backend/src/modules/upload/upload.service.ts#L189)).

Today `getPublicUrl` is dead code, so a missing or wrong `AWS_REGION` is completely
invisible. §5.2 makes it load-bearing for **every image URL written to the database** — a
wrong value silently persists
`https://boostme-storage.s3.us-east-1.amazonaws.com/…` into Mongo, and those rows are then
wrong forever. Verify the env var on Render **before** deploying §5.2, not after.

#### 5.0.7 What you do *not* need to configure

- **CORS.** React Native's `<Image>` and `expo-av` are native HTTP clients, not browsers —
  no preflight, no `Access-Control-Allow-Origin`. Only a web surface would need this.
- **ACLs / Object Ownership.** `uploadFile` sets no ACL and must not start. If Object
  Ownership is "Bucket owner enforced" (the default for buckets created after April 2023),
  ACLs are disabled entirely and any `ACL:` field is a hard error. Note that
  `generateProfileImageUploadUrl` ([upload.service.ts:118](boost-backend/src/modules/upload/upload.service.ts#L118))
  sets `ACL: 'public-read'` — it is dead code today, and it would fail under
  bucket-owner-enforced. Do not wire it up without checking that setting first.
- **A new bucket, or any bucket-level cache setting.** `Cache-Control` is per-object and is
  set at PUT time by §5.2. There is no bucket-wide equivalent.

#### 5.0.8 Deferred — do **not** do these now

- **Backfilling `Cache-Control` onto existing objects.** §5.2 only affects *new* uploads;
  existing videos and avatars stay header-less. This is iteration 5 Phase B, it rewrites
  every object's metadata, and it is exactly the kind of prod mutation that is off the table
  until the dev environment exists.
- **A lifecycle rule to abort incomplete multipart uploads.** Useful hygiene against
  orphaned parts from failed 500 MB video uploads, unrelated to this iteration. Additive and
  safe, but park it.

#### 5.0.9 Checklist

- [ ] 5.0.2 curl (1) returns 200 — video reads work unsigned.
- [ ] 5.0.2 curl (2) returns 200 — image reads work unsigned. If 403, do 5.0.3 first.
- [ ] Current bucket policy copied to a local file before any edit.
- [ ] Bucket policy `s3:GetObject` covers `thumbnails/*` (added, not replaced).
- [ ] `BlockPublicPolicy` and `RestrictPublicBuckets` are off.
- [ ] IAM `s3:PutObject` covers `thumbnails/*`.
- [ ] `AWS_REGION=eu-north-1` confirmed in the deployed backend env.
- [ ] No `aws s3 cp/sync`, no metadata rewrite, no object deletion performed.

### 5.1 `src/modules/upload/upload.controller.ts` — new thumbnail route

Insert after the existing `@Post('image')` handler (line 106):

```ts
  // ✅ VIDEO COVER THUMBNAILS — image mimetypes, keyed under thumbnails/
  @Post('thumbnail')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — matches MAX_IMAGE_SIZE
      fileFilter: (_, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(new BadRequestException('Only image files allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadThumbnail(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Image file is required');
    }

    const { url, key } = await this.uploadService.uploadFile(
      user.id,
      UploadType.THUMBNAIL,
      file,
    );

    return { success: true, url, key };
  }
```

`UploadType.THUMBNAIL` already exists
([request-upload.dto.ts](boost-backend/src/modules/upload/dto/request-upload.dto.ts)),
`generateS3Key` already handles it (`thumbnails/{userId}/{ts}-{uuid}.{ext}`,
[upload.service.ts:143-144](boost-backend/src/modules/upload/upload.service.ts#L143)), and
`validateFileSize` already handles it
([upload.service.ts:173-180](boost-backend/src/modules/upload/upload.service.ts#L173)).
No other backend file needs to change for this route to exist.

### 5.2 `src/modules/upload/upload.service.ts` — cache headers + public URLs

Add a constant near the other size/expiry constants (line 26-32):

```ts
  // Uploaded objects are immutable: the key contains a uuid, so a new file is
  // always a new key. Safe to cache for a year at every layer.
  private readonly IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
```

Rewrite `uploadFile` (lines 197-254):

```ts
  async uploadFile(
    userId: string,
    type: UploadType,
    file: Express.Multer.File,
  ): Promise<{ key: string; url: string }> {
    this.validateFileSize(type, file.size);

    const key = this.generateS3Key(userId, type, file.originalname);
    const body = file.buffer || (file.path ? fs.createReadStream(file.path) : undefined);

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: body,
      ContentLength: file.size,
      ContentType: file.mimetype,
      CacheControl: this.IMMUTABLE_CACHE_CONTROL,     // ← NEW
      Metadata: {
        userId,
        originalFileName: file.originalname,
        uploadType: type,
      },
    });

    try {
      await this.s3Client.send(command);

      // Images are public, permanent assets referenced from DB rows and served to
      // every viewer — they must NOT be time-limited presigned capabilities.
      // Videos keep the presigned URL for now; iteration 3 moves video URL
      // composition to the feed service and iteration 5 puts a CDN in front.
      const isImage = type !== UploadType.VIDEO;
      const url = isImage
        ? this.getPublicUrl(key)
        : (await this.generateDownloadUrl(key)).url;

      return { key, url };
    } catch (error) {
      console.error('S3 Upload Error:', {
        message: error.message,
        code: error.Code || error.code,
        bucket: this.bucketName,
        key,
      });
      throw new BadRequestException(`Failed to upload file to S3: ${error.message}`);
    } finally {
      if (file.path && fs.existsSync(file.path)) {
        try { fs.unlinkSync(file.path); } catch (e) { /* ignore cleanup error */ }
      }
    }
  }
```

Side effect, intentional and desirable: `POST /upload/profile-image` now writes a permanent
public URL into `user.profileImage` instead of a 24-hour presigned one, fixing avatars that
silently vanish a day after upload. Existing rotten values are handled by §5.5.

### 5.3 `src/modules/video/dto/create-video.dto.ts`

```diff
-  @IsString()
-  @IsNotEmpty()
-  thumbnailUrl: string; // S3 key of thumbnail
+  @IsString()
+  @IsOptional()
+  thumbnailUrl?: string; // Absolute, public cover-image URL. Empty when none exists.
+
+  @IsString()
+  @IsOptional()
+  thumbnailKey?: string; // S3 key of the cover image (authoritative from iteration 3)
```

> **`forbidNonWhitelisted` reminder.** [main.ts:84-99](boost-backend/src/main.ts#L84-L99)
> sets `whitelist: true, forbidNonWhitelisted: true`. Sending `thumbnailKey` from the app
> **before** this DTO change is deployed returns a 400, not a silent ignore. Deploy the
> backend first, then ship the app. `UpdateVideoDto extends PartialType(CreateVideoDto)`
> so the edit path picks both fields up for free.

### 5.4 `src/database/schemas/video/video.schema.ts`

```diff
-  @Prop({ required: true })
-  thumbnailUrl: string;
+  @Prop({ default: '' })
+  thumbnailUrl: string;
+
+  @Prop()
+  thumbnailKey?: string;
```

And in `VideoService.create` ([video.service.ts:44-59](boost-backend/src/modules/video/video.service.ts#L44-L59)):

```diff
       rawVideoKey: dto.rawVideoKey,
-      thumbnailUrl: dto.thumbnailUrl,
+      thumbnailUrl: dto.thumbnailUrl || '',
+      thumbnailKey: dto.thumbnailKey,
```

### 5.5 One-off repair script — `boost-backend/scripts/repair-thumbnails.js`

> ### 🚫 BLOCKED on the dev environment — do not run this against production
>
> This script performs `updateOne` writes against the `videos` collection. The app is live.
> Per [00-OVERVIEW.md → Constraints #9](video-fix/iterations/00-OVERVIEW.md), **no
> data-mutating script runs against production Mongo or production S3** until a separate
> development environment exists on Render.
>
> **Write the script now, run it later.** Its running order is:
>
> 1. Dev environment stood up on Render with its own Mongo (S3 may stay shared — this
>    script does not touch S3, only Mongo rows).
> 2. `node scripts/repair-thumbnails.js --dry` **there**, counts read and understood.
> 3. Applied there, verified idempotent, and the app verified against the repaired data
>    (T-2.9, T-2.13).
> 4. Only then, with a fresh `mongodump` in hand, the same two steps against production —
>    as an explicit, separately-decided release step, not as part of shipping this iteration.
>
> **What this gate costs you.** Until step 4, production rows keep their poisoned
> `thumbnailUrl` values. That is *tolerable*, because the frontend already refuses to hand a
> video URL to `<Image>` (`toPosterUrl`, §6.2) and §5.7's `FeedPoster` renders a gradient
> instead. Old videos look coverless rather than broken. The two DB-count success criteria
> in §11 are therefore scoped to the dev environment for this iteration — see the note
> there.
>
> **What is *not* blocked:** everything in §5.1–§5.4 and all of §6. Those are code deploys
> and app changes, fully reversible by redeploying, and they only affect *new* uploads.
> Ship them.

Run once — **in the dev environment** — after deploying §5.1–§5.4, before shipping the app
build.

```js
/**
 * Repairs Video.thumbnailUrl values poisoned by the broken upload path (D-19/D-20).
 *
 *   node scripts/repair-thumbnails.js --dry
 *   node scripts/repair-thumbnails.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const DRY = process.argv.includes('--dry');
const BUCKET_HOST = 'https://boostme-storage.s3.eu-north-1.amazonaws.com/';
const VIDEO_EXT = /\.(mp4|mov|webm|avi|m4v|mkv)$/i;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Video = mongoose.connection.collection('videos');

  const cursor = Video.find(
    { thumbnailUrl: { $nin: [null, ''] } },
    { projection: { thumbnailUrl: 1 } },
  );

  let cleared = 0, converted = 0, untouched = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const raw = String(doc.thumbnailUrl);
    const path = raw.split('?')[0];                       // strip presign query

    // Case A: it points at a video file. Unrecoverable — there is no cover image.
    if (VIDEO_EXT.test(path)) {
      cleared++;
      if (!DRY) await Video.updateOne(
        { _id: doc._id },
        { $set: { thumbnailUrl: '' }, $unset: { thumbnailKey: '' } },
      );
      continue;
    }

    // Case B: a presigned image URL. The object exists; rebuild a permanent URL.
    if (raw.includes('X-Amz-Signature') && path.startsWith(BUCKET_HOST)) {
      const key = decodeURIComponent(path.slice(BUCKET_HOST.length));
      converted++;
      if (!DRY) await Video.updateOne(
        { _id: doc._id },
        { $set: { thumbnailUrl: BUCKET_HOST + key, thumbnailKey: key } },
      );
      continue;
    }

    // Case C: already a clean public image URL. Backfill the key if we can.
    if (path.startsWith(BUCKET_HOST)) {
      const key = decodeURIComponent(path.slice(BUCKET_HOST.length));
      if (!DRY) await Video.updateOne({ _id: doc._id }, { $set: { thumbnailKey: key } });
    }
    untouched++;
  }

  console.log({ DRY, cleared, converted, untouched });
  await mongoose.disconnect();
})();
```

**Run `--dry` first and read the counts.** Expect `cleared` to be roughly the total number
of app-uploaded videos — that is the bug's blast radius, and seeing that number confirms
the diagnosis. Take a Mongo backup before the non-dry run.

Do the same for `users.profileImage` if the pre-flight check in §5.0 showed presigned
avatar URLs in the collection — same Case B logic, different collection. **Same gate: dev
environment only.** Note that untouched production avatars keep working until their
existing 24 h presigned URL lapses; from §5.2 onward every *newly uploaded* avatar is
permanent regardless of whether the repair has run.

### 5.6 Backend files touched

```
boost-backend/src/modules/upload/upload.controller.ts       (+ POST /upload/thumbnail)
boost-backend/src/modules/upload/upload.service.ts          (CacheControl, public image URLs)
boost-backend/src/modules/video/dto/create-video.dto.ts     (thumbnailUrl optional, + thumbnailKey)
boost-backend/src/database/schemas/video/video.schema.ts    (thumbnailUrl default '', + thumbnailKey)
boost-backend/src/modules/video/video.service.ts            (create(): write thumbnailKey)
boost-backend/scripts/repair-thumbnails.js                  (new — WRITE now, RUN later, dev env only)
```

**AWS changes (console, not code):** one additive `s3:GetObject` statement for
`thumbnails/*` on the bucket policy, one `s3:PutObject` grant for `thumbnails/*` on the IAM
identity, and a confirmation that `AWS_REGION=eu-north-1`. All three are covered by §5.0
and none of them mutate an object.

---

## 6. Exact frontend changes

### 6.1 `src/config/api.config.js`

```diff
         UPLOAD: {
             DIRECT: '/upload/video',
             PROFILE: '/upload/profile-image',
+            IMAGE: '/upload/image',
+            THUMBNAIL: '/upload/thumbnail',
         },
```

### 6.2 New file — `src/utils/media.js`

One place that knows about media URLs. All three surfaces import from here, killing the
three duplicated sanitisers and the three hardcoded bucket hostnames (D-24, and the setup
for D-32 in iteration 3).

```js
// The single place in the app that knows where media lives.
// Iteration 3 makes the backend author these URLs and this file becomes a
// pass-through; iteration 5 swaps the host for a CDN. Nothing else changes.
export const MEDIA_BASE_URL = 'https://boostme-storage.s3.eu-north-1.amazonaws.com/';

const VIDEO_EXT = /\.(mp4|mov|webm|avi|m4v|mkv)$/i;

const isAbsolute = (s) =>
    s.startsWith('http://') || s.startsWith('https://') || s.startsWith('file://');

/** Absolute URL for an S3 key, or an already-absolute URL untouched. */
export const toMediaUrl = (keyOrUrl) => {
    if (!keyOrUrl || typeof keyOrUrl !== 'string') return null;
    const v = keyOrUrl.trim();
    if (!v || v === 'null' || v === 'undefined') return null;
    return isAbsolute(v) ? v : `${MEDIA_BASE_URL}${v.replace(/^\//, '')}`;
};

/**
 * A poster URL, or null. Refuses anything that resolves to a video file —
 * the broken upload path (see 02-POSTER-PIPELINE.md §2.1) wrote video URLs
 * into Video.thumbnailUrl and old rows may still carry them.
 */
export const toPosterUrl = (keyOrUrl) => {
    const url = toMediaUrl(keyOrUrl);
    if (!url) return null;
    return VIDEO_EXT.test(url.split('?')[0]) ? null : url;
};

/** Stable 0-359 hue for a video id, so a coverless item always looks the same. */
export const hueForId = (id) => {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
};
```

### 6.3 `src/services/uploadService.js` — new method

Add alongside `uploadProfileImage` (it is the same shape, different endpoint):

```js
    /**
     * Upload a video cover image to /upload/thumbnail.
     * Returns { success, url, key }.
     */
    async uploadThumbnail(fileUri) {
        try {
            const token = await storageService.getAccessToken();
            const url = `${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.UPLOAD.THUMBNAIL}`;

            let uri = fileUri;
            if (Platform.OS === 'android' && !uri.startsWith('file://') && !uri.startsWith('content://')) {
                uri = `file://${uri}`;
            }

            const result = await uploadAsync(url, uri, {
                fieldName: 'file',
                httpMethod: 'POST',
                uploadType: FileSystemUploadType?.MULTIPART ?? 1,
                headers: { Authorization: `Bearer ${token}` },
            });

            let body = {};
            try { body = JSON.parse(result.body); } catch { body = {}; }

            if (result.status >= 200 && result.status < 300 && body?.url) {
                return { success: true, url: body.url, key: body.key };
            }
            return { success: false, status: result.status, message: body?.message || 'Thumbnail upload failed' };
        } catch (error) {
            return { success: false, message: error.message || 'Network error during thumbnail upload' };
        }
    },
```

Leave `uploadFile` as-is for videos, but **remove its misleading `type` parameter default**
so nobody reintroduces D-17:

```diff
-    async uploadFile(fileUri, type = 'video', onProgress = null) {
+    // Videos only. For images use uploadThumbnail / uploadProfileImage / uploadChatImage.
+    async uploadFile(fileUri, onProgress = null) {
```

…and drop the `parameters: { type }` blocks at lines 45-47 and 65-67. Update the two video
call sites accordingly (`UploadScreen.jsx:119-126`).

### 6.4 `src/screens/home/screens/UploadScreen.jsx`

Replace the whole thumbnail block (lines 130-177):

```js
      setUploadStatusText('Processing cover thumbnail...');
      setUploadProgress(95);

      // Pick the best local cover we have: user's custom image, then the frame
      // grabbed from the LOCAL file at pickVideo(), then one last local attempt.
      let localCoverUri =
        (thumbnailMode === 'custom' && customThumbnail?.uri) || autoThumbnailUri || null;

      if (!localCoverUri) {
        try {
          const { uri } = await VideoThumbnails.getThumbnailAsync(selectedVideo.uri, { time: 500 });
          localCoverUri = uri;
        } catch (e) {
          // Some codecs cannot be decoded on-device. Publishing without a cover
          // is an acceptable outcome; publishing the VIDEO's url as the cover is not.
        }
      }

      let thumbnailUrl = '';
      let thumbnailKey = undefined;

      if (localCoverUri) {
        const thumbUpload = await uploadService.uploadThumbnail(localCoverUri);
        if (thumbUpload.success) {
          thumbnailUrl = thumbUpload.url;
          thumbnailKey = thumbUpload.key;
        }
      }

      setUploadStatusText('Publishing post...');
      setUploadProgress(100);

      const duration = selectedVideo.duration ? Math.round(selectedVideo.duration / 1000) : 0;

      const payload = {
        title: (title.trim() || caption).slice(0, 50),
        description: caption,
        rawVideoKey: upload.data.key,
        thumbnailUrl,          // '' when we genuinely have no cover — never the video url
        duration: duration.toString(),
        tags,
      };
      if (thumbnailKey) payload.thumbnailKey = thumbnailKey;
```

The single most important line in this iteration is the **absence** of
`|| upload.data.url`.

Also cap the picker while you are in this file — it feeds iteration 5 and costs one line:

```diff
     const result = await ImagePicker.launchImageLibraryAsync({
       mediaTypes: ['videos'],
-      quality: 1,
+      quality: 0.8,
+      videoMaxDuration: 180,
     });
```

### 6.5 New component — `src/screens/home/components/FeedPoster.jsx`

```jsx
import React, { useMemo } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { hueForId } from '@/utils/media';

/**
 * Whatever covers the player before the first decoded frame arrives.
 * Never black: a real cover if we have one, otherwise a stable per-video
 * gradient with the creator's avatar centred.
 */
const FeedPoster = ({ posterUri, avatarUri, videoId, visible }) => {
    const colors = useMemo(() => {
        const h = hueForId(videoId);
        return [`hsl(${h}, 45%, 22%)`, `hsl(${(h + 40) % 360}, 40%, 10%)`];
    }, [videoId]);

    if (!visible) return null;

    if (posterUri) {
        return (
            <Image
                source={{ uri: posterUri }}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
                fadeDuration={0}
            />
        );
    }

    return (
        <LinearGradient colors={colors} style={[StyleSheet.absoluteFill, styles.center]}>
            {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.avatar} />
            ) : null}
        </LinearGradient>
    );
};

const styles = StyleSheet.create({
    center: { alignItems: 'center', justifyContent: 'center' },
    avatar: { width: 78, height: 78, borderRadius: 39, opacity: 0.35 },
});

export default React.memo(FeedPoster);
```

`expo-linear-gradient@~15.0.8` is already a dependency
([package.json:28](newboostraapp/package.json#L28)) — no install needed.

### 6.6 `src/screens/home/components/FeedPostItem.jsx`

**(a) Delete the entire poster effect** (lines 426-452) and the `posterUri` state. Replace
with a derived value:

```js
const posterUri = useMemo(() => toPosterUrl(item.thumbnailUrl), [item.thumbnailUrl]);
```

Remove `import * as VideoThumbnails from 'expo-video-thumbnails';` (line 24) — it is no
longer used in this file.

`handleOpenEdit` (line 106) reads `posterUri` — that still works, it is just a `useMemo`
now instead of state.

**(b) Replace the overlay `<Image>`** (lines 487-493):

```jsx
<FeedPoster
    visible={!isVideoLoaded || !isPlaying}
    posterUri={posterUri}
    avatarUri={item.userAvatar}
    videoId={item.id}
/>
```

**(c) Fix the edit-cover upload** (line 146):

```diff
-                const thumbUpload = await uploadService.uploadFile(newThumbnailFile, 'profile_image');
+                const thumbUpload = await uploadService.uploadThumbnail(newThumbnailFile);
                 if (thumbUpload.success) {
-                    uploadedThumbnailUrl = thumbUpload.data?.url || thumbUpload.data?.fileUrl;
+                    uploadedThumbnailUrl = thumbUpload.url;
+                    uploadedThumbnailKey = thumbUpload.key;
                 } else {
                     throw new Error('Failed to upload new cover image');
                 }
```

and include the key in the patch:

```diff
             if (uploadedThumbnailUrl) {
                 updatePayload.thumbnailUrl = uploadedThumbnailUrl;
+                if (uploadedThumbnailKey) updatePayload.thumbnailKey = uploadedThumbnailKey;
             }
```

### 6.7 `src/screens/home/screens/HomeScreen.jsx`

**(a)** Delete the local `S3_BASE_URL` (line 182) and `resolveThumbnail` (183-193); import
from `@/utils/media` instead:

```diff
-                        videoUrl: video.rawVideoKey ? `${S3_BASE_URL}${video.rawVideoKey}` : null,
-                        thumbnailUrl: resolveThumbnail(video.thumbnailUrl),
+                        videoUrl: toMediaUrl(video.rawVideoKey),
+                        thumbnailUrl: toPosterUrl(video.thumbnailUrl),
```

**(b)** Prefetch the next two posters when the active index moves. Add to `commitIndex`
(from iteration 1 §5.3(d)), after `setLastScrollIndex(idx)`:

```js
    // Posters are ~100–300 KB; warming the next two costs nothing and removes
    // the gradient flash on the following swipes.
    for (let i = 1; i <= 2; i++) {
        const next = list[idx + i];
        if (next?.thumbnailUrl) Image.prefetch(next.thumbnailUrl).catch(() => {});
    }
```

Add `Image` to the `react-native` import on line 2.

### 6.8 `src/app/video/[id].jsx`

Fix the unguarded mapper (D-24) at lines 33-36:

```diff
-  videoUrl: (v.videoUrl && v.videoUrl.startsWith('http'))
-    ? v.videoUrl
-    : `https://boostme-storage.s3.eu-north-1.amazonaws.com/${v.rawVideoKey || v.videoUrl}`,
-  thumbnailUrl: v.thumbnailUrl || v.thumbnail,
+  videoUrl: toMediaUrl(v.videoUrl || v.rawVideoKey),
+  thumbnailUrl: toPosterUrl(v.thumbnailUrl || v.thumbnail),
```

### 6.9 Frontend files touched

```
newboostraapp/src/utils/media.js                              (new)
newboostraapp/src/screens/home/components/FeedPoster.jsx      (new)
newboostraapp/src/config/api.config.js                        (+2 endpoints)
newboostraapp/src/services/uploadService.js                   (+uploadThumbnail, uploadFile signature)
newboostraapp/src/screens/home/screens/UploadScreen.jsx       (thumbnail block rewritten, picker capped)
newboostraapp/src/screens/home/components/FeedPostItem.jsx    (poster effect deleted, FeedPoster, edit fix)
newboostraapp/src/screens/home/screens/HomeScreen.jsx         (media utils, poster prefetch)
newboostraapp/src/app/video/[id].jsx                          (mapper guarded)
```

---

## 7. Caching / preloading / buffering / autoplay / pagination / API / delivery / performance

| Area | Change |
|---|---|
| **Caching** | `Cache-Control: public, max-age=31536000, immutable` now set on every newly uploaded object (images *and* videos). Nothing consumes it yet at the edge — that is iteration 5 — but the device HTTP cache and RN's `Image` cache both honour it immediately, so a re-watched video and a re-seen poster stop re-downloading within a session. |
| **Preloading** | Poster images for the next two items are prefetched with `Image.prefetch`. Video preloading is **not** added here. |
| **Buffering** | Materially improved by subtraction: deleting the remote `getThumbnailAsync` (D-21) removes a full concurrent download of the same MP4 the active player is trying to buffer. |
| **Autoplay** | Unchanged from iteration 1. |
| **Pagination** | Unchanged. |
| **API** | One new endpoint (`POST /upload/thumbnail`). `POST /videos` and `PATCH /videos/:id` accept two changed/new optional fields. `GET /feed/*` response shape is unchanged. |
| **Video delivery** | Unchanged host and protocol. Objects now carry cache headers. |
| **Performance** | Fewer concurrent connections per active item (2 → 1). `FeedPoster` is memoised and the poster is now a `useMemo` derivation rather than an async state write, removing one render per item mount. |

---

## 8. Expected behaviour after this iteration

1. Publishing a video uploads its cover to `thumbnails/{userId}/…` and returns **200**.
2. The published video's `thumbnailUrl` in Mongo is an image URL under `thumbnails/`, with
   no `X-Amz-Signature` query, and it still resolves a week later.
3. In the feed, a video with a cover shows that cover the moment the item is on screen and
   holds it until the first decoded frame — no black gap.
4. A video with no cover (old rows, and any codec the device could not decode) shows a
   stable coloured gradient with a faded creator avatar. Never black.
5. Swiping forward shows the next item's cover instantly, because it was prefetched.
6. Changing a video's cover from the feed's ⋯ → Edit flow actually changes it.
7. Profile avatars uploaded from now on no longer disappear after 24 hours.
8. `/video/[id]` shows the same poster as the feed for the same video.
9. The active item pulls bytes for exactly one thing — the video.

**Still broken, by design:**
- Old videos remain coverless (there is no server-side frame extractor until iteration 5).
- Nothing is prefetched *for playback*. → Iteration 4.
- Playback still originates from Stockholm. → Iteration 5.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **The bucket does not serve `thumbnails/*` publicly**, so every new cover 403s | Medium | §5.0.2 pre-flight check. If (2) returns 403, fix the bucket policy (§5.0.3) before deploying §5.2. This is the single most likely way this iteration ships broken. |
| **Editing the live bucket policy narrows an existing grant** and breaks video playback for every user at once | Low-**Severe** | Copy the current policy to a local file first. Extend the existing statement's `Resource` array; never paste a replacement policy. Re-run 5.0.2 curl (1) immediately after saving — it must still be 200. |
| **IAM cannot write `thumbnails/*`**, so the new endpoint 400s with an S3 `Access Denied` that looks like a code bug | Medium | §5.0.5. The read-side curl checks do not cover this. T-2.2b catches it. |
| **`AWS_REGION` unset**, so `getPublicUrl` writes `us-east-1` hosts into Mongo permanently | Low-**High impact** | §5.0.6, checked by T-2.4b before any real publishing. Silent today because `getPublicUrl` is dead code. |
| Production rows stay poisoned because the repair script is gated (§5.5) | **Certain, accepted** | `toPosterUrl` rejects video URLs client-side and `FeedPoster` renders a gradient, so old items look coverless rather than broken. T-2.9 verifies this against real unrepaired data. |
| **Ordering:** the app build ships before the backend, so `thumbnailKey` triggers `forbidNonWhitelisted` → every publish 400s | Medium-High | Deploy backend first, verify `POST /upload/thumbnail` with curl, *then* ship the app. Stated again in the test plan as T-2.0. |
| The repair script clears covers that were actually fine | Low | `--dry` run first; the Case A regex only matches paths ending in a video extension. Take a Mongo backup. |
| Making `thumbnailUrl` non-required breaks a consumer that assumes it is present | Low | Grep: `grep -rn "thumbnailUrl" boost-backend/src`. Known readers are the feed mappers, `getProfileVideos`' `.select`, and the boost screen's route params — all tolerate `''`. Verify the profile grid renders coverless items without crashing (T-2.9). |
| `expo-linear-gradient` adds a native view per item and costs frames | Low | It renders only while `!isVideoLoaded || !isPlaying`, i.e. briefly, and only for coverless items. Measure in T-2.11 against iteration 1's recorded frame rate. |
| `Image.prefetch` on Android holds decoded bitmaps and grows memory during long scrolls | Low-Medium | Only 2 items ahead, only poster-sized JPEGs. Watch memory in T-2.12; if it grows, drop the prefetch — it is an optimisation, not a fix. |
| Deleting `expo-video-thumbnails` from `FeedPostItem` breaks something else | Low | It stays a dependency (`UploadScreen` still uses it against local files). Only the import in `FeedPostItem` is removed. |

---

## 10. Test plan

### Phase A — backend, before touching the app

| # | Test | How | Pass |
|---|---|---|---|
| T-2.0 | **Deploy order** | Deploy backend. Do not ship the app yet. | Backend live, app still on the old build and still working. |
| T-2.1 | **Bucket is public for images** | §5.0 curl commands | Both return `HTTP/1.1 200`. |
| T-2.2 | **New endpoint accepts a JPEG** | `curl -X POST -H "Authorization: Bearer $TOK" -F "file=@cover.jpg" $API/upload/thumbnail` | `200`, body `{ success: true, url, key }`, `key` starts with `thumbnails/`. |
| T-2.3 | **New endpoint rejects a video** | Same curl with `-F "file=@clip.mp4"` | `400 Only image files allowed`. |
| T-2.4 | **Returned URL is public and permanent** | `curl -sI "$url"` | `200`, `Cache-Control: public, max-age=31536000, immutable`, and the URL contains **no** `X-Amz-Signature`. |
| T-2.5 | **`POST /videos` accepts the new fields** | `curl -X POST $API/videos -d '{"title":"t","rawVideoKey":"videos/x.mp4","thumbnailUrl":"","thumbnailKey":"thumbnails/x.jpg","duration":10}'` | `201`. Then the same call with `thumbnailUrl` omitted entirely → also `201`. |
| T-2.6 | **`POST /videos` still rejects junk** | Same call plus `"bogusField": 1` | `400` — confirms `forbidNonWhitelisted` is still active and you did not weaken validation. |
| T-2.2b | **IAM can write the new prefix** | The T-2.2 curl, then `aws s3api head-object --bucket boostme-storage --key <the returned key>` | Object exists. A `400 … Access Denied` from T-2.2 instead means §5.0.5 was skipped. |
| T-2.4b | **Public URL region is right** | Read the `url` returned by T-2.2 | Host is `…s3.eu-north-1.amazonaws.com`. `us-east-1` means `AWS_REGION` is unset (§5.0.6) — **stop and fix before any further publishing**, those URLs persist to Mongo. |

**Deferred — dev environment only (§5.5 gate).** T-2.7 and T-2.8 do **not** run in this
iteration. They run in the Render dev environment once it exists, and against production
only as a separate, separately-decided release step with a fresh `mongodump` in hand.

| # | Test | How | Pass |
|---|---|---|---|
| T-2.7 | **Repair dry run** *(dev env)* | `node scripts/repair-thumbnails.js --dry` | Prints counts. `cleared` ≈ the number of app-uploaded videos. Read them before proceeding. |
| T-2.8 | **Repair applied** *(dev env)* | Mongo backup, then run without `--dry`, then re-run `--dry` | Second dry run reports `cleared: 0, converted: 0`. Idempotent. |

### Phase B — app

Same device matrix as iteration 1. Release bundle for the performance tests.

| # | Test | Steps | Pass |
|---|---|---|---|
| T-2.9 | **Coverless feed renders** | Before uploading anything new, scroll 12 items | Every item shows a gradient + faded avatar. **Zero black frames.** No crash on the profile grid either. Note this now also exercises the *unrepaired* production rows — `toPosterUrl` must reject their `.mp4` values client-side. That is the point: the fix must not depend on the repair having run. |
| T-2.10 | **Stable placeholder** | Note the gradient colour of item 3. Scroll away 6 items and back. | Identical colour. |
| T-2.11 | **Publish end-to-end (auto frame)** | Upload a video, leave the cover mode on "Video Frame", publish | Success. In Mongo, `thumbnailUrl` starts with `.../thumbnails/`, has no query string, and `thumbnailKey` is set. |
| T-2.12 | **Publish end-to-end (custom image)** | Upload a video, pick a custom photo, publish | Same as T-2.11; the cover in the feed is the chosen photo. |
| T-2.13 | **Publish with an undecodable video** | Upload a file whose frame extraction fails (or temporarily force `localCoverUri = null`) | Publish **succeeds**. `thumbnailUrl` is `''`. The item shows the gradient. **Not** an mp4 URL. |
| T-2.14 | **Cover shows before playback** | Cold-launch, watch item 0 frame by frame in a screen recording | A cover (or gradient) is visible from the first frame the item is on screen. No black interval ≥ 1 frame. |
| T-2.15 | **Cover on swipe** | 20 swipes, screen recording | On every swipe, a cover/gradient is visible from the first frame. **0/20** black gaps. |
| T-2.16 | **Poster prefetch works** | Airplane-mode trick: load the feed, then enable airplane mode, then swipe forward 2 | Items +1 and +2 still show their covers (served from the image cache). Item +3 shows the gradient. |
| T-2.17 | **Cover persists past 24 h** | Note a `thumbnailUrl` from T-2.11. Re-curl it 25+ hours later. | `200`. (Run this asynchronously; do not block the iteration on it, but do check it.) |
| T-2.18 | **Edit cover from the feed** | ⋯ → Edit Video Details → Change Cover Photo → Save. Pull-to-refresh the feed. | New cover appears. `thumbnailUrl`/`thumbnailKey` updated in Mongo. (Note: it may not update *in place* without a refresh — see the `item` mutation caveat in iteration 1 §9.) |
| T-2.19 | **`/video/[id]` parity** | Open the same video from a profile grid | Same cover as the feed. No `<Image>` handed an mp4 URL (check for a broken-image render). |
| T-2.20 | **Avatar permanence** | Change your profile picture. Note `user.profileImage` in Mongo. | No `X-Amz-Signature` in the value. `curl -sI` returns 200. |
| T-2.21 | **One connection per active item** | Charles/mitmproxy or `adb logcat` network trace while item 3 is focused | Exactly **one** request to `boostme-storage` for `videos/…`. **Zero** additional requests for the same key. Baseline was two. |
| T-2.22 | **No frame-rate regression** | Release bundle, 15 s continuous flick, compare to the number recorded in iteration 1 T-1.17 | Within 5 % of the iteration-1 figure, or better. |
| T-2.23 | **Memory during a long scroll** | Android Studio profiler, scroll 60 items | Heap plateaus. No monotonic climb attributable to prefetched bitmaps. |
| T-2.24 | **No iteration-1 regressions** | Re-run T-1.2, T-1.3, T-1.5 | Same results as iteration 1. |

---

## 11. Success criteria

- [ ] §5.0.9 checklist fully ticked — bucket policy, Block Public Access, IAM, `AWS_REGION`.
- [ ] `POST /upload/thumbnail` returns 200 for images and 400 for videos (T-2.2, T-2.3).
- [ ] The returned `key` starts with `thumbnails/` and the object is really there (T-2.2b).
- [ ] Every URL returned by an image upload is public, cacheable and signature-free (T-2.4),
      and its host region is `eu-north-1` (T-2.4b).
- [ ] **No new row** written from now on carries a video URL in `thumbnailUrl` — verified by
      T-2.11/T-2.12/T-2.13 on the three fresh uploads, not by a collection scan.

**Deferred to the dev environment (§5.5 gate)** — these are *not* gates on shipping this
iteration, because the repair script does not run against production yet:

- [ ] The repair script is idempotent and its second dry run reports zero changes (T-2.8).
- [ ] **Zero rows** in `videos` where `thumbnailUrl` matches `/\.(mp4|mov|webm|avi)(\?|$)/i`:
      `db.videos.countDocuments({ thumbnailUrl: /\.(mp4|mov|webm|avi)(\?|$)/i }) === 0`
- [ ] **Zero rows** where `thumbnailUrl` contains `X-Amz-Signature`.

Until then the equivalent guarantee is enforced **client-side** by `toPosterUrl` (§6.2), and
T-2.9 is what proves it holds against real unrepaired production data.
- [ ] **0/20 black gaps** across 20 swipes in a frame-by-frame screen recording (T-2.15). This is the headline number for this iteration.
- [ ] **0 black frames** on cold launch before the first video (T-2.14).
- [ ] Three consecutive fresh uploads all land a real cover under `thumbnails/` (T-2.11, T-2.12, plus one more).
- [ ] An upload whose frame extraction fails still publishes, with `thumbnailUrl: ''` (T-2.13).
- [ ] Network trace shows **exactly one** request per video key for the active item (T-2.21).
- [ ] `grep -rn "boostme-storage.s3" newboostraapp/src` returns **only** `src/utils/media.js`.
- [ ] `grep -rn "getThumbnailAsync" newboostraapp/src` returns **only** `UploadScreen.jsx`, and every occurrence there takes a `file://` URI.
- [ ] `grep -rn "upload.data.url" newboostraapp/src` returns nothing.
- [ ] Frame rate within 5 % of iteration 1's recorded figure (T-2.22).
- [ ] Iteration 1's T-1.2/T-1.3/T-1.5 still pass (T-2.24).
