# Boostra Video Feed — Current Implementation

A code-level description of how the home video feed works today, across
`newboostraapp` (React Native / Expo mobile app) and `boost-backend` (NestJS API).

Everything below was derived by reading the actual source in this repository. Where a
statement is an inference rather than something directly visible in code, it is marked
**(inferred)**.

---

## 1. Stack summary

| Layer | Technology | Where |
|---|---|---|
| Mobile app | Expo SDK 54, React Native 0.81.5, React 19, expo-router 6, New Architecture enabled | [newboostraapp/package.json](newboostraapp/package.json), [app.json](newboostraapp/app.json) |
| Video player | **`expo-av` 16 `<Video>`** (officially deprecated in favour of `expo-video`) | [FeedPostItem.jsx:19](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L19) |
| Feed list | `FlatList` with `pagingEnabled` + `snapToInterval` | [HomeScreen.jsx:338-387](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L338-L387) |
| State | Zustand global store + a React Context for playback | [store/index.js](newboostraapp/src/store/index.js), [VideoPlaybackContext.js](newboostraapp/src/context/VideoPlaybackContext.js) |
| API | NestJS 11 + Mongoose (MongoDB) | [boost-backend/src](boost-backend/src) |
| API hosting | Render — `https://boost-backend-n9w3.onrender.com/api` | [api.config.js:3](newboostraapp/src/config/api.config.js#L3) |
| Media storage | AWS S3, bucket `boostme-storage`, region `eu-north-1` | [boost-backend/.env](boost-backend/.env), [upload.service.ts:188-191](boost-backend/src/modules/upload/upload.service.ts#L188-L191) |
| CDN | **None active.** `AWS_CLOUDFRONT_DOMAIN` is still the literal placeholder `REPLACE_WITH_CLOUDFRONT_DOMAIN`, and the `ENV.AWS_CLOUDFRONT_DOMAIN` getter is never read by any code | [env.ts:89](boost-backend/src/config/env.ts#L89) |
| Transcoding | **None.** No `ffmpeg`, `fluent-ffmpeg`, HLS packager, or worker exists anywhere in the backend | verified by grep over `boost-backend` |

---

## 2. Backend: what the feed actually is

### 2.1 Endpoints

The app calls exactly two feed endpoints ([api.config.js:36-39](newboostraapp/src/config/api.config.js#L36-L39)):

| App tab | Endpoint | Handler |
|---|---|---|
| **For You** | `GET /api/feed/global?page&limit=20` | [feed.controller.ts:13](boost-backend/src/modules/feed/feed.controller.ts#L13) → `FeedService.getGlobalFeed` |
| **Following** | `GET /api/feed/following?page&limit=20` | [feed.controller.ts:28](boost-backend/src/modules/feed/feed.controller.ts#L28) → `FeedService.getFollowingFeed` |

### 2.2 `getGlobalFeed` — the "For You" feed

[feed.service.ts:102-156](boost-backend/src/modules/feed/feed.service.ts#L102-L156)

```
1. Load the viewer's blockedUsers array (one extra findById per request).
2. Build query: { processingStatus: 'ready', moderationStatus: { $ne: REMOVED } }
   (+ user: { $nin: blockedIds } when the viewer has blocks)
3. countDocuments(query)                      ← full count on every page request
4. find(query).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('user', 'firstName lastName profileImage').lean()
5. Attach hasLiked per video via LikesService.hasUserLikedVideos
6. Return { docs, totalDocs, limit, page, totalPages, hasNextPage, hasPrevPage }
```

Important characteristics of this as written:

- **It is not a ranked feed.** It is strictly reverse-chronological (`createdAt: -1`).
  The `calculateRankScore` / `getPersonalizedFeed` ranking logic
  ([feed.service.ts:168-281](boost-backend/src/modules/feed/feed.service.ts#L168-L281))
  exists but **is not wired to any route** — nothing calls it. Boosted videos therefore
  receive no ranking advantage in the feed the app actually consumes.
- **`/feed/global` has no `JwtAuthGuard`** and there is no global auth guard registered
  ([app.module.ts:116-129](boost-backend/src/app.module.ts#L116-L129) — the `APP_GUARD` entry
  for `JwtAuthGuard` is commented out). The `@CurrentUser()` decorator just reads
  `request.user` ([current-user.decorator.ts](boost-backend/src/common/decorators/current-user.decorator.ts)),
  which is never populated on this route. Consequently `userId` is always `undefined`,
  block filtering never applies, and **`hasLiked` is always `false`** on the For You feed.
- **No projection.** `.lean()` returns the entire video document — `chunks`, `rewardPool*`,
  `boost*`, `moderation*`, `watchTimeTotal`, `removedReason`, etc. — for all 20 items,
  even though the app reads about 12 fields.
- **Offset pagination** (`skip`/`limit`) over a `createdAt`-sorted collection. Any upload
  between page 1 and page 2 shifts the window, producing duplicated or skipped items.
- `populate('user', 'firstName lastName profileImage')` does **not** select `username`,
  but the app reads `video.user?.username` for the handle
  ([HomeScreen.jsx:202](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L202)) — so
  handles always fall back to `@firstname`.

### 2.3 `getFollowingFeed`

[feed.service.ts:30-98](boost-backend/src/modules/feed/feed.service.ts#L30-L98) — same
shape, additionally resolving the follow list first. Note `VideoService` also has its own
`getFollowingFeed` and a cursor-based `getFollowingFeedCursor`
([video.service.ts:66-216](boost-backend/src/modules/video/video.service.ts#L66-L216)) that
return a different envelope (`{ data, pagination }` / `{ data, nextCursor }`) — the app does
not use them. There are effectively three parallel feed implementations, only one of which is live.

### 2.4 Upload / "processing" pipeline

The app uploads the **original file, unmodified**:

1. `ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 })`
   — no compression, no resolution cap, no duration cap
   ([UploadScreen.jsx:57-60](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L57-L60)).
2. The whole file is POSTed **through the Render API** to `/api/upload/video` (multipart,
   500 MB limit, buffered to `/tmp` on the server)
   ([uploadService.js:17-101](newboostraapp/src/services/uploadService.js#L17-L101),
   [upload.controller.ts:107-136](boost-backend/src/modules/upload/upload.controller.ts#L107-L136)).
3. The server streams it to S3 as-is ([upload.service.ts:197-254](boost-backend/src/modules/upload/upload.service.ts#L197-L254)).
4. `POST /api/videos` creates the DB record with
   **`processingStatus: READY, processingProgress: 100`** immediately
   ([video.service.ts:53-54](boost-backend/src/modules/video/video.service.ts#L53-L54)).

So `processingStatus: 'ready'` is a constant, not a state. The `Video` schema declares
`manifestUrl`, `processedVideoKey` and a `chunks: VideoChunk[]` array for HLS
([video.schema.ts:18-78](boost-backend/src/database/schemas/video/video.schema.ts#L18-L78)),
and `.env` declares `VIDEO_QUALITIES=360p,720p,1080p` and `VIDEO_CHUNK_DURATION=4` — **none
of these are ever written or read.** They are scaffolding for a pipeline that was never built.

There is **no** transcode, no `-movflags +faststart`, no ABR ladder, no thumbnail
extraction server-side, and no BullMQ job for any of it (BullMQ is configured in
[app.module.ts:56-91](boost-backend/src/app.module.ts#L56-L91) but `REDIS_HOST` is
`REPLACE_WITH_REDIS_HOST` and no queue or processor for video exists).

### 2.5 How the app gets a playable URL

The backend never returns a video URL. The app **constructs the S3 URL client-side** from
the raw key ([HomeScreen.jsx:182, 221](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L182-L221)):

```js
const S3_BASE_URL = 'https://boostme-storage.s3.eu-north-1.amazonaws.com/';
videoUrl: video.rawVideoKey ? `${S3_BASE_URL}${video.rawVideoKey}` : null,
```

The bucket hostname is hardcoded in three separate files
([HomeScreen.jsx:182](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L182),
[FeedPostItem.jsx:437](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L437),
[video/[id].jsx:35](newboostraapp/src/app/video/[id].jsx#L35)).

Playback therefore goes **device → S3 `eu-north-1` (Stockholm) directly**, over a single
unsegmented MP4, with no edge cache in front of it. For a viewer outside Northern Europe
every byte crosses the ocean on each play and each re-watch. **(inferred: bucket objects must
have a public-read bucket policy, since `PutObjectCommand` for videos sets no ACL
([upload.service.ts:211-222](boost-backend/src/modules/upload/upload.service.ts#L211-L222))
yet the app fetches unsigned URLs.)**

S3 does natively support `Accept-Ranges: bytes`, so range requests already work at the
storage layer — that piece is not missing.

### 2.6 The thumbnail chain is broken

This is the single most consequential defect for "black screen before playback", and it is
a chain of three bugs:

1. `UploadScreen` uploads the poster image with
   `uploadService.uploadFile(customThumbnail.uri, 'profile_image')`
   ([UploadScreen.jsx:138, 144, 154](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L138-L154)).
2. But `uploadService.uploadFile` **always** POSTs to `API_CONFIG.ENDPOINTS.UPLOAD.DIRECT`,
   i.e. `/upload/video` — the `type` argument is passed as a form parameter the controller
   ignores ([uploadService.js:22, 45-47](newboostraapp/src/services/uploadService.js#L22-L47)).
3. `/upload/video` has `fileFilter: mimetype.startsWith('video/')`
   ([upload.controller.ts:112-119](boost-backend/src/modules/upload/upload.controller.ts#L112-L119)),
   so a JPEG is **rejected**. `realThumbnailUrl` stays `null`, the fallback path fails the
   same way, and the payload falls through to:
   ```js
   thumbnailUrl: realThumbnailUrl || upload.data.url   // ← the VIDEO's URL
   ```
   ([UploadScreen.jsx:173](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L173))

So `video.thumbnailUrl` in Mongo is, for app-uploaded videos, **the video file's URL**. The
feed mapper detects this and defends against it by returning `null`
([HomeScreen.jsx:183-193](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L183-L193)):

```js
if (lower.endsWith('.mp4') || lower.endsWith('.mov') || ...) return null;
```

**Result: `posterUri` is `null` for essentially every video uploaded through the app.**
There is nothing to show while the video buffers — hence the black screen.

A secondary problem on the same path: `uploadFile` returns
`generateDownloadUrl(key)`, a **presigned URL with `expiresIn: 86400`**
([upload.service.ts:32, 229](boost-backend/src/modules/upload/upload.service.ts#L32-L229)).
Any thumbnail URL that *did* get persisted this way stops working after 24 hours.

---

## 3. Frontend: the feed screen

### 3.1 Cold-start sequence

```
App launch
 └─ RootLayout mounts
     ├─ SplashScreen.hideAsync() immediately
     ├─ a full-screen black GIF overlay is force-shown for a hardcoded 2000 ms   ← _layout.jsx:37
     └─ prepare(): AsyncStorage reads (user + token) → store.login()
 └─ app/index.jsx mounts
     ├─ another AsyncStorage read of token + user
     └─ router.replace('/home')
 └─ HomeScreen mounts
     ├─ isLoading = true  → full-screen spinner "Loading Feed..."      ← HomeScreen.jsx:293
     └─ useEffect → fetchVideos() → GET /feed/global (Render round-trip)
 └─ setVideos(...) → FlatList renders item 0
 └─ <Video> mounts and only NOW begins downloading the MP4 from S3
 └─ first frame appears
```

Nothing is prefetched. The video request does not even start until the API response has
landed, which itself cannot start until 2 s of splash + two AsyncStorage round-trips have
elapsed. On Render's free/starter tiers a cold instance adds tens of seconds to step 1
**(inferred from the `onrender.com` host; the tier isn't in the repo)**.

### 3.2 The list

[HomeScreen.jsx:338-387](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L338-L387)

```jsx
const { height } = Dimensions.get('window');   // captured once at module load

<FlatList
  data={videos}
  renderItem={({ item }) => (
    <FeedPostItem item={item} isActive={activeVideoId === item.id} onCommentPress={...} />
  )}
  removeClippedSubviews={true}
  windowSize={3}
  initialNumToRender={2}
  maxToRenderPerBatch={2}
  pagingEnabled
  snapToInterval={height}
  snapToAlignment="start"
  decelerationRate="fast"
  onViewableItemsChanged={onViewableItemsChanged}
  viewabilityConfig={{ itemVisiblePercentThreshold: 50, minimumViewTime: 100 }}
  getItemLayout={(d, i) => ({ length: height, offset: height * i, index: i })}
  refreshControl={<RefreshControl ... />}
  onEndReached={handleLoadMore}
  onEndReachedThreshold={0.5}
/>
```

Each item renders at `{ width, height }` from the same module-level `Dimensions.get('window')`
snapshot ([FeedPostItem.jsx:1048](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L1048)).

### 3.3 Playback authority

Two sources of truth exist for "which video is active", and they are kept in sync by an effect:

- `VideoPlaybackContext` — the provider sits at the **root of the app**, wrapping the whole
  `<Stack>` ([_layout.jsx:116-147](newboostraapp/src/app/_layout.jsx#L116-L147)).
  It holds `activeVideoId`, `isAppActive`, `isScreenFocused`
  ([VideoPlaybackContext.js](newboostraapp/src/context/VideoPlaybackContext.js)).
- The Zustand store also holds `activeVideoId` and `lastScrollIndex`
  ([store/index.js:80-92](newboostraapp/src/store/index.js#L80-L92)), mirrored from context
  by an effect ([HomeScreen.jsx:122-126](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L122-L126)).

`FeedPostItem` derives its own focus flag from the context and ignores the `isActive` prop
the list passes it ([FeedPostItem.jsx:74-78](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L74-L78)):

```js
const { activeVideoId, isAppActive, isScreenFocused } = useVideoPlayback();
const isFocused = item.id === activeVideoId && isAppActive && isScreenFocused;
```

The active item is chosen by `onViewableItemsChanged`, which takes `viewableItems[0]`
([HomeScreen.jsx:129-146](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L129-L146)).

`AppState` and `useFocusEffect` feed `isAppActive` / `isScreenFocused`
([HomeScreen.jsx:149-163](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L149-L163)).

### 3.4 Play/pause is driven three different ways at once

Inside one component:

1. **Declarative prop** — `shouldPlay={isFocused}` on `<Video>`
   ([FeedPostItem.jsx:500](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L500)).
2. **Imperative effect** — `playAsync()` / `pauseAsync()` on `[isFocused, isVideoLoaded]`
   ([FeedPostItem.jsx:245-253](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L245-L253)).
3. **Imperative tap handler** — `togglePlayPause` calls `playAsync()`/`pauseAsync()` directly
   ([FeedPostItem.jsx:307-313](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L307-L313)).

And `onPlaybackStatusUpdate` writes `isPlaying` back into React state on every native tick
([FeedPostItem.jsx:505-524](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L505-L524)).

This matters because of how `expo-av` works internally. Its `render()` collects
`shouldPlay` into a `status` object and hands it to the native view **on every render**
([node_modules/expo-av/build/Video.js:237-266](newboostraapp/node_modules/expo-av/build/Video.js#L237-L266)):

```js
const status = { ...this.props.status };
['progressUpdateIntervalMillis','positionMillis','shouldPlay','rate', ... ]
  .forEach((prop) => { if (prop in this.props) status[prop] = this.props[prop]; });
```

The same render also recomputes `source` from `this.props.source` — and the app passes a
**fresh object literal** `source={{ uri: item.videoUrl }}` on every render
([FeedPostItem.jsx:497](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L497)).

### 3.5 Poster resolution

[FeedPostItem.jsx:426-452](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L426-L452)

```js
if (thumb is a usable image URL) → setPosterUri(resolved); return;

// otherwise, ONLY when this item is the focused one:
if (isFocused && item.videoUrl?.startsWith('http')) {
  VideoThumbnails.getThumbnailAsync(item.videoUrl, { time: 500 })
    .then(res => setPosterUri(res.uri));
}
```

Because §2.6 makes the first branch fail for app-uploaded videos, the second branch is the
live path. `expo-video-thumbnails` against a **remote URL** must fetch the file to decode a
frame at 500 ms — so the app opens a **second concurrent download of the same MP4**, on the
active item, at the exact moment that item is trying to buffer for playback. And it only
starts once the item is already on screen, so the poster can never arrive before the video does.

The poster is then drawn twice: as an overlay `<Image>` whenever
`(!isVideoLoaded || !isPlaying)` ([FeedPostItem.jsx:487-493](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L487-L493))
**and** via `usePoster` / `posterSource` on the `<Video>` itself
([FeedPostItem.jsx:502-504](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L502-L504)).

### 3.6 Caching and preloading

- **Preloading: none.** No warm-up, no prefetch, no next-item buffering exists in the feed path.
  The only accidental buffering is that `windowSize={3}` mounts a few `<Video>` instances,
  each of which begins loading its own source on mount.
- **Disk caching: none in effect.** [videoCacheService.js](newboostraapp/src/services/videoCacheService.js)
  implements exactly the LRU-ish download cache you would want (`getCachedUrl`,
  `downloadVideo`, `cacheNextVideos(videos, currentIndex)` with `PRELOAD_COUNT = 3`) —
  but **`grep` over the whole `src/` tree finds zero imports of it.** It is dead code.
  Note also that its `initialize()` deletes the entire cache directory on every launch, so
  even if it were wired up it would give no cross-session benefit.
- **HTTP caching: none configured.** No `Cache-Control` is set on S3 uploads, and there is
  no CDN, so re-watching a video re-downloads it from Stockholm.

### 3.7 Feed data lifecycle

- `videos`, `page`, `hasNextPage`, `lastScrollIndex` live in Zustand so the feed survives tab
  switches ([store/index.js:76-107](newboostraapp/src/store/index.js#L76-L107)).
- `HomeScreen` reads them with a **bare `useStore()` destructure and no selector**
  ([HomeScreen.jsx:59-73](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L59-L73)),
  i.e. it subscribes to the entire store.
- `appendVideos` concatenates without de-duplication
  ([store/index.js:86-88](newboostraapp/src/store/index.js#L86-L88)).
- `fetchLockRef` guards against overlapping fetches
  ([HomeScreen.jsx:166-168](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L166-L168)).

### 3.8 Related surfaces

- [app/video/[id].jsx](newboostraapp/src/app/video/[id].jsx) reuses `FeedPostItem` in a second
  `FlatList` for the profile-grid → player flow, with its own local `activeVideoId` *and* a
  write into the shared context. It passes `isFocused` as a prop, which `FeedPostItem` ignores.
- [screens/home/components/PostItem.jsx](newboostraapp/src/screens/home/components/PostItem.jsx)
  is a 0-byte file.
- `MOCK_POSTS` is still defined and unused at the top of `HomeScreen`
  ([HomeScreen.jsx:17-44](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L17-L44)).
- Verbose `console.log` calls run per item and per scroll event in release builds
  ([HomeScreen.jsx:130-136, 206](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L130-L136),
  [FeedPostItem.jsx:229-231](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L229-L231),
  plus one per API call in every service).

---

## 4. What approach the current implementation represents

Stated plainly, the current architecture is:

> **Progressive download of a single, untranscoded, unoptimised MP4 straight from an S3
> bucket in one region, started lazily at the moment the item scrolls into view, with no
> poster, no CDN, no prefetch and no disk cache — driven by a `FlatList` whose active-item
> selection and whose play/pause commands come from three competing sources.**

It is the naive baseline. Every layer that TikTok/Reels rely on to hide latency —
faststart-remuxed files, an ABR ladder, an edge cache, an N+1 prefetch window, a persistent
disk cache, and a single authoritative player controller — is either absent or present only
as unused scaffolding (`chunks`/`manifestUrl` in the schema, `VIDEO_QUALITIES` in `.env`,
`AWS_CLOUDFRONT_DOMAIN` as a placeholder, `videoCacheService.js` as dead code).

---

## 5. Observed symptoms mapped to code

| Symptom the user reports | Mechanism in the code |
|---|---|
| Blank/black screen on app launch before first video | 2 s hardcoded splash GIF ([_layout.jsx:37](newboostraapp/src/app/_layout.jsx#L37)) → AsyncStorage → Render round-trip (cold start) → *then* the first MP4 request begins. No prefetch anywhere. |
| Black screen instead of a first frame | `posterUri` is `null` for app-uploaded videos because the thumbnail upload silently fails (§2.6), so nothing covers the buffering player. |
| The next video is sometimes paused after a swipe | During a fast swipe no item clears `itemVisiblePercentThreshold: 50` for `minimumViewTime: 100`, so `onViewableItemsChanged` may not fire at all; `activeVideoId` stays on the old item and the visible one is `isFocused === false`. |
| Sometimes a *different* video starts playing | `viewableItems[0]` is the lowest-index viewable item, not the most-visible one; at a boundary the outgoing item can be picked. Compounded by `snapToInterval`/`getItemLayout` using a stale module-level `Dimensions.get('window').height` while Android edge-to-edge (`edgeToEdgeEnabled: true`) can give the list a different real viewport height, letting scroll offset drift out of phase with item index. |
| Tapping to pause doesn't stick | `expo-av` re-sends `status.shouldPlay = isFocused` to native on **every** render ([Video.js:237-252](newboostraapp/node_modules/expo-av/build/Video.js#L237-L252)); the imperative `pauseAsync()` is overwritten by the next render. The `useEffect` on `[isFocused, isVideoLoaded]` re-asserts `playAsync()` too. |
| Stutter / re-buffer mid-playback | `source={{ uri }}` is a new object each render, so the native source prop is re-set on re-renders; plus 3–5 mounted `<Video>` instances all pull bytes from S3 at once, starving the visible one; plus `VideoThumbnails.getThumbnailAsync` opens a second full download of the *same* file. |
| General jank while scrolling | `FeedPostItem` is a ~1050-line component with **no `React.memo`**, rendered from an **inline arrow `renderItem`**, consuming a context whose `value` object is **recreated every render** ([VideoPlaybackContext.js:23-30](newboostraapp/src/context/VideoPlaybackContext.js#L23-L30)) — and that provider wraps the entire app, so every scroll re-renders the whole navigation tree. `HomeScreen` additionally subscribes to the *whole* Zustand store. |
| Feed items repeating on scroll-to-load | `skip`/`limit` offset pagination over `createdAt: -1` + `appendVideos` with no de-dup. Duplicate `keyExtractor` keys force remounts. |
| Likes always showing as un-liked in For You | `/feed/global` has no auth guard, so `hasLiked` is computed as `false` for everyone (§2.2). |

### Latent runtime bugs found while reading

- `handleFollowToggle()` is called at
  [FeedPostItem.jsx:625](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L625)
  but **is never defined** in that file — pressing the `+` badge on an avatar throws a
  `ReferenceError`. (The defined function is `handleFollow`.)
- `styles.backButton` is referenced at
  [FeedPostItem.jsx:459](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L459)
  but is not present in that file's `StyleSheet`.
- `initialScrollIndex` is set without an `onScrollToIndexFailed` handler
  ([HomeScreen.jsx:341](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L341)).
- `RefreshControl` is attached to a `pagingEnabled` full-screen vertical pager, which fights
  the swipe gesture at the top of the feed.
- No player is ever `unloadAsync()`d; nothing releases decoders explicitly.

---

## 6. File map

**Frontend (feed path)**
```
src/app/_layout.jsx                          root layout, VideoPlaybackProvider, 2s splash
src/app/index.jsx                            auth bootstrap → router.replace('/home')
src/app/home.jsx                             re-export of HomeScreen
src/screens/home/screens/HomeScreen.jsx      feed fetch, mapping, FlatList, viewability
src/screens/home/components/FeedPostItem.jsx player, poster, overlays, actions (~1050 lines)
src/context/VideoPlaybackContext.js          activeVideoId / appState / screenFocus
src/store/index.js                           zustand: videos, page, activeVideoId, ...
src/services/videoService.js                 feed + video CRUD API calls
src/services/videoCacheService.js            DEAD CODE — never imported
src/services/uploadService.js                always POSTs to /upload/video
src/screens/home/screens/UploadScreen.jsx    picker (quality:1), thumbnail, createVideo
src/config/api.config.js                     Render base URL + endpoints
src/app/video/[id].jsx                       second feed surface reusing FeedPostItem
```

**Backend (feed path)**
```
src/modules/feed/feed.controller.ts          GET /feed/global, GET /feed/following
src/modules/feed/feed.service.ts             getGlobalFeed, getFollowingFeed,
                                             getPersonalizedFeed (UNROUTED)
src/modules/video/video.service.ts           create() → processingStatus: READY
src/modules/video/video.controller.ts        video CRUD; no streaming/range endpoint
src/modules/upload/upload.controller.ts      /upload/video (video mimetypes only),
                                             /upload/profile-image, /upload/image
src/modules/upload/upload.service.ts         S3 put + 24h presigned GET URLs
src/database/schemas/video/video.schema.ts   manifestUrl/chunks declared, never written
src/config/env.ts                            AWS_CLOUDFRONT_DOMAIN / VIDEO_QUALITIES getters,
                                             never consumed
src/main.ts                                  helmet, gzip compression (already enabled), CORS
src/app.module.ts                            Throttler; BullMQ (placeholder Redis); no cache
```
