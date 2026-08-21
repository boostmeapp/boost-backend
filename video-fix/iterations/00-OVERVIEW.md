# Boostra Video Feed — Fix Plan Overview

Companion to [VIDEO_FEED_CURRENT_IMPLEMENTATION.md](video-fix/VIDEO_FEED_CURRENT_IMPLEMENTATION.md).

Everything here was re-verified against the live source in `newboostraapp/` and
`boost-backend/` on 2026-08-20. Where this document contradicts or extends the analysis
doc, this document is the one that was checked against code most recently.

---

## How to use this plan

Six iteration files, ordered so that each one is independently shippable, independently
testable, and does not depend on any later iteration.

| # | File | Scope | Risk | Status |
|---|---|---|---|---|
| 1 | [01-PLAYBACK-AUTHORITY.md](01-PLAYBACK-AUTHORITY.md) | Frontend only | Low | ✅ Shipped |
| 2 | [02-POSTER-PIPELINE.md](02-POSTER-PIPELINE.md) | Frontend + Backend | Low–Medium | ✅ Shipped |
| 3 | [03-FEED-API-CONTRACT.md](03-FEED-API-CONTRACT.md) | Backend + Frontend | Medium | ✅ Shipped |
| **7** | [**07-UPLOAD-COMPRESSION-AND-DIRECT-S3.md**](07-UPLOAD-COMPRESSION-AND-DIRECT-S3.md) | Mobile + Backend | Medium | ⬅ **Next — runs before 4** |
| 4 | [04-PRELOAD-AND-CACHE.md](04-PRELOAD-AND-CACHE.md) | Frontend only | Medium | Then |
| 5 | [05-DELIVERY-CDN-FASTSTART.md](05-DELIVERY-CDN-FASTSTART.md) | Backend + AWS infra | Medium | Phase A ✅ done · Phase B **dropped** · Phase C remains · Phase D → moved to 7 |
| 6 | [06-PLAYER-ENGINE-MIGRATION.md](06-PLAYER-ENGINE-MIGRATION.md) | Frontend + Backend | High | Last |

> **Iteration 7 was added on 2026-08-21** and is numbered by identity, not by order. It runs
> **before** iteration 4 — see [its §14](07-UPLOAD-COMPRESSION-AND-DIRECT-S3.md) for the
> dependency argument. Sizing iteration 4's disk cache is not sensible until iteration 7 has
> bounded how large a video file can be.

**Do not reorder.** Iterations 1 and 2 remove the noise that makes iterations 3–6
impossible to measure. Iteration 3 makes the backend the single source of truth for media
URLs, which iteration 5 depends on to switch a CDN on with a one-line env change.
Iteration 4 depends on iteration 1's measured-viewport index math. Iteration 6 depends on
iteration 5's pipeline existing.

Each iteration ends with a **Success Criteria** section. Do not start iteration N+1 until
every box in iteration N passes.

---

## Why this order

The instinct is to start with "the black screen", which is iteration 2. That is wrong,
because right now you cannot *tell* whether a fix worked:

- The active-item selector picks the wrong video, so "the poster didn't show" and "the
  poster showed on the wrong item" are indistinguishable.
- `onPlaybackStatusUpdate` writes React state on every native tick, so a 1050-line
  unmemoised component re-renders ~4×/second — and `expo-av` re-sends `shouldPlay` and
  re-reads `source` on every one of those renders. Any change you make to buffering
  behaviour is swamped by this.

So iteration 1 is: **make the player deterministic**. After it, one video plays, it is the
right one, and it stays in the state you put it in. Only then do symptom-level fixes give
readable signal.

---

## Confirmed defect register

Every item below was confirmed by reading the file, not inferred. The right-hand column is
the iteration that closes it.

### Playback / list

| ID | Defect | Location | Iter |
|---|---|---|---|
| D-01 | `viewableItems[0]` is the lowest-index viewable item, not the most-visible one — at a scroll boundary the *outgoing* item is selected | [HomeScreen.jsx:132](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L132) | 1 |
| D-02 | On a fast swipe no item satisfies `itemVisiblePercentThreshold: 50` for `minimumViewTime: 100`, so `onViewableItemsChanged` never fires and the new item stays `isFocused === false` | [HomeScreen.jsx:143-146](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L143-L146) | 1 |
| D-03 | `snapToInterval` / `getItemLayout` / item container all use a module-load snapshot of `Dimensions.get('window').height`, which is not the list's real viewport height under Android `edgeToEdgeEnabled: true` | [HomeScreen.jsx:15](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L15), [FeedPostItem.jsx:35,1048](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L1048) | 1 |
| D-04 | Three competing play/pause controllers: `shouldPlay` prop, a `useEffect` calling `playAsync`/`pauseAsync`, and `togglePlayPause` calling them directly | [FeedPostItem.jsx:245-253, 307-313, 500](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L245-L253) | 1 |
| D-05 | `source={{ uri: item.videoUrl }}` is a fresh object literal on every render; `expo-av`'s `render()` re-reads it each time | [FeedPostItem.jsx:497](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L497) | 1 |
| D-06 | `handleFollowToggle()` is called but never defined — pressing the `+` badge throws `ReferenceError` | [FeedPostItem.jsx:625](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L625) | 1 |
| D-07 | `styles.backButton` referenced but absent from that file's `StyleSheet` | [FeedPostItem.jsx:459](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L459) | 1 |
| D-08 | `initialScrollIndex` set with no `onScrollToIndexFailed` handler | [HomeScreen.jsx:341](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L341) | 1 |
| D-09 | `RefreshControl` attached to a `pagingEnabled` full-screen vertical pager, fighting the swipe gesture | [HomeScreen.jsx:361-367](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L361-L367) | 1 |
| D-10 | `<Video source={{ uri: null }}>` is rendered when `rawVideoKey` is missing — no guard | [FeedPostItem.jsx:497](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L497) | 1 |
| D-11 | The sync effect resets `isLiked` from `item.isLiked` whenever `followingList` changes, discarding the optimistic like | [FeedPostItem.jsx:235-238](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L235-L238) | 1 |
| D-12 | `onPlaybackStatusUpdate` unconditionally calls `setIsVideoLoaded(true)` and `setIsPlaying(...)` on every native tick | [FeedPostItem.jsx:505-524](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L505-L524) | 1 |
| D-13 | `FeedPostItem` has no `React.memo`, is rendered from an inline arrow `renderItem`, and consumes a context whose `value` object is rebuilt every render — and that provider wraps the entire `<Stack>` | [VideoPlaybackContext.js:23-30](newboostraapp/src/context/VideoPlaybackContext.js#L23-L30), [_layout.jsx:116](newboostraapp/src/app/_layout.jsx#L116) | 1 |
| D-14 | `HomeScreen` destructures the whole Zustand store with no selector, so every store write re-renders the feed | [HomeScreen.jsx:59-73](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L59-L73) | 1 |
| D-15 | No player is ever `unloadAsync()`d; decoders are released only when RN happens to unmount the view | [FeedPostItem.jsx](newboostraapp/src/screens/home/components/FeedPostItem.jsx) | 1 |
| D-16 | `video/[id].jsx` passes `isFocused` as a prop, which `FeedPostItem` ignores, and keeps a second local `activeVideoId` alongside the context | [video/[id].jsx:51,143](newboostraapp/src/app/video/[id].jsx#L143) | 1 |

### Poster / thumbnail

| ID | Defect | Location | Iter |
|---|---|---|---|
| D-17 | `uploadService.uploadFile(uri, 'profile_image')` **always** POSTs to `/upload/video`; the `type` argument is a form field the controller never reads | [uploadService.js:22,45-47](newboostraapp/src/services/uploadService.js#L22) | 2 |
| D-18 | `/upload/video` has `fileFilter: mimetype.startsWith('video/')`, so every thumbnail JPEG is rejected with 400 | [upload.controller.ts:112-119](boost-backend/src/modules/upload/upload.controller.ts#L112-L119) | 2 |
| D-19 | On that failure the payload falls through to `thumbnailUrl: realThumbnailUrl \|\| upload.data.url` — the **video's** URL — and that is what is persisted to Mongo | [UploadScreen.jsx:174](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L174) | 2 |
| D-20 | `uploadFile` returns `generateDownloadUrl(key)`, a presigned URL with `expiresIn: 86400` — any thumbnail that *did* persist dies after 24 h | [upload.service.ts:32,229](boost-backend/src/modules/upload/upload.service.ts#L229) | 2 |
| D-21 | The live poster path is `VideoThumbnails.getThumbnailAsync(item.videoUrl)` against a **remote** URL on the focused item — a second full download of the same MP4, concurrent with playback, that can never finish before the video does | [FeedPostItem.jsx:444-450](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L444-L450) | 2 |
| D-22 | The poster is painted twice: as an overlay `<Image>` and via `usePoster`/`posterSource` on the `<Video>` | [FeedPostItem.jsx:487-493, 502-504](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L487-L493) | 2 |
| D-23 | `PutObjectCommand` in `uploadFile` sets no `CacheControl`, so every re-fetch is a full origin round-trip | [upload.service.ts:211-222](boost-backend/src/modules/upload/upload.service.ts#L211-L222) | 2 |
| D-24 | `video/[id].jsx` reads `v.thumbnailUrl` with **no** video-extension guard, unlike `HomeScreen` — so on that surface the mp4 URL is handed to `<Image>` | [video/[id].jsx:36](newboostraapp/src/app/video/[id].jsx#L36) | 2 |

### Feed API

| ID | Defect | Location | Iter |
|---|---|---|---|
| D-25 | `/feed/global` has no guard and there is no global `APP_GUARD` for `JwtAuthGuard` (the entry is absent from `app.module.ts` providers), so `request.user` is never populated → `userId` always `undefined` → `hasLiked` always `false`, block filtering never applies | [feed.controller.ts:13](boost-backend/src/modules/feed/feed.controller.ts#L13), [app.module.ts:116-129](boost-backend/src/app.module.ts#L116-L129) | 3 |
| D-26 | Same for `@Get('videos/:id')` — it is decorated `@Public()` but nothing populates `request.user`, so `hasLiked`/`isFollowing` are always `false` there too | [video.controller.ts:76-79](boost-backend/src/modules/video/video.controller.ts#L76-L79) | 3 |
| D-27 | No projection — `.lean()` returns `chunks`, `rewardPool*`, `boost*`, `moderation*`, `watchTimeTotal`, `removedReason` for all 20 docs | [feed.service.ts:117-123](boost-backend/src/modules/feed/feed.service.ts#L117-L123) | 3 |
| D-28 | `populate('user', 'firstName lastName profileImage')` omits `username`, which the app reads for the handle → handles always fall back to `@firstname` | [feed.service.ts:122](boost-backend/src/modules/feed/feed.service.ts#L122) | 3 |
| D-29 | `countDocuments(query)` runs on every page request | [feed.service.ts:115](boost-backend/src/modules/feed/feed.service.ts#L115) | 3 |
| D-30 | `skip`/`limit` offset pagination over `createdAt: -1` — any upload between page 1 and page 2 shifts the window, duplicating or skipping items | [feed.service.ts:118-121](boost-backend/src/modules/feed/feed.service.ts#L118-L121) | 3 |
| D-31 | `appendVideos` concatenates with no de-duplication, so duplicate `keyExtractor` keys force remounts | [store/index.js:86-88](newboostraapp/src/store/index.js#L86-L88) | 3 |
| D-32 | The backend never returns a playable URL; the app composes `S3_BASE_URL + rawVideoKey` and the bucket hostname is hardcoded in **three** files | [HomeScreen.jsx:182](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L182), [FeedPostItem.jsx:437](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L437), [video/[id].jsx:35](newboostraapp/src/app/video/[id].jsx#L35) | 3 |
| D-33 | `videoService.getFollowingFeed` builds its `pagination` object **without `hasNextPage`**, so `setHasNextPage(undefined)` and `handleLoadMore` returns early forever — the Following feed never paginates | [videoService.js:189-194](newboostraapp/src/services/videoService.js#L189-L194) | 3 |
| D-34 | `fetchVideos` reads `videos.length` from a stale closure when deciding whether to set the first active video | [HomeScreen.jsx:244](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L244) | 3 |
| D-35 | `PaginationDto` defaults `limit` to 10 while the app always sends 20; and `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` in `main.ts` will **400** any new query param not declared on the DTO | [pagination.dto.ts](boost-backend/src/common/dto/pagination.dto.ts), [main.ts:84-99](boost-backend/src/main.ts#L84-L99) | 3 |
| D-36 | `calculateRankScore` / `getPersonalizedFeed` exist but are wired to no route — boosted videos get no ranking advantage in the feed the app consumes | [feed.service.ts:168-281](boost-backend/src/modules/feed/feed.service.ts#L168-L281) | 3 (documented, not enabled) |

### Preload / cache / cold start

| ID | Defect | Location | Iter |
|---|---|---|---|
| D-37 | No prefetch of any kind — the MP4 request does not start until the item is on screen | [HomeScreen.jsx](newboostraapp/src/screens/home/screens/HomeScreen.jsx) | 4 |
| D-38 | `videoCacheService.js` implements the cache you want and is **imported by nothing** (verified: zero imports across `src/`) | [videoCacheService.js](newboostraapp/src/services/videoCacheService.js) | 4 |
| D-39 | That service's `initialize()` deletes the whole cache directory on every launch, so it would give no cross-session benefit even if wired up | [videoCacheService.js:7-20](newboostraapp/src/services/videoCacheService.js#L7-L20) | 4 |
| D-40 | `windowSize={3}` mounts 3–5 `<Video>` instances, each of which begins pulling bytes from S3 on mount, starving the visible one | [HomeScreen.jsx:350](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L350) | 4 |
| D-41 | A hardcoded 2000 ms full-screen GIF overlay runs before anything, and the feed fetch does not start until `HomeScreen` mounts — two AsyncStorage round-trips later | [_layout.jsx:35-39](newboostraapp/src/app/_layout.jsx#L35-L39), [index.jsx:18-36](newboostraapp/src/app/index.jsx#L18-L36) | 4 |
| D-42 | Verbose `console.log` per item, per scroll event and per API call runs in release builds | [HomeScreen.jsx:130-136](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L130-L136), [FeedPostItem.jsx:229-231](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L229-L231) | 1 |

### Delivery

| ID | Defect | Location | Iter |
|---|---|---|---|
| D-43 | No CDN. `AWS_CLOUDFRONT_DOMAIN` is the literal string `REPLACE_WITH_CLOUDFRONT_DOMAIN` and `ENV.AWS_CLOUDFRONT_DOMAIN` is read by no code | [boost-backend/.env](boost-backend/.env), [env.ts:89](boost-backend/src/config/env.ts#L89) | 5 |
| D-44 | No transcode, no `-movflags +faststart`, no ABR ladder. `VIDEO_QUALITIES`, `VIDEO_CHUNK_DURATION`, `manifestUrl`, `processedVideoKey`, `chunks[]` are all scaffolding that is never written or read | [video.schema.ts:70-78](boost-backend/src/database/schemas/video/video.schema.ts#L70-L78) | 5 / 6 |
| D-45 | `processingStatus` is set to `READY` at record creation — it is a constant, not a state | [video.service.ts:53-54](boost-backend/src/modules/video/video.service.ts#L53-L54) | 5 |
| D-46 | Every byte of every play crosses to `eu-north-1` (Stockholm) from wherever the viewer is, over one unsegmented MP4, with no edge cache | — | 5 |
| D-47 | The upload path streams a 500 MB-capped original **through the Render API instance** (buffered to `/tmp`) rather than direct-to-S3 | [upload.controller.ts:107-136](boost-backend/src/modules/upload/upload.controller.ts#L107-L136) | 5 |
| D-48 | `expo-av` is deprecated and is removed in Expo SDK 55; the app is on SDK 54 | [package.json:23](newboostraapp/package.json#L23) | 6 |
| D-49 | `ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 })` — no compression, no resolution cap, no duration cap on the client | [UploadScreen.jsx:57-60](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L57-L60) | 5 |

---

## Constraints that shape every iteration

These are properties of the current codebase that will bite you if you forget them. They
are repeated in the iterations that they affect, but read them once here.

1. **`forbidNonWhitelisted: true`.** [main.ts:84-99](boost-backend/src/main.ts#L84-L99) sets
   `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`. Any new query param
   or body field that is not declared on a DTO returns **400**, not a silent ignore. Adding
   `cursor` to the feed, or `thumbnailKey` to `POST /videos`, requires a DTO change in the
   same commit.

2. **There is no global auth guard.** `app.module.ts` providers list contains
   `ThrottlerGuard` and `AllExceptionsFilter` only. `@Public()` and `@CurrentUser()` on an
   unguarded route are inert. Any route that wants an *optional* viewer needs an explicit
   `OptionalJwtAuthGuard` (iteration 3 adds one).

3. **`expo-video` is not installed.** `package.json` has `expo-av@~16.0.8` and no
   `expo-video`. Iterations 1–5 are written against `expo-av`. Iteration 6 migrates.

4. **`expo-image` is not installed.** Posters use React Native's core `<Image>`, which has
   no cache-policy control. Iteration 2 notes where `expo-image` would help; it is optional
   there and only becomes load-bearing in iteration 4.

5. **`react-native-pager-view@6.9.1` *is* installed** but unused by the feed. It is a
   viable escape hatch if `FlatList` paging proves unfixable in iteration 1 — see the
   contingency section there.

6. **Render free/starter cold starts.** `BASE_URL` is
   `https://boost-backend-n9w3.onrender.com/api`. Any measurement you take on a cold
   instance is noise. Warm the API with a `GET /api/health` before every timing run.

7. **The S3 bucket serves unsigned public reads.** The app fetches
   `https://boostme-storage.s3.eu-north-1.amazonaws.com/{rawVideoKey}` with no signature
   and it plays, while `PutObjectCommand` in `uploadFile` sets no ACL — so the bucket must
   carry a public-read bucket policy. Confirm this in the AWS console before iteration 2
   changes URL generation, and again before iteration 5 locks the bucket behind OAC.

8. **Two feed response envelopes exist.** `FeedService` returns
   `{ docs, totalDocs, limit, page, totalPages, hasNextPage, hasPrevPage }`; `VideoService`
   returns `{ data, pagination }` and `{ data, nextCursor }`. Only the `FeedService` shape
   is consumed by the app. Iteration 3 standardises on one and deletes the dead ones.

9. **~~THE APP IS LIVE AND THE S3 BUCKET IS PRODUCTION.~~ — LIFTED 2026-08-21.** <a id="constraint-9"></a>

   > **This constraint no longer applies.** The owner has decided that **production data
   > will be deleted**, and local/dev work now runs against a dedicated dev bucket
   > (`AWS_S3_BUCKET=boostme-storage-dev`) with the CDN already configured
   > (`AWS_CLOUDFRONT_DOMAIN=d37o15qkd7x4po.cloudfront.net`) — both verified in
   > `boost-backend/.env`. The original text is kept below, struck, because iterations 2 and
   > 3 were designed under it and their design choices only make sense in that light.

   **What changes as a result — this is the important part.** A planned wipe does not merely
   *ungate* the repair and backfill work; it **supersedes** most of it. There is no point
   repairing rows or rewriting object metadata that is about to be deleted. See the table in
   the next section: four of the six deferred steps are now **dropped, not deferred**.

   **What is still true regardless of the wipe:**

   - The **OAC cutover** (bucket goes private) still breaks any installed app build that
     composes an `s3.{region}` URL itself. Iteration 3 moved URL composition server-side, so
     *current* builds are fine — and after a data wipe the feed is empty anyway, so there is
     nothing for an old build to fail to play. Cutover is therefore safe, but sequence it
     after the wipe, not before.
   - **Do the wipe before, not after, shipping the new upload pipeline.** Objects written by
     the old pipeline (uncompressed originals, no `Cache-Control` on pre-iteration-2 uploads)
     are exactly what the wipe is for. Wipe first and the bucket contains only correctly
     written objects from day one — which is Iteration 7's §8 goal achieved for free.

   ~~*Original text:*~~

   - ~~Local development currently runs against a **private Mongo** but the **production S3
     bucket** (`boostme-storage`). Test uploads therefore land in prod.~~
   - ~~**No data-mutating script runs against production Mongo or production S3.**~~
   - ~~No `aws s3 cp --recursive`, no `aws s3 sync`, no `--metadata-directive REPLACE`, no
     object deletion, no `updateMany` against prod.~~
   - ~~**A separate development environment on Render — with its own Mongo — is a
     prerequisite** for all of the above.~~
   - ~~**Design consequence.** Because the repairs lag the code, every iteration must be
     correct against **unrepaired** production data.~~ **← no longer binding.** Iterations 4–7
     may assume a clean bucket and clean collections. Iteration 2's client-side `toPosterUrl`
     guard stays anyway: it is cheap, and it protects against a wipe that is delayed or partial.

---

## Deferred production steps — mostly superseded by the planned data wipe

**Updated 2026-08-21.** With production data being deleted, most of this table is no longer
work that needs doing. Re-triaged:

| Step | From | Status now | Why |
|---|---|---|---|
| `scripts/repair-thumbnails.js` | Iter 2 §5.5 | ❌ **Drop** | It repairs `thumbnailUrl` rows that a wipe removes. The client-side `toPosterUrl` guard already handles the poisoned values in the meantime. |
| Same logic for `users.profileImage` | Iter 2 §5.5 | ❌ **Drop** | Same reasoning. |
| `createIndex(..., {background:true})` ×2 | Iter 3 T-3.0 | ✅ **Ungated — just run it** | Index builds on an empty (or soon-empty) collection are instant and risk-free. `autoIndex: true` is set on the schema, so this may already be satisfied; verify rather than assume. |
| `scripts/backfill-cache-control.js` | Iter 5 Phase B | ❌ **Drop — do not write it** | Its entire purpose is objects uploaded before iteration 2 added `CacheControl`. After a wipe there are none. This removes the riskiest script in the plan (the `MetadataDirective: REPLACE` / `ContentType`-clobbering hazard) along with **all of Iteration 5 Phase B**. |
| CloudFront + OAC cutover | Iter 5 Phase A | ✅ **Ungated** | Distribution already exists and is wired up. Sequence the OAC step *after* the wipe. |
| `scripts/enqueue-optimize-backlog.js` | Iter 5 §Backfill | ❌ **Drop** | There is no backlog after a wipe. Iteration 5 Phase C's `optimize` job still runs **on new uploads**; only the bulk backfill goes away. |
| Orphan-object lifecycle rule | Iter 7 §11.3 | ✅ **Ungated** | Was gated only because it deletes objects. Create it whenever convenient. |

**Net effect: Iteration 5 loses Phase B entirely and Phase C loses its backfill wave.** What
remains of Iteration 5 is Phase A (done) and Phase C's per-upload optimize job.

---

## Baseline measurements to take before you start

Take these once, on a real device, on a warmed API, and write the numbers down. Every
iteration's success criteria is expressed relative to them.

| Metric | How to measure |
|---|---|
| **T-launch** — app icon tap → first video frame visible | Screen recording at 60 fps, count frames |
| **T-feed** — `fetchVideos` start → `setVideos` | `console.time` around the call in `fetchVideos` |
| **T-firstbyte** — `<Video>` mount → `onPlaybackStatusUpdate` with `isLoaded: true` | Temporary timestamp log in `FeedPostItem` |
| **T-swipe** — swipe release → next video's first frame | Screen recording, count frames, 20 swipes, report median and p90 |
| **Wrong-item rate** — swipes where a non-visible video's audio plays | 50 fast swipes, count |
| **Stuck-pause rate** — swipes where the visible video does not start | 50 fast swipes, count |
| **Tap-pause stick rate** — taps to pause that stay paused ≥ 2 s | 20 taps, count |
| **Feed payload size** — bytes of `GET /api/feed/global?page=1&limit=20` | `curl -s ... \| wc -c` |
| **Feed latency** — server time for that call | `curl -w '%{time_total}'`, warmed instance, 5 runs |
| **Re-renders per second of `FeedPostItem` while one video plays** | React DevTools Profiler, or a `useRef` counter logged once per second |

Record them in a scratch file. You will compare against them six times.
