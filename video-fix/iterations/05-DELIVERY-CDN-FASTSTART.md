# Iteration 5 — Delivery: CDN, Cache Headers, Faststart & Server-Side Covers

**Scope:** backend + AWS infrastructure + a small frontend change (Phase D only).
**Closes:** D-23 (backfill), D-43, D-44 (partially), D-45, D-46, D-47, D-49.
**Depends on:** Iteration 3 — `MediaUrlService` and server-authored `videoUrl` are the
mechanism that makes Phase A a one-variable change instead of an app release.
**Also depends on: the Render dev environment existing.** This is the most
production-invasive iteration in the plan — see the gate below.

> ### ⚠️ Gated by [Constraint #9](video-fix/iterations/00-OVERVIEW.md) — the app is live
>
> Three things in this iteration mutate production and are **blocked until the dev
> environment exists and each has been rehearsed there**:
>
> | What | Phase | Why it is dangerous |
> |---|---|---|
> | `backfill-cache-control.js` | B | `CopyObjectCommand` rewrites **every existing object**. Get `ContentType` wrong and you turn videos into `application/octet-stream`, which some players refuse — see the warning in §5.B. |
> | **OAC cutover — bucket goes private** | A | This is the one AWS change in the whole plan that is **not additive**. It removes public read. Every already-installed app build that composes an `s3.eu-north-1` URL directly stops playing the instant it lands. T-5.5 exists for exactly this. |
> | `enqueue-optimize-backlog.js` | C | Transcodes and rewrites video rows in bulk, under Render's 5-attempt retry policy. |
>
> Phase A's CloudFront distribution itself is safe to **create** on prod — a distribution
> that nothing points at costs nothing and changes nothing. Creating it, and pointing
> `AWS_CLOUDFRONT_DOMAIN` at it in a **dev** backend, is a legitimate way to rehearse the
> whole phase. It is the *cutover* — flipping prod's env var, then locking the bucket — that
> is gated.
>
> Order of operations once the dev env exists: rehearse everything there → Phase A cutover
> on prod with the bucket **still public** → soak 24 h (T-5.5 must pass on old builds) →
> only then OAC.

> This iteration has four phases. **Ship and verify them in order.** Each has its own
> success criteria. Phase A alone is the single largest latency win in this entire plan for
> any user outside Northern Europe, and it involves no code change at all beyond setting an
> environment variable.

| Phase | What | Code change | Risk |
|---|---|---|---|
| **A** | CloudFront in front of the bucket | env var only | Low |
| **B** | `Cache-Control` backfill on existing objects | one script | Low |
| **C** | Faststart remux + server-side cover extraction, as a queued job | new module + worker | Medium |
| **D** | Direct-to-S3 upload (bypass Render) | backend + frontend | Medium |

---

## 1. Objective

Move the bytes closer to the viewer and make them usable sooner.

- **Closer:** every media request terminates at a CloudFront edge instead of at
  `s3.eu-north-1.amazonaws.com`. For a viewer in São Paulo that is ~30 ms instead of ~230 ms
  of RTT, and a cache hit instead of a trans-Atlantic transfer.
- **Sooner:** every video gets `-movflags +faststart` so its `moov` atom is at the front of
  the file, which means a progressive player can start decoding from the first bytes
  instead of range-requesting the tail first.
- **Cheaper:** `Cache-Control: immutable` on every object means the edge actually holds
  them, and a re-watch never reaches S3 at all.
- **And:** every video finally gets a real cover image, including the ones iteration 2's
  repair script had to blank.

---

## 2. Problems addressed

### 2.1 There is no CDN, and the placeholder proves it was intended (D-43, D-46)

```
# boost-backend/.env
AWS_REGION=eu-north-1
AWS_S3_BUCKET=boostme-storage
AWS_CLOUDFRONT_DOMAIN=REPLACE_WITH_CLOUDFRONT_DOMAIN
```

`ENV.AWS_CLOUDFRONT_DOMAIN` exists as a getter
([env.ts:89-91](boost-backend/src/config/env.ts#L89-L91)) and — before iteration 3 — was
read by nothing. Every playback is `device → S3 Stockholm`, direct, for every viewer, on
every play and every re-watch. There is no edge, no regional cache, and no shielding: a
video that goes mildly viral is N full transfers out of one bucket in one region.

S3 does support `Accept-Ranges: bytes`, so range requests already work at the storage
layer. That is genuinely not the missing piece. The missing piece is distance and caching.

### 2.2 No `Cache-Control` on anything uploaded before iteration 2 (D-23)

Iteration 2 added `CacheControl: public, max-age=31536000, immutable` to
`PutObjectCommand`, but only for **new** uploads. Every object already in the bucket has no
cache header, so CloudFront will apply its default TTL and revalidate far more often than
it needs to for content that is immutable by construction (every key contains a uuid).

### 2.3 No transcode, no faststart, and `processingStatus` is a lie (D-44, D-45)

Verified by grep across `boost-backend`: no `ffmpeg`, no `fluent-ffmpeg`, no HLS packager,
no worker. `VideoService.create` writes:

```ts
// video.service.ts:53-54
processingStatus: VideoProcessingStatus.READY,
processingProgress: 100,
```

immediately, at record creation, before anything has been processed — because nothing ever
processes. `manifestUrl`, `processedVideoKey`, `chunks: VideoChunk[]`
([video.schema.ts:70-78](boost-backend/src/database/schemas/video/video.schema.ts#L70-L78))
and `VIDEO_QUALITIES=360p,720p,1080p` / `VIDEO_CHUNK_DURATION=4` in `.env` are scaffolding
for a pipeline that was never built.

The practical consequence for the feed, right now: an MP4 recorded on a phone and written
by the OS's muxer usually has its `moov` atom at the **end** of the file. A progressive
HTTP player has to fetch that atom before it can decode anything, which on a large file
means an extra round-trip and a range request into the tail before the first frame. That is
a fixed, per-video, per-viewer penalty that `-movflags +faststart` removes permanently for
the cost of one metadata rewrite — no re-encoding, no quality loss.

`ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 })`
([UploadScreen.jsx:57-60](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L57-L60))
means the source can be a 4K 60 fps original — iteration 2 capped this to `quality: 0.8`
and 180 s, but that is a client-side hint, not a guarantee (D-49).

### 2.4 500 MB uploads traverse the API instance (D-47)

[upload.controller.ts:107-136](boost-backend/src/modules/upload/upload.controller.ts#L107-L136)
buffers the whole file to `/tmp` on the Render instance via
`diskStorage({ destination: '/tmp' })`, then
[upload.service.ts:208](boost-backend/src/modules/upload/upload.service.ts#L208) streams it
to S3. So every upload occupies an API worker, its disk and its bandwidth for the entire
duration, and a handful of concurrent uploads can fill `/tmp` or exhaust the instance. It
also doubles the wall-clock upload time from the user's perspective (phone→Render, then
Render→S3).

---

## Phase A — CloudFront

### 3.A Approach

Put a CloudFront distribution in front of the existing bucket, leave the bucket public for
now, and set `AWS_CLOUDFRONT_DOMAIN`. Because iteration 3 moved URL composition into
`MediaUrlService`, that variable is the entire change: every `videoUrl` and `thumbnailUrl`
the API emits moves to the edge on the next request, including for the app builds already
installed on phones.

### 4.A Why

**Why not lock the bucket behind Origin Access Control immediately.** Every app build
shipped before iteration 3 composes `https://boostme-storage.s3.eu-north-1.amazonaws.com/{key}`
on the client ([HomeScreen.jsx:182](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L182)).
Making the bucket private breaks all of them instantly. Run public-origin + CDN until the
old builds are below your support threshold, then cut over. The security posture is
unchanged in the meantime — the bucket is already public.

**Why CloudFront rather than a cheaper generic CDN.** The origin is S3 in the same account;
CloudFront's S3 origin integration handles range requests, partial-object caching and OAC
natively, and you are already paying for the bucket. This is not a considered vendor
comparison so much as the path of least new configuration.

### 5.A Exact changes

**AWS Console / IaC — create the distribution:**

| Setting | Value | Why |
|---|---|---|
| Origin domain | `boostme-storage.s3.eu-north-1.amazonaws.com` | Use the **REST** endpoint, not the website endpoint — the website endpoint does not support range requests properly. |
| Origin access | Public (for now) | See §4.A. Switch to OAC in the cutover step below. |
| Viewer protocol policy | Redirect HTTP → HTTPS | |
| Allowed methods | `GET, HEAD` | Nothing writes through the CDN. |
| Cache policy | `Managed-CachingOptimized` | Honours origin `Cache-Control`; no cookies/query in the key. |
| Origin request policy | `Managed-CORS-S3Origin` | Forwards `Origin`/`Access-Control-*` only. |
| Compress objects automatically | **Off** | MP4 and JPEG are already compressed; gzipping them wastes edge CPU. |
| Price class | Choose by audience | If viewers are global, use All Edge Locations; if EU/NA only, Price Class 100 halves the cost. |
| Default root object | *(empty)* | |
| Smooth streaming | Off | Not applicable to progressive MP4. |

Range requests need no configuration — CloudFront supports them on the S3 REST origin by
default, and this is what makes seeking and progressive start work.

**Backend — set the variable and nothing else:**

```diff
-AWS_CLOUDFRONT_DOMAIN=REPLACE_WITH_CLOUDFRONT_DOMAIN
+AWS_CLOUDFRONT_DOMAIN=d1234abcdefgh.cloudfront.net
```

Set it in Render's environment for the service, then restart. `MediaUrlService`
(iteration 3 §5.2) already:

- strips a leading scheme and trailing slashes, so `d123.cloudfront.net`,
  `https://d123.cloudfront.net` and `https://d123.cloudfront.net/` all work;
- **rewrites absolute S3 URLs stored in old rows onto the new host**, so `thumbnailUrl`
  values written before iteration 3 also move to the edge with no data migration.

That last property is why iteration 3 built `toUrl` to accept absolute URLs rather than
only keys. Verify it with T-5.3.

**Optional but recommended — a custom domain.** Point `media.boostra.app` (or similar) at
the distribution with an ACM certificate in `us-east-1`. It decouples you from the
CloudFront hostname permanently. `MediaUrlService` needs no change.

### 10.A Test plan — Phase A

| # | Test | How | Pass |
|---|---|---|---|
| T-5.1 | **Edge serves the object** | `curl -sI "https://$CF/videos/<key>"` | `200`. `x-cache: Miss from cloudfront` on the first call, `Hit from cloudfront` on the second. |
| T-5.2 | **Range requests work** | `curl -sI -H "Range: bytes=0-1023" "https://$CF/videos/<key>"` | `206 Partial Content`, `Content-Range` present, `Content-Length: 1024`. **If this is not 206, playback will be broken — stop and fix the origin configuration.** |
| T-5.3 | **API emits CDN URLs, including for legacy rows** | `curl "$API/feed/global?limit=20" \| jq -r '.docs[].videoUrl, .docs[].thumbnailUrl' \| sort -u` | Every non-null value's host is the CloudFront domain. Zero `s3.eu-north-1` hosts, including on rows whose `thumbnailUrl` was stored absolute. |
| T-5.4 | **Latency from a distant region** | From a non-EU host (a cheap VM, or a VPN): `curl -w '%{time_starttransfer}' -o /dev/null -s` against the S3 URL and then the CF URL, 5 runs each | CF median at least **50 %** lower than S3 on a warm edge. |
| T-5.5 | **Old app build still works** | Install the pre-iteration-3 build, scroll the feed | Plays. (It composes S3 URLs itself and the bucket is still public — this is the compatibility guarantee.) |
| T-5.6 | **New app build plays from the edge** | Current build; proxy trace while scrolling 20 items | Every media request goes to the CloudFront host. Zero to S3. |
| T-5.7 | **Cache hit ratio** | CloudFront console, after ~30 min of normal use | Non-trivial hit ratio. Note it; Phase B should raise it. |
| T-5.8 | **Re-watch is an edge hit** | Watch a video, clear the app's disk cache, watch again, check `x-cache` in the proxy | `Hit from cloudfront`. |

### 11.A Success criteria — Phase A

- [ ] Range request returns **206** (T-5.2). Non-negotiable.
- [ ] **Zero** `s3.eu-north-1` hosts in the feed response (T-5.3).
- [ ] ≥ **50 %** TTFB reduction from a distant region (T-5.4).
- [ ] Pre-iteration-3 app builds still play (T-5.5).
- [ ] No increase in playback failures over 24 h of production traffic.

---

## Phase B — Cache-Control backfill

> **🚫 Dev environment only until rehearsed.** This script rewrites the metadata of every
> object in the production bucket. Write it now; run it against a dev bucket (or a
> `--prefix` covering only objects you uploaded during testing) first, confirm `ContentType`
> survives the copy on a real video *and* a real JPEG, and only then schedule it against
> prod as its own release step. See the gate at the top of this file.
>
> **What deferring costs:** objects uploaded before iteration 2 keep no `Cache-Control`, so
> CloudFront applies its default TTL to them instead of the one-year immutable TTL. Phase A
> still works and still wins; those objects are just re-validated more often. This is an
> optimisation lagging behind, not a broken state.

### 5.B Exact changes

`boost-backend/scripts/backfill-cache-control.js`:

```js
/**
 * Sets Cache-Control on every object already in the bucket.
 * Keys contain a uuid, so objects are immutable — a one-year immutable TTL is safe.
 *
 *   node scripts/backfill-cache-control.js --dry
 *   node scripts/backfill-cache-control.js --prefix videos/
 */
const { S3Client, ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand } =
  require('@aws-sdk/client-s3');
require('dotenv').config();

const DRY = process.argv.includes('--dry');
const prefixArg = process.argv.find(a => a.startsWith('--prefix='));
const Prefix = prefixArg ? prefixArg.split('=')[1] : undefined;

const Bucket = process.env.AWS_S3_BUCKET;
const CACHE = 'public, max-age=31536000, immutable';

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

(async () => {
  let ContinuationToken, scanned = 0, updated = 0, skipped = 0;

  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const obj of page.Contents || []) {
      scanned++;
      const head = await s3.send(new HeadObjectCommand({ Bucket, Key: obj.Key }));
      if (head.CacheControl === CACHE) { skipped++; continue; }

      if (!DRY) {
        await s3.send(new CopyObjectCommand({
          Bucket,
          Key: obj.Key,
          CopySource: `${Bucket}/${encodeURIComponent(obj.Key)}`,
          MetadataDirective: 'REPLACE',
          CacheControl: CACHE,
          ContentType: head.ContentType,     // CopyObject with REPLACE drops it otherwise
          Metadata: head.Metadata,
        }));
      }
      updated++;
      if (updated % 100 === 0) console.log(`  … ${updated} updated`);
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);

  console.log({ DRY, scanned, updated, skipped });
})();
```

> `MetadataDirective: 'REPLACE'` **discards** `ContentType` and user metadata unless you
> re-supply them — hence the `HeadObjectCommand` per object. Getting this wrong turns every
> video into `application/octet-stream`, which some players refuse. Run `--dry` first,
> then run with `--prefix=thumbnails/` and verify a single object before doing `videos/`.

After the backfill, invalidate the edge so it re-reads the headers:

```bash
aws cloudfront create-invalidation --distribution-id $DIST --paths '/*'
```

### 10.B Test plan — Phase B

| # | Test | Pass |
|---|---|---|
| T-5.9 | `--dry` run reports a sane `scanned`/`updated` split | Yes, and `skipped` covers objects uploaded after iteration 2. |
| T-5.10 | Single-object spot check after a `--prefix=thumbnails/` run: `aws s3api head-object` | `CacheControl` set **and** `ContentType` still `image/jpeg`. |
| T-5.11 | Full run, then `head-object` on 5 random video keys | `CacheControl` set, `ContentType` still `video/mp4`. |
| T-5.12 | `curl -sI "https://$CF/videos/<key>"` after invalidation | `cache-control: public, max-age=31536000, immutable`. |
| T-5.13 | Playback smoke test, 20 items | All play. **If `ContentType` was clobbered this is where you find out.** |
| T-5.14 | Script is idempotent — re-run `--dry` | `updated: 0`. |

### 11.B Success criteria — Phase B

- [ ] `ContentType` preserved on 100 % of spot-checked objects (T-5.10, T-5.11).
- [ ] Edge serves the immutable header (T-5.12).
- [ ] Script idempotent (T-5.14).
- [ ] CloudFront cache hit ratio measurably higher than the Phase A figure (T-5.7) after 24 h.

---

## Phase C — Faststart remux + server-side covers

### 3.C Approach

Add a `video-processing` BullMQ queue with one job type, `optimize`, that for a given video:

1. Downloads `rawVideoKey` from S3 to a temp path.
2. Runs `ffmpeg -i in -c copy -movflags +faststart out` — a **container rewrite, not a
   re-encode**. No decode, no quality loss, seconds of CPU even for a large file.
3. Optionally, when the source exceeds a resolution/bitrate threshold, runs a real 720p
   H.264 transcode instead.
4. Extracts a cover frame at 1 s with `ffmpeg -ss 1 -frames:v 1`.
5. Uploads both to S3 (`videos/{userId}/optimized/...`, `thumbnails/{userId}/...`).
6. Writes `processedVideoKey`, `thumbnailKey`/`thumbnailUrl` and `optimizationStatus` back
   to the document.

The feed prefers `processedVideoKey` over `rawVideoKey` when it exists.

### 4.C Why

**Why keep `processingStatus: READY` at creation instead of making processing gate
visibility.** The obvious design — set `PROCESSING`, flip to `READY` when the job finishes —
means that if the worker is down, misconfigured, or the Redis connection drops, **every
upload silently disappears from the feed**. That is a far worse failure than a slightly
slower first frame. Making optimization purely **additive** (`processedVideoKey` is used
when present, `rawVideoKey` otherwise) means a total worker outage degrades exactly to
today's behaviour, which is known to work. This is the single most important design
decision in this phase.

**Why remux before transcode.** `-c copy -movflags +faststart` gets most of the
start-latency benefit for a tiny fraction of the cost, cannot degrade quality, and cannot
fail on an unusual codec in a way that loses the file (the original is never deleted).
Transcoding is a second, gated step for genuinely oversized sources.

**Why a queue rather than doing it inline in the upload request.** ffmpeg on a 200 MB file
holds CPU and disk for tens of seconds. Doing that inside an HTTP handler on a Render web
instance blocks a worker, risks the platform's request timeout, and makes upload latency
unpredictable. `BullModule.forRootAsync` is **already configured**
([app.module.ts:56-91](boost-backend/src/app.module.ts#L56-L91)) — it just points at
`REDIS_HOST=REPLACE_WITH_REDIS_HOST`. Provisioning Redis is the missing piece, not the
queue infrastructure.

**Why ffmpeg-static.** Render's Node runtime has no system ffmpeg and no apt access on the
standard build. `ffmpeg-static` ships a prebuilt Linux x64 binary as an npm dependency, and
`fluent-ffmpeg` points at it via `setFfmpegPath`. Verify the binary is executable in the
deployed container before wiring anything up (T-5.15) — this is the most common way this
phase fails on day one.

### 5.C Exact changes

**Provision Redis.** Upstash (free tier is adequate at this scale) or Render Key Value.
Set in the Render environment:

```
REDIS_HOST=<host>
REDIS_PORT=<port>
REDIS_PASSWORD=<password>
BULL_REDIS_HOST=<host>
BULL_REDIS_PORT=<port>
```

`BullModule.forRootAsync` already reads all of these
([app.module.ts:62-72](boost-backend/src/app.module.ts#L62-L72)). Note it uses
`@nestjs/bull` (Bull v3), not `@nestjs/bullmq` — match that API when writing the processor.

**Dependencies:**

```bash
npm i fluent-ffmpeg ffmpeg-static
npm i -D @types/fluent-ffmpeg
```

**Schema — `video.schema.ts`:**

```ts
export enum VideoOptimizationStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  DONE = 'done',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

  @Prop({
    type: String,
    enum: VideoOptimizationStatus,
    default: VideoOptimizationStatus.PENDING,
    index: true,
  })
  optimizationStatus: VideoOptimizationStatus;

  @Prop()
  optimizationError?: string;
```

`processedVideoKey` already exists (line 70-71) — this phase is the first thing to write it.
Leave `processingStatus`, `manifestUrl` and `chunks` alone; `manifestUrl`/`chunks` become
real in iteration 6.

**New module — `src/modules/video-processing/`:**

```
video-processing.module.ts     registers BullModule.registerQueue({ name: 'video-processing' })
video-processing.service.ts    enqueue(videoId) + the ffmpeg work
video-processing.processor.ts  @Processor('video-processing') @Process('optimize')
```

`video-processing.service.ts`, the load-bearing part:

```ts
import ffmpegPath from 'ffmpeg-static';
import * as ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);

const FASTSTART_ARGS = ['-c', 'copy', '-movflags', '+faststart'];

// Only re-encode when the source is genuinely oversized. Everything else is remuxed.
const TRANSCODE_ABOVE_HEIGHT  = 1080;
const TRANSCODE_ABOVE_BITRATE = 6_000_000; // bits/s

async optimize(videoId: string) {
  const video = await this.videoModel.findById(videoId).lean();
  if (!video?.rawVideoKey) return;

  await this.videoModel.updateOne(
    { _id: videoId },
    { $set: { optimizationStatus: VideoOptimizationStatus.RUNNING } },
  );

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vopt-'));
  const inPath   = path.join(work, 'in.mp4');
  const outPath  = path.join(work, 'out.mp4');
  const coverPath = path.join(work, 'cover.jpg');

  try {
    await this.s3.downloadToFile(video.rawVideoKey, inPath);

    const probe = await this.probe(inPath);           // ffprobe via fluent-ffmpeg
    const stream = probe.streams.find(s => s.codec_type === 'video');
    const needsTranscode =
      (stream?.height ?? 0) > TRANSCODE_ABOVE_HEIGHT ||
      Number(probe.format?.bit_rate ?? 0) > TRANSCODE_ABOVE_BITRATE ||
      stream?.codec_name !== 'h264';

    await this.run(inPath, outPath, needsTranscode
      ? [
          '-vf', "scale='min(1080,iw)':-2",
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
          '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
        ]
      : FASTSTART_ARGS);

    // A cover at 1s — or at 0 for videos shorter than that.
    const at = (Number(probe.format?.duration ?? 0) > 1.5) ? '1' : '0';
    await this.runCover(inPath, coverPath, at);

    const optimizedKey = `videos/${video.user}/optimized/${videoId}.mp4`;
    const coverKey     = `thumbnails/${video.user}/${videoId}.jpg`;

    await this.s3.putFile(optimizedKey, outPath,   'video/mp4');
    await this.s3.putFile(coverKey,     coverPath, 'image/jpeg');

    const patch: any = {
      processedVideoKey: optimizedKey,
      optimizationStatus: VideoOptimizationStatus.DONE,
      optimizationError: null,
    };
    // Never overwrite a cover the creator chose. Only fill an empty one.
    if (!video.thumbnailKey && !video.thumbnailUrl) {
      patch.thumbnailKey = coverKey;
      patch.thumbnailUrl = this.mediaUrl.toUrl(coverKey);
    }

    await this.videoModel.updateOne({ _id: videoId }, { $set: patch });
  } catch (e) {
    // The raw file is untouched and still playable. Failure is not user-visible.
    await this.videoModel.updateOne({ _id: videoId }, {
      $set: {
        optimizationStatus: VideoOptimizationStatus.FAILED,
        optimizationError: String(e?.message || e).slice(0, 500),
      },
    });
    throw e;   // let Bull retry per defaultJobOptions
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}
```

`s3.putFile` must set `CacheControl: 'public, max-age=31536000, immutable'` — same constant
as iteration 2 §5.2. Factor that into `UploadService` rather than duplicating it.

**Enqueue on create** — `video.service.ts`:

```diff
     const video = new this.videoModel({ ... });
-    return video.save();
+    const saved = await video.save();
+
+    // Fire-and-forget. The video is already READY and playable from rawVideoKey;
+    // optimization is purely additive, so a queue outage degrades to today's behaviour.
+    this.videoProcessing.enqueue(saved._id.toString()).catch((e) =>
+      console.error('[VIDEO] enqueue optimize failed', saved._id, e?.message),
+    );
+
+    return saved;
```

**Feed prefers the optimized rendition** — `feed.service.ts`'s `present()` (iteration 3 §5.5):

```diff
-      videoUrl: this.mediaUrl.toUrl(video.rawVideoKey),
+      videoUrl: this.mediaUrl.toUrl(video.processedVideoKey || video.rawVideoKey),
```

and add `processedVideoKey` to `FEED_PROJECTION`. Same in `VideoService.findOne`.

**Worker deployment.** Two options:

1. **Recommended:** a second Render service of type *Background Worker*, same repo, start
   command `node dist/worker.js`, with a `worker.ts` that boots a Nest application context
   containing only `VideoProcessingModule` and the database. The web service enqueues; the
   worker consumes. Web instance CPU is never touched by ffmpeg.
2. **Acceptable while volume is low:** let the existing web service process the queue.
   Then you **must** bound it: `@Process({ name: 'optimize', concurrency: 1 })`, and be aware
   that a large transcode will contend with request handling.

Start with (2) if provisioning a second service is a blocker, but write the processor so
moving to (1) is a deployment change only.

**Backfill** — `boost-backend/scripts/enqueue-optimize-backlog.js`: iterate videos where
`optimizationStatus` is missing or `pending`, enqueue in batches with a delay between them
so the worker is not saturated. Run it in waves and watch the worker.

Prioritise videos with **no cover** first (`thumbnailUrl: ''` — the rows iteration 2's
repair script blanked). That converts the visible long tail of gradient placeholders into
real covers, which is the most user-visible part of this whole phase.

### 9.C Risks — Phase C

| Risk | Likelihood | Mitigation |
|---|---|---|
| **`ffmpeg-static`'s binary is not executable in the Render container** | Medium | T-5.15 first, before writing any pipeline code: deploy a trivial route that shells `ffmpegPath -version` and returns the output. If it fails, `chmod +x` in a postinstall or switch to a Docker deploy with `apt-get install ffmpeg`. |
| **Disk exhaustion.** Two copies of a large file per concurrent job in the container's ephemeral disk | Medium-High | `mkdtemp` per job + `rm -rf` in `finally`, concurrency 1, and a size guard that skips (status `SKIPPED`) any source above e.g. 300 MB. |
| **Memory / CPU starves the web service** (option 2 deployment) | Medium | `-preset veryfast`, concurrency 1, and prefer the dedicated worker. Monitor Render metrics during the backfill. |
| **A retry storm.** `defaultJobOptions.attempts` is 5 with exponential backoff in production ([app.module.ts:76-80](boost-backend/src/app.module.ts#L76-L80)) — a systematically failing job retries five times per video | Medium | Mark `FAILED` and rethrow only for transient errors; for deterministic failures (unsupported codec) mark `SKIPPED` and **return normally** so Bull does not retry. |
| **A transcode makes a video look worse** | Medium | The gate only transcodes sources above 1080p / 6 Mbps / non-h264. `crf 24 / veryfast` is conservative. Eyeball 5 transcoded outputs side by side against their originals before running the backfill (T-5.19). |
| **The cover overwrites a creator's chosen cover** | Medium | The `if (!video.thumbnailKey && !video.thumbnailUrl)` guard. Test it explicitly (T-5.20). |
| **Redis outage stops all optimization** | Medium | Additive design means playback is unaffected. Alert on `optimizationStatus: 'pending'` count growing. |
| **Backfill cost.** Egress from S3 to the worker + storage for a second copy of every video | Medium | The worker is in the same region as the bucket, so egress is free/cheap; storage roughly doubles for optimized renditions. Add an S3 lifecycle rule moving `videos/*/optimized/` older than N days to Infrequent Access if that matters. Do **not** delete originals. |

### 10.C Test plan — Phase C

| # | Test | Pass |
|---|---|---|
| T-5.15 | **ffmpeg binary runs in the deployed container** — temporary route shelling `ffmpeg -version` | Prints a version. **Do this before anything else in this phase.** |
| T-5.16 | **Redis reachable** — `/health` extended to ping the queue, or `bull` job counts endpoint | Connected, queue empty. |
| T-5.17 | **Remux path, single job** — upload an h264 1080p phone video, watch the job | `optimizationStatus: done`, `processedVideoKey` set. `ffprobe` the output: `moov` before `mdat` (`ffmpeg -v trace -i out.mp4 2>&1 \| grep -m2 'type:'`), video stream bit-for-bit identical to the input (`-c copy` preserved it). |
| T-5.18 | **Faststart actually helps** — `curl -r 0-65535` on the optimized object and confirm the moov atom is inside the first 64 KB | Yes. |
| T-5.19 | **Transcode path** — upload a 4K 60 fps source | Output is ≤1080p h264, `optimizationStatus: done`. Visually compare 5 outputs to their sources; no visible artefacting at normal viewing size. |
| T-5.20 | **Creator cover is not overwritten** — publish with a custom cover, wait for the job | `thumbnailKey` unchanged; the creator's image still shows. |
| T-5.21 | **Coverless video gets a cover** — publish with cover generation forced to fail client-side, wait for the job | `thumbnailUrl` populated with a `thumbnails/` key; the feed shows a real frame after refresh. |
| T-5.22 | **Failure is invisible to users** — feed a deliberately corrupt file through the queue | `optimizationStatus: failed`, `optimizationError` recorded, and the video **still plays** from `rawVideoKey`. |
| T-5.23 | **Worker outage** — stop the worker, publish 3 videos | All 3 appear in the feed immediately and play. `optimizationStatus: pending`. Restart the worker → all 3 process. |
| T-5.24 | **Temp files cleaned** — `df` / `ls /tmp` on the worker after 10 jobs | No residue. |
| T-5.25 | **Feed prefers the optimized rendition** — `curl "$API/feed/global"` after a job completes | That item's `videoUrl` path contains `/optimized/`. |
| T-5.26 | **Start-latency improvement** — 3G profile, cache cleared, 10 optimized vs 10 un-optimized videos, measure mount→first-frame | Optimized median measurably lower. Record both numbers. |
| T-5.27 | **Backfill wave** — enqueue 50 coverless videos, watch worker metrics | All complete. CPU/memory stay within instance limits. No API latency regression during the wave. |

### 11.C Success criteria — Phase C

- [ ] `ffmpeg -version` runs in the deployed container (T-5.15).
- [ ] A newly published video reaches `optimizationStatus: done` with `processedVideoKey` set, within 2 minutes (T-5.17).
- [ ] `moov` atom is within the first 64 KB of every optimized file (T-5.18).
- [ ] **A worker outage does not hide or break a single video** (T-5.23). This is the design invariant; if it fails, the additive design was compromised somewhere.
- [ ] A corrupt input results in `failed` status and a **still-playable** video (T-5.22).
- [ ] Creator-chosen covers are never overwritten (T-5.20).
- [ ] Coverless videos gain real covers (T-5.21), and the backfill has reduced
      `db.videos.countDocuments({ $or: [{thumbnailUrl: ''}, {thumbnailUrl: null}] })` to near zero.
- [ ] Measurable mount→first-frame improvement on optimized vs un-optimized (T-5.26).
- [ ] No temp-file residue after 10 jobs (T-5.24).
- [ ] No API p95 latency regression during a 50-video backfill wave (T-5.27).

---

## Phase D — Direct-to-S3 upload (optional, separable)

### 5.D Exact changes

**Backend** — a presign route, modelled on the existing
`generateProfileImageUploadUrl` ([upload.service.ts:97-130](boost-backend/src/modules/upload/upload.service.ts#L97-L130)):

```ts
// upload.service.ts
async generateVideoUploadUrl(userId: string, fileName: string, fileSize: number) {
  this.validateFileSize(UploadType.VIDEO, fileSize);
  const key = this.generateS3Key(userId, UploadType.VIDEO, fileName);

  const uploadUrl = await getSignedUrl(
    this.s3Client,
    new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: 'video/mp4',
      CacheControl: this.IMMUTABLE_CACHE_CONTROL,
    }),
    { expiresIn: this.UPLOAD_URL_EXPIRATION },   // 3600
  );

  return { uploadUrl, key };
}
```

```ts
// upload.controller.ts
@Post('video/presign')
async presignVideo(@CurrentUser() user: User, @Body() dto: PresignVideoDto) {
  return this.uploadService.generateVideoUploadUrl(user.id, dto.fileName, dto.fileSize);
}
```

with a `PresignVideoDto { @IsString() fileName; @IsNumber() @IsPositive() fileSize; }` —
remember `forbidNonWhitelisted`.

**Frontend** — `uploadService.uploadVideoDirect(fileUri, fileSize, onProgress)`:

1. `POST /upload/video/presign` → `{ uploadUrl, key }`.
2. `createUploadTask(uploadUrl, uri, { httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT, headers: { 'Content-Type': 'video/mp4' } }, onProgress)`.
3. Return `{ key }`. `UploadScreen` passes it as `rawVideoKey` exactly as today.

**Keep `POST /upload/video` alive** for one release so older builds keep working, then
delete it.

### 10.D / 11.D Test plan and criteria — Phase D

| # | Test | Pass |
|---|---|---|
| T-5.28 | Presign returns a URL; `curl -X PUT --upload-file clip.mp4 "$url"` | `200`. Object present in S3 with correct `ContentType` and `CacheControl`. |
| T-5.29 | App upload of a 100 MB video | Succeeds. Progress bar advances smoothly. |
| T-5.30 | Render instance during that upload | No `/tmp` growth, no CPU spike, request latency for other endpoints unchanged. |
| T-5.31 | Publish → optimize → feed, end to end | Video appears, plays, and is optimized. |
| T-5.32 | Expired presign (wait > 1 h, then PUT) | `403`. App surfaces a retryable error rather than silently failing. |
| T-5.33 | Old app build still uploads via `POST /upload/video` | Works. |

- [ ] A 100 MB upload never touches the API instance's disk (T-5.30).
- [ ] Upload wall-clock time is lower than the proxied path (measure both).
- [ ] Old builds still upload (T-5.33).

---

## 8. Expected behaviour after this iteration

1. Every media byte is served from a CloudFront edge near the viewer.
2. A re-watch after the app's disk cache is cleared is an edge hit, not an S3 transfer.
3. Optimized videos start decoding from their first bytes — no tail range request first.
4. Oversized 4K sources are normalised to ≤1080p, so a swipe does not pull 80 MB.
5. Videos that had no cover — including the ones iteration 2 had to blank — now have one,
   generated server-side.
6. `processedVideoKey` and `optimizationStatus` describe something real; `processingStatus`
   remains a constant and that is now a deliberate, documented choice rather than an
   accident.
7. (Phase D) Uploads go phone → S3 directly.
8. A worker or Redis outage changes nothing a user can see.

**Still outstanding:** single-rendition delivery. A viewer on a poor connection gets the
same file as one on wifi; there is no adaptive ladder. → Iteration 6.

---

## 12. Rollout order (summary)

```
A1  Create the CloudFront distribution                        (no code)
A2  Set AWS_CLOUDFRONT_DOMAIN in Render, restart              (env only)
A3  Verify T-5.1 … T-5.8                                      ← gate
B1  backfill-cache-control.js --dry, then --prefix=thumbnails/
B2  Spot-check ContentType, then run for videos/
B3  CloudFront invalidation, verify T-5.9 … T-5.14            ← gate
C0  Verify ffmpeg-static runs in the container (T-5.15)        ← gate; do not skip
C1  Provision Redis, set the five env vars
C2  Ship the video-processing module, worker not yet enabled
C3  Enable the worker; publish one test video; verify T-5.17 … T-5.25
C4  Backfill in waves, coverless videos first, monitoring the worker
D   Optional: presigned direct upload
```
