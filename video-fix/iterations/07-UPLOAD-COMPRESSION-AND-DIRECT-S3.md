# Iteration 7 — Media Compression, Upload Limits, Direct-to-S3 & Real Progress

**Status:** 🔨 **implemented 2026-08-22** — every step (7.0, 7.A–7.F) is in the tree and both
codebases build. §15's test plan has **not** been run: it needs a device build and a live
bucket. See the implementation notes at the end of this file before shipping.
**Scope:** mobile (primary) + backend (presign/validation) + one S3 lifecycle rule.
**Opens:** D-50 … D-65.
**Closes / supersedes:** D-47 and D-49 from [00-OVERVIEW.md](00-OVERVIEW.md), and **absorbs
Iteration 5 Phase D** (`05-DELIVERY-CDN-FASTSTART.md` §Phase D).
**Depends on:** Iteration 3 only (`MediaUrlService`, server-authored `videoUrl`). Already shipped.
**Recommended execution slot:** **next — before Iteration 4.** Rationale in §14.

> Everything below was verified by reading the live source in `newboostraapp/` and
> `boost-backend/` on 2026-08-21. Where a claim could not be verified from code it is
> marked **[unverified]** and given a spike task. No compression was assumed to exist; every
> "there is none" statement below is the result of a specific grep or file read, cited.

---

## 0. Executive summary — the five answers

| Question | Answer |
|---|---|
| **Is there image compression?** | **No.** The only lever anywhere is `quality` on the `expo-image-picker` call (`0.8`/`0.9`). That is a JPEG encoder hint applied by the picker, not a size bound, and it is not applied at all on iOS for `.png`/`.bmp` library picks. Nothing measures, resizes, or re-encodes. No `expo-image-manipulator`, no `react-native-compressor`, no `sharp` — verified absent from both `package.json` files and both `node_modules`. |
| **Is there video compression?** | **No — and the one setting that looks like it is a no-op.** [UploadScreen.jsx:58-62](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L58-L62) passes `quality: 0.8` and `videoMaxDuration: 180` to `launchImageLibraryAsync({ mediaTypes: ['videos'] })`. Per the installed type definitions (`expo-image-picker@17.0.11`, `build/ImagePicker.types.d.ts:403-415, 487-494`), `quality` is documented for image compression only, and `videoMaxDuration` is *"Maximum duration, in seconds, for **video recording**"* — it does not bound a library pick. **The exact original file the user selected is what gets uploaded.** |
| **What reaches S3?** | **The original, uncompressed file — for every media type, on every path.** |
| **Do uploads pass through the backend?** | **Yes, 100 % of them.** Four multipart endpoints, all `FileInterceptor`. Video is buffered to `/tmp` on the Render instance ([upload.controller.ts:144](../../src/modules/upload/upload.controller.ts#L144)) then streamed to S3. A presign helper exists but **no route exposes it** ([upload.service.ts:100-133](../../src/modules/upload/upload.service.ts#L100-L133) — dead code). |
| **Is upload progress real?** | **Half real.** The video body's bytes are genuinely tracked via `expo-file-system`'s `createUploadTask` ([uploadService.js:46-51](../../../newboostraapp/src/services/uploadService.js#L46-L51)). But the screen then overwrites that real number with two fabricated steps — `95` and `100` — so the bar visibly goes **100 → 95 → 100**. Images/thumbnails/avatars have **no progress at all**. |

**Two limits questions answered up front:**

- The **250 MB** figure exists nowhere in the code. Both video constants are **500 MB**
  ([upload.controller.ts:145](../../src/modules/upload/upload.controller.ts#L145),
  [upload.service.ts:27](../../src/modules/upload/upload.service.ts#L27)).
- **Mobile enforces no size limit of any kind.** `grep -rn "1024\|fileSize\|MAX_.*SIZE" newboostraapp/src`
  returns **zero matches**. The limit exists in exactly one layer, and it is the wrong one
  (see §3).

> ### ✅ Video limit — decided
> The brief originally carried two figures (250 MB in §3, 50 MB in §5/§12). **Resolved on
> 2026-08-21: the input limit is 250 MB, and a 250 MB input is still compressed.** The
> 50 MB figure is dropped entirely — it is neither an input gate nor an output ceiling.
>
> ```
> pick (≤ 250 MB, ≤ 180 s)  →  ALWAYS compress  →  ≤ 100 MB PUT to S3
>                                                  (typical 30–60 s clip: 13–27 MB)
> ```
>
> The 100 MB figure is not a product choice; it is the worst case the encode settings in
> §9.2 can produce at the 180 s duration cap, plus headroom for VBR overshoot. It exists so
> the presign endpoint and S3 have a number to enforce, not as a target. Every constant in
> this document is written against this decision — see §12.1.

---

## 1. Current image upload architecture

### 1.1 The four image entry points

| # | Surface | File | Picker options | Service call | Endpoint | S3 prefix |
|---|---|---|---|---|---|---|
| 1 | Video cover, at publish | [UploadScreen.jsx:85-90](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L85-L90) | `allowsEditing`, `aspect:[9,16]`, `quality: 0.9` | `uploadService.uploadThumbnail` | `POST /upload/thumbnail` | `thumbnails/{userId}/` |
| 2 | Video cover, on edit | [FeedPostItem.jsx:149-154](../../../newboostraapp/src/screens/home/components/FeedPostItem.jsx#L149-L154) | `allowsEditing`, `aspect:[9,16]`, `quality: 0.9` | `uploadService.uploadThumbnail` | `POST /upload/thumbnail` | `thumbnails/{userId}/` |
| 3 | Profile photo (×2 screens) | [EditProfileScreen.jsx:184-208](../../../newboostraapp/src/screens/home/screens/EditProfileScreen.jsx#L184-L208), [SettingsScreen.jsx:157-181](../../../newboostraapp/src/screens/home/screens/SettingsScreen.jsx#L157-L181) | `allowsEditing`, `aspect:[1,1]`, `quality: 0.8` | `uploadService.uploadProfileImage` | `POST /upload/profile-image` | `profiles/{userId}/` |
| 4 | Chat attachment | [chat/[id].jsx:339-343](../../../newboostraapp/src/app/chat/[id].jsx#L339-L343) | `allowsEditing`, `quality: 0.8` | `uploadService.uploadChatImage` | `POST /upload/image` | `profiles/{userId}/` ← **mislabelled** |

There is also an auto-generated cover: `VideoThumbnails.getThumbnailAsync(videoAsset.uri, { time: 500 })`
([UploadScreen.jsx:69](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L69) and
[:140](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L140)). It writes a
PNG/JPEG to the cache directory at **the video's native resolution** — for a 4K source that
is a multi-megabyte still — and that file goes to `/upload/thumbnail` untouched.

### 1.2 Exact flow

```
User taps "Pick"
  └─ ImagePicker.launchImageLibraryAsync({ quality: 0.8 | 0.9 })
       → asset { uri, width, height, fileSize?, mimeType? }
       → fileSize is RETURNED but READ BY NOTHING          ← D-50
  └─ (no validation, no resize, no re-encode, no size check) ← D-51
  └─ uploadService.upload{Thumbnail|ProfileImage|ChatImage}(uri)
       → expo-file-system `uploadAsync`, MULTIPART, field "file"
       → no progress callback                              ← D-58
       → no cancel token, no retry, no timeout             ← D-57
  └─ POST {BASE_URL}/upload/{thumbnail|profile-image|image}
       → JwtAuthGuard
       → FileInterceptor(memoryStorage, limits.fileSize = 10 MB,
                         fileFilter mimetype.startsWith('image/'))
       → UploadService.uploadFile(userId, type, file)
            → validateFileSize(type, file.size)   (10 MB, again)
            → generateS3Key → `{prefix}/{userId}/{ts}-{uuid}.{ext}`
            → PutObjectCommand { Body: file.buffer,
                                 ContentType: file.mimetype,
                                 CacheControl: 'public, max-age=31536000, immutable' }
            → returns getPublicUrl(key)   (absolute S3 URL, NOT presigned — correct)
  └─ Response { success, url, key }
  └─ Mobile persists:
       cover   → CreateVideoDto.thumbnailUrl + thumbnailKey → videos collection
       profile → PATCH /users/me/profile-image → users.profileImage
                 (…and /upload/profile-image ALSO writes it directly — see D-55)
       chat    → socket 'sendMessage' { image: url } → messages.image
```

**Relevant code:**
[upload.controller.ts:27-139](../../src/modules/upload/upload.controller.ts#L27-L139) ·
[upload.service.ts:200-258](../../src/modules/upload/upload.service.ts#L200-L258) ·
[uploadService.js:102-264](../../../newboostraapp/src/services/uploadService.js#L102-L264) ·
[create-video.dto.ts](../../src/modules/video/dto/create-video.dto.ts) ·
[users.controller.ts:46-53](../../src/modules/users/users.controller.ts#L46-L53)

### 1.3 What actually lands in S3

The unmodified bytes the picker produced. For a modern phone camera roll pick that is
typically **2–8 MB** at 3024×4032; a screenshot-heavy user or an HEIC→JPEG transcode can
exceed that. The 10 MB multer cap is the only thing between the camera roll and the bucket,
and it rejects rather than shrinks: a user with a 12 MB photo gets a **400**, not a
compressed upload.

---

## 2. Current video upload architecture

### 2.1 Exact flow

```
UploadScreen.pickVideo()                       ← UploadScreen.jsx:51-75
  └─ ImagePicker.launchImageLibraryAsync({
         mediaTypes: ['videos'],
         quality: 0.8,          ← NO-OP for video (images only)      ← D-52
         videoMaxDuration: 180, ← NO-OP for library picks (recording only)
     })
  └─ setSelectedVideo(asset)     // asset.fileSize never read       ← D-50
  └─ VideoThumbnails.getThumbnailAsync(asset.uri, { time: 500 })
         → full-resolution still into the cache dir

UploadScreen.handlePublish()                   ← UploadScreen.jsx:111-192
  └─ (no size check, no duration check, no resolution check)
  └─ uploadService.uploadFile(selectedVideo.uri, onProgress)
       └─ createUploadTask(`{BASE}/upload/video`, uri, MULTIPART, Bearer)
             progress = totalBytesSent / totalBytesExpectedToSend   ← REAL
       └─ POST /upload/video
             FileInterceptor(diskStorage({ destination: '/tmp' }),
                             limits.fileSize = 500 MB,
                             fileFilter mimetype.startsWith('video/'))
             ↳ ENTIRE FILE WRITTEN TO THE RENDER INSTANCE'S DISK    ← D-54 (=D-47)
             ↳ UploadService.uploadFile → validateFileSize(500 MB)  ← after the fact, D-61
             ↳ PutObjectCommand { Body: fs.createReadStream('/tmp/…'),
                                  ContentLength: file.size,
                                  ContentType: 'video/mp4',
                                  CacheControl: immutable }
             ↳ returns a 24 h PRESIGNED download URL (unused)       ← D-63
             ↳ finally: fs.unlinkSync(file.path)
  └─ setUploadProgress(95)   ← FABRICATED, and it goes BACKWARDS    ← D-56
  └─ uploadService.uploadThumbnail(localCoverUri)   // no progress
  └─ setUploadProgress(100)  ← FABRICATED
  └─ videoService.createVideo({ title, description, rawVideoKey,
                                thumbnailUrl, thumbnailKey, duration, tags })
       └─ POST /videos → VideoService.create
             processingStatus: READY, processingProgress: 100  (constants)
```

**Relevant code:**
[UploadScreen.jsx:51-192](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L51-L192) ·
[uploadService.js:17-95](../../../newboostraapp/src/services/uploadService.js#L17-L95) ·
[upload.controller.ts:141-170](../../src/modules/upload/upload.controller.ts#L141-L170) ·
[upload.service.ts:200-258](../../src/modules/upload/upload.service.ts#L200-L258) ·
[video.service.ts:32-65](../../src/modules/video/video.service.ts#L32-L65)

### 2.2 What actually lands in S3

The **camera-roll original**. A 60-second 4K/60 clip from a recent iPhone is ~400 MB — above
the 500 MB cap only by luck. A 1080p/30 clip is ~10 MB/minute. Nothing normalises
resolution, frame rate, bitrate, codec (HEVC originals are stored as-is and served to
players that may not decode them), or container layout (`moov` atom stays at the tail —
see Iteration 5 §2.3).

---

## 3. Current upload limits — where they are, and where they are not

| Limit | Value | Location | Layer |
|---|---|---|---|
| Video, multer | **500 MB** | [upload.controller.ts:145](../../src/modules/upload/upload.controller.ts#L145) | Backend |
| Video, service | **500 MB** | [upload.service.ts:27](../../src/modules/upload/upload.service.ts#L27) `MAX_VIDEO_SIZE` | Backend |
| Image, multer ×3 | **10 MB** | [:31](../../src/modules/upload/upload.controller.ts#L31), [:75](../../src/modules/upload/upload.controller.ts#L75), [:112](../../src/modules/upload/upload.controller.ts#L112) | Backend |
| Image, service | **10 MB** | [upload.service.ts:28](../../src/modules/upload/upload.service.ts#L28) `MAX_IMAGE_SIZE` | Backend |
| JSON / urlencoded body | 10 MB | [main.ts:76-77](../../src/main.ts#L76-L77) | Backend (does **not** apply to multipart) |
| MIME allow-list | `image/*` / `video/*` | controller `fileFilter`s | Backend |
| **Any client-side limit** | **— none —** | — | **Mobile: absent** |

### 3.1 Conflicts and dead settings found

| ID | Finding |
|---|---|
| **D-53** | Intended video **input** cap is 250 MB (decided — §0); code says **500 MB** in two constants. Nothing in the repo mentions 250. |
| **D-50** | Mobile has **zero** size validation. `asset.fileSize` is returned by the picker (`ImagePicker.types.d.ts:274`) and read nowhere. A user on 4G discovers the 500 MB cap after uploading 500 MB. |
| **D-52** | `quality: 0.8` on the **video** pick is inert. `videoMaxDuration: 180` on a **library** pick is inert. Iteration 5 §2.3 states these "capped" the source — that claim is **incorrect** and should be struck when this iteration lands. |
| **D-61** | Both backend caps are enforced *after* the body has been received. Multer's `limits.fileSize` aborts mid-stream, so the instance has already accepted and written up to 500 MB to `/tmp` before rejecting. `validateFileSize` then runs on an already-complete file. |
| — | `API_CONFIG.TIMEOUT = 60000` ([api.config.js:7](../../../newboostraapp/src/config/api.config.js#L7)) applies to the **axios** client only. The `expo-file-system` upload path does not use axios and therefore has **no timeout at all** — a stalled upload hangs forever. |

---

## 4. Current S3 upload mechanism, and what the bucket holds

**Mechanism:** server-side `PutObjectCommand` via `@aws-sdk/client-s3`, credentials from
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Single PUT, no multipart, no transfer manager.
`ACL` is not set on `uploadFile` (only on the dead presign helper, which sets
`ACL: 'public-read'`), so objects rely on a **public-read bucket policy** — consistent with
Constraint #7 in the overview.

**Key layout** ([upload.service.ts:138-153](../../src/modules/upload/upload.service.ts#L138-L153)):

```
videos/{userId}/{timestamp}-{uuid}.{ext}
thumbnails/{userId}/{timestamp}-{uuid}.{ext}
profiles/{userId}/{timestamp}-{uuid}.{ext}     ← chat attachments land here too (D-62)
uploads/{userId}/{timestamp}-{uuid}.{ext}      ← unreachable; no UploadType maps here
```

**Bucket / CDN state** (`boost-backend/.env:18-25`):

```
AWS_REGION=eu-north-1
AWS_S3_BUCKET=boostme-storage-dev          # prod value commented out on line 21
AWS_CLOUDFRONT_DOMAIN=d37o15qkd7x4po.cloudfront.net
```

So **Iteration 5 Phase A appears to have been performed at least in this environment** — the
placeholder is gone and `MediaUrlService` will now emit CloudFront hosts. The mobile
fallback constant in [media.js:4-7](../../../newboostraapp/src/utils/media.js#L4-L7) points at
the same distribution.

> Housekeeping, outside this iteration's scope: `.env` is correctly gitignored (verified —
> `git ls-files .env` returns nothing), but it holds live keys for both dev and, commented
> inline, prod. If that file has ever been shared or pasted anywhere, rotate both pairs.

**What the bucket therefore currently contains:** camera-roll original videos at whatever
resolution/bitrate/codec the device produced, full-resolution auto-generated cover stills,
and uncompressed picker-quality JPEGs. **Nothing in the bucket has been optimised for
delivery.** This is precisely the state the brief's §8 rule forbids.

---

## 5. Current upload-progress implementation — traced

**The one real measurement.** [uploadService.js:34-53](../../../newboostraapp/src/services/uploadService.js#L34-L53):

```js
const task = createUploadTask(url, uri, { …MULTIPART… }, (data) => {
    const totalExpected = data.totalBytesExpectedToSend || 1;
    const sent          = data.totalBytesSent || 0;
    onProgress(Math.min(100, Math.max(0, Math.round((sent / totalExpected) * 100))));
});
result = await task.uploadAsync();
```

This is **genuine bytes-sent / bytes-total**, reported by the native `URLSession` /
`OkHttp` upload task. It is the right primitive. Three problems sit on top of it:

| ID | Problem |
|---|---|
| **D-56** | [UploadScreen.jsx:132](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L132) sets `95` *after* the callback has already reported `100`, then [:162](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L162) sets `100` again. The bar runs **0 → 100 → 95 → 100**. The two tail steps are fabricated: the cover upload and the `POST /videos` call have no measurement behind them. |
| **D-58** | `uploadThumbnail`, `uploadProfileImage`, `uploadChatImage` all use plain `uploadAsync` with **no** progress callback ([uploadService.js:112](../../../newboostraapp/src/services/uploadService.js#L112), [:160](../../../newboostraapp/src/services/uploadService.js#L160), [:229](../../../newboostraapp/src/services/uploadService.js#L229)). |
| — | The reported 100 % is *bytes handed to Render*, not *bytes in S3*. The Render→S3 leg is invisible, so the bar sits at 100 % (then 95 %) while the second transfer runs. |

**Cancellation / retry / failure / timeout / backgrounding / duplicates — current state:**

`grep -rn "retry\|abort\|cancelAsync\|AbortController\|AppState" newboostraapp/src/services newboostraapp/src/screens/home/screens/UploadScreen.jsx`
returns **zero matches**. Concretely:

| Concern | Today |
|---|---|
| Cancel | Impossible. `task` is a local, never stored; `UploadTask.cancelAsync()` exists (`expo-file-system/build/legacy/FileSystem.d.ts:172`) and is never called. No cancel button. |
| Retry | None. One failure → `showApiErrorModal`, all state reset, user re-picks the video and re-uploads from zero. |
| Failure | Errors are returned as `{ success: false }` objects; `handlePublish` throws and the `finally` resets progress. No partial-state recovery. |
| Timeout | None on this path (see §3.1). |
| Network interruption | Surfaces as a generic catch. No resume, no range restart. |
| Backgrounding | Unhandled. iOS suspends the `URLSession` task; on return the promise typically rejects and everything is lost. |
| Duplicate uploads | The Publish button is `disabled` while `isUploading` ([UploadScreen.jsx:376](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L376)) — that covers double-tap. But if `POST /videos` fails *after* the S3 PUT succeeded, the object is **orphaned in the bucket forever** with no row referencing it, and the retry uploads a second copy (**D-64**). |

---

## 6. Current delivery / loading flow

### 6.1 Videos

| Aspect | Current |
|---|---|
| URL source | Server-authored. `present()` → `this.mediaUrl.toUrl(video.rawVideoKey)` ([feed.service.ts:72](../../src/modules/feed/feed.service.ts#L72)); same in `VideoService.findOne` ([video.service.ts:179](../../src/modules/video/video.service.ts#L179)). |
| Host | CloudFront (`d37o15qkd7x4po.cloudfront.net`) via `MediaUrlService`. Absolute legacy S3 URLs are rewritten onto it ([media-url.service.ts:31-36](../../src/common/services/media-url.service.ts#L31-L36)). |
| Signing | **None** — public objects. Correct for a public feed. |
| Client | `toMediaUrl(video.videoUrl \|\| video.rawVideoKey)` ([HomeScreen.jsx:41](../../../newboostraapp/src/screens/home/screens/HomeScreen.jsx#L41)) — a pass-through for absolute URLs. |
| Player | `expo-av` `<Video source={videoSource} resizeMode="cover" isLooping progressUpdateIntervalMillis={1000} usePoster={false}>` ([FeedPostItem.jsx:527-541](../../../newboostraapp/src/screens/home/components/FeedPostItem.jsx#L527-L541)). |
| Streaming | Progressive MP4 over HTTP range requests. No HLS, no ABR, no `faststart`. `manifestUrl`/`chunks` in the schema are unwritten scaffolding. |
| Preload | None (D-37 open). `videoCacheService.js` is still imported by nothing — re-verified: `grep -rn videoCacheService src/` matches only its own definition and default export. Iteration 4 not started. |
| Disk cache | Whatever `expo-av` / the platform does implicitly. Nothing app-managed. |
| Poster | `FeedPoster` — real cover if present, else a deterministic gradient from `hueForId` ([FeedPoster.jsx](../../../newboostraapp/src/screens/home/components/FeedPoster.jsx)). |

### 6.2 Images

| Aspect | Current |
|---|---|
| Covers in the feed | `mediaUrl.toUrl(thumbnailKey \|\| thumbnailUrl)` → CloudFront ([feed.service.ts:73](../../src/modules/feed/feed.service.ts#L73)), then `toPosterUrl` client-side rejects any URL ending in a video extension. |
| **Avatars** | **Bypass the CDN.** `USER_PROJECTION` is `'firstName lastName username profileImage'` ([feed.service.ts:28-29](../../src/modules/feed/feed.service.ts#L28-L29)) and `present()` passes `video.user` through **unmodified** — `profileImage` is never run through `mediaUrl.toUrl`. Since it is stored as an absolute `…s3.{region}.amazonaws.com/…` URL by `getPublicUrl`, every avatar in the feed is a direct origin fetch. (**D-60**) |
| Renderer | React Native core `<Image>`. `expo-image` is **not installed** — no `cachePolicy`, no `recyclingKey`, no explicit memory/disk cache control. |
| Caching | Only RN's default `NSURLCache` / Fresco behaviour. `Image.prefetch` is used to warm the next two posters ([HomeScreen.jsx:126-130](../../../newboostraapp/src/screens/home/screens/HomeScreen.jsx#L126-L130)). |
| Resizing / variants | **None.** There is no thumbnail service, no `?w=` transform, no responsive variants. A 4 MB full-resolution cover is downloaded in full to paint a 130×190 preview box and a full-screen poster alike. |
| Chat images | `resolveImageUrl(currentMessage.image)` → core `<Image>` ([chat/[id].jsx:392-412](../../../newboostraapp/src/app/chat/[id].jsx#L392-L412)). Same story. |

### 6.3 Performance impact attributable to the current upload/storage format

1. **Poster paint is gated on a multi-megabyte JPEG.** The auto-cover is extracted at the
   video's native resolution. On a 4K source that is a ~3–6 MB still fetched before the
   gradient can be replaced — on a swipe-fast feed it frequently loses the race entirely,
   which reads to the user as "the thumbnail never loads".
2. **Every swipe pulls an un-normalised original.** No bitrate ceiling means a single
   high-bitrate 4K clip can be 8–10× the bytes of a visually equivalent 1080p encode, at
   identical perceived quality on a phone screen.
3. **No `faststart` ⇒ an extra round trip before the first frame** (Iteration 5 §2.3),
   and that penalty scales with file size because the `moov` atom sits at the tail.
4. **Iteration 4's disk cache is not viable at current file sizes.** An LRU cache sized for
   a phone (a few hundred MB) holds ~4 originals but ~40 compressed clips. Compression is
   effectively a prerequisite for the cache being worth building.
5. **Upload wall-clock is doubled** by the proxy hop (phone→Render, then Render→S3), on top
   of transferring bytes that should never have been transferred.
6. **Render instance risk.** Concurrent large uploads contend for one instance's disk,
   bandwidth and worker pool. `/tmp` exhaustion is a plausible outage mode.

---

## 7. New defect register

### Compression & validation

| ID | Defect | Location |
|---|---|---|
| D-50 | No client-side size/duration/resolution validation on any media path; `asset.fileSize` is returned and never read | all 5 picker call sites |
| D-51 | No image compression anywhere. `quality` is an encoder hint, not a bound; no resize, no measure, no re-encode | — |
| D-52 | No video compression. `quality: 0.8` and `videoMaxDuration: 180` on a library video pick are **both no-ops** | [UploadScreen.jsx:58-62](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L58-L62) |
| D-53 | Video cap is 500 MB in two constants; intended input cap is 250 MB with a 100 MB post-compression upload ceiling (§12.1) | [upload.controller.ts:145](../../src/modules/upload/upload.controller.ts#L145), [upload.service.ts:27](../../src/modules/upload/upload.service.ts#L27) |
| D-61 | Size caps are enforced only after the body has been received and written to disk | multer config, `validateFileSize` |

### Architecture

| ID | Defect | Location |
|---|---|---|
| D-54 | Every media byte proxies through the API instance; video is buffered to `/tmp` (restates D-47, still open) | [upload.controller.ts:144](../../src/modules/upload/upload.controller.ts#L144) |
| D-59 | `generateProfileImageUploadUrl` is a complete presign implementation that **no controller exposes** — dead code | [upload.service.ts:100-133](../../src/modules/upload/upload.service.ts#L100-L133) |
| D-62 | Chat attachments are uploaded as `UploadType.PROFILE_IMAGE` and therefore keyed under `profiles/` | [upload.controller.ts:95-99](../../src/modules/upload/upload.controller.ts#L95-L99) |
| D-63 | `POST /upload/video` returns a 24 h **presigned** `url` that nothing consumes; if a client ever persisted it, it would die in 24 h (the D-20 failure mode, still latent) | [upload.service.ts:232-236](../../src/modules/upload/upload.service.ts#L232-L236) |
| D-65 | **`CreateVideoDto.rawVideoKey` is an unvalidated client-supplied string.** Nothing checks it begins with `videos/{callerId}/`, and nothing checks the object exists. A user can publish a row pointing at **another user's** S3 key, or at a key that does not exist. This becomes materially more exploitable once presigned direct upload lands. | [create-video.dto.ts:43-46](../../src/modules/video/dto/create-video.dto.ts#L43-L46), [video.service.ts:46-64](../../src/modules/video/video.service.ts#L46-L64) |

### Progress, lifecycle & correctness

| ID | Defect | Location |
|---|---|---|
| D-55 | **`uploadChatImage`'s failure fallback silently replaces the user's profile picture.** On any non-2xx *or* any thrown error it calls `this.uploadProfileImage(fileUri)`, which POSTs to `/upload/profile-image` — and that controller **writes `user.profileImage` server-side**. A failed chat attachment therefore becomes the user's new avatar. | [uploadService.js:256-263](../../../newboostraapp/src/services/uploadService.js#L256-L263) → [upload.controller.ts:59-61](../../src/modules/upload/upload.controller.ts#L59-L61) |
| D-56 | Real byte progress is overwritten with fabricated `95`/`100` steps; the bar regresses 100 → 95 | [UploadScreen.jsx:132](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L132), [:162](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L162) |
| D-57 | No cancel, retry, timeout, stall detection, or `AppState` handling on any upload path | `uploadService.js`, `UploadScreen.jsx` |
| D-58 | Image uploads report no progress at all | [uploadService.js:112](../../../newboostraapp/src/services/uploadService.js#L112), [:160](../../../newboostraapp/src/services/uploadService.js#L160), [:229](../../../newboostraapp/src/services/uploadService.js#L229) |
| D-60 | `user.profileImage` is not passed through `MediaUrlService`, so avatars bypass CloudFront | [feed.service.ts:56-80](../../src/modules/feed/feed.service.ts#L56-L80) |
| D-64 | A `POST /videos` failure after a successful S3 PUT orphans the object; retry uploads a duplicate | [UploadScreen.jsx:168-180](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L168-L180) |

> **D-55 is the one item here that is a live user-facing bug rather than an optimisation.**
> It is a ~10-line fix (delete the fallback, or point it at `/upload/image`'s retry) and is
> worth shipping as a standalone hotfix ahead of everything else in this document.

---

## 8. Recommended image compression architecture

### 8.1 Library choice — after checking the stack

| Candidate | Verdict |
|---|---|
| **`expo-image-manipulator`** | ✅ **Recommended.** First-party Expo module, matches the existing `expo-*` stack, no config plugin, works under the app's prebuild workflow (`ios/` and `android/` directories are checked in) and New Architecture (`app.json: newArchEnabled: true`). Does resize + JPEG re-encode at a chosen quality. Install the version pinned to SDK 54 via `npx expo install expo-image-manipulator`. |
| `react-native-compressor`'s `Image.compress` | Viable, but a second native dependency for something the Expo module already covers. Prefer it only if it is being added for video anyway *and* the manipulator proves insufficient. |
| Server-side `sharp` | ❌ Rejected. It requires the original to reach the server, which is exactly what the brief forbids. |
| Picker `quality` alone | ❌ Already the status quo, and it demonstrably does not bound size. |

> **[unverified]** `expo-image-manipulator` is not currently installed, so its exact SDK-54
> surface could not be read from `node_modules`. Recent versions expose a context API
> (`ImageManipulator.manipulate(uri).resize(…).renderAsync()` → `.saveAsync({ compress, format })`)
> alongside the legacy `manipulateAsync`. **Spike S-7.1** below pins the exact call shape
> before any screen code is written.

### 8.2 Targets

Chosen from what each image is actually used for, not from a single global number. All are
comfortably inside the brief's **< 1 MB** ceiling.

| Asset | Max long edge | JPEG quality | Target | Hard ceiling | Rationale |
|---|---|---|---|---|---|
| Video cover / thumbnail | **1280 px** | 0.75 | ≤ 400 KB | 1 MB | Painted full-screen behind the player and at 130×190 in previews. 1280 on the long edge covers a 3× 428 pt screen. |
| Profile photo | **512 px** (square) | 0.80 | ≤ 150 KB | 1 MB | Largest render is a ~96 pt avatar. 512 is already generous. |
| Chat attachment | **1600 px** | 0.75 | ≤ 700 KB | 1 MB | Opened full-screen in the preview modal, so it needs more detail than a cover. |

### 8.3 Algorithm

New file: `newboostraapp/src/utils/mediaCompression.js`

```
compressImage(uri, preset) →
  1. size = (await FileSystem.getInfoAsync(uri, { size: true })).size
     if size > MAX_IMAGE_INPUT_BYTES (10 MB) → reject with a user-facing message   ← the client-side gate
  2. resize to preset.maxEdge (preserve aspect; never upscale)
  3. encode JPEG at preset.quality
  4. measure. while (size > preset.targetBytes && attempts < 4):
         quality -= 0.10   (floor 0.50)
         if quality is at the floor: maxEdge *= 0.8
         re-encode, re-measure
  5. if still > HARD_CEILING (1 MB) → reject with "This image can't be optimised" (never upload)
  6. return { uri, width, height, bytes, attempts }
```

**Why an iterative loop rather than one pass.** JPEG size at a fixed quality varies by an
order of magnitude with image content (a flat gradient vs. foliage). A single
`{ maxEdge, quality }` pair cannot guarantee "< 1 MB"; measure-and-retry can, and converges
in one pass for the overwhelming majority of inputs.

**Always strip EXIF.** `expo-image-manipulator` drops EXIF on re-encode by default — that is
a privacy win (GPS coordinates currently reach S3 on every upload) and a few KB saved.

### 8.4 Wiring

One helper, called at **all four** image entry points, immediately after the picker returns
and before any `uploadService` call:

| Call site | Preset |
|---|---|
| [UploadScreen.jsx:92-95](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L92-L95) (custom cover) | `COVER` |
| [UploadScreen.jsx:69](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L69) & [:140](../../../newboostraapp/src/screens/home/screens/UploadScreen.jsx#L140) (auto cover from `VideoThumbnails`) | `COVER` ← **do not skip this one**; the auto-generated still is often the largest image in the whole flow |
| [FeedPostItem.jsx:156-159](../../../newboostraapp/src/screens/home/components/FeedPostItem.jsx#L156-L159) (cover on edit) | `COVER` |
| [EditProfileScreen.jsx:190-193, 210-213](../../../newboostraapp/src/screens/home/screens/EditProfileScreen.jsx#L190-L213) and [SettingsScreen.jsx:163-166, 182-185](../../../newboostraapp/src/screens/home/screens/SettingsScreen.jsx#L163-L185) | `AVATAR` |
| [chat/[id].jsx:345-346](../../../newboostraapp/src/app/chat/[id].jsx#L345-L346) | `CHAT` |

Because compression happens before the upload call, **the original never leaves the device** —
which is the brief's §4 requirement, satisfied without any backend change.

---

## 9. Recommended video compression architecture

### 9.1 Library choice — after checking the stack

| Candidate | Verdict |
|---|---|
| **`react-native-compressor`** | ✅ **Recommended, behind a spike.** It is the only maintained RN library that does on-device H.264 transcode via the platform encoders (`AVAssetExportSession` / `MediaCodec`), exposes `Video.compress(uri, options, onProgress)`, a `cancelCompression(uuid)`, and `getVideoMetaData`. The app is a **prebuild** project (`ios/`, `android/` checked in), so a native dependency is a rebuild, not a workflow change. |
| `ffmpeg-kit-react-native` | ❌ **Do not use.** The project was retired by its maintainer in early 2025 and the prebuilt binaries were withdrawn from the public repositories. Adopting it now means vendoring binaries and owning them. |
| `react-native-video-processing` | ❌ Effectively unmaintained; no New Architecture story. |
| Expo first-party | ❌ There is no Expo video transcoding module. `expo-video-thumbnails` (installed) extracts stills only. |
| **Server-side only** (Iteration 5 Phase C) | ✅ **Keep as the guaranteed backstop.** See §9.4. |

> **[unverified] — Spike S-7.2.** `react-native-compressor`'s New Architecture support could
> not be verified from this repo (the package is not installed). `app.json` sets
> `newArchEnabled: true`. The spike must confirm it builds and runs on both platforms under
> New Arch **before** any of §9.2 is committed to. If it fails, §9.4's fallback applies and
> the rest of this iteration ships unchanged.

### 9.2 Recommended production settings

Derived from what this app actually is: **short, full-screen, portrait clips watched on a
phone**, never on a TV, never scrubbed frame-accurately.

| Parameter | Recommended | Why, for this app |
|---|---|---|
| Max resolution | **1080 × 1920** (cap the long edge at 1920, preserve aspect) | The feed renders `resizeMode="cover"` at device height. Above 1080p is bytes the panel cannot show. |
| Video codec | **H.264, High profile, level 4.0** | Universally decodable by `expo-av` today and `expo-video` after Iteration 6. HEVC halves the size but breaks on parts of the Android install base — not worth it while there is no ABR fallback. |
| Bitrate | **3.5 Mbps @ 1080p**, 2.0 Mbps @ 720p (VBR, cap ≈ 1.5× target) | ~26 MB/minute at 1080p. Visually transparent for phone-shot content at phone viewing distance. |
| Frame rate | **cap at 30 fps** (pass 24/25 through untouched; downsample 60 → 30) | Halves the bitrate needed for the same perceived quality. 60 fps buys nothing in a scroll feed. |
| Keyframe interval | **2 s** | Cheap seeking, and it is what an HLS ladder needs if Iteration 6 Stage 3 ever happens. |
| Audio | **AAC-LC, 128 kbps, 44.1 kHz, stereo** | Standard; ~1 MB/minute. |
| Container | **MP4, `faststart`** | Whether the on-device encoder emits a leading `moov` is platform-dependent — **do not assume it.** Iteration 5 Phase C's `-c copy -movflags +faststart` remux stays in the plan as the guarantee. |
| Skip-if-already-small | **skip compression when `bytes ≤ 8 MB` AND `height ≤ 1080` AND `fps ≤ 30`** | Re-encoding an already-small clip costs time and *loses* quality for no size win. |
| Duration | **enforce ≤ 180 s client-side** from `asset.duration` | The intent already exists in the code as an inert option (D-52); this makes it real, and it bounds worst-case compression time. |

**Expected output**, at 3.5 Mbps video + 128 kbps audio ≈ 3.63 Mbps ≈ **27 MB per minute**:

| Source | Compressed output | vs. a 250 MB input |
|---|---|---|
| 15 s clip | ~7 MB | |
| 30 s clip | ~14 MB | |
| 60 s clip | ~27 MB | |
| 120 s clip | ~54 MB | |
| **180 s (the duration cap)** | **~82 MB** | **worst case** |

`MAX_VIDEO_UPLOAD_BYTES` is therefore set to **100 MB** (§12.1) — the 180 s worst case plus
headroom for VBR overshoot on high-motion content. It is a **backstop, not a target**: the
median clip in a highlights app is 15–45 s, i.e. 7–20 MB.

**A 250 MB input is always compressed**, including one that is already H.264/1080p/30 — the
skip rule only fires below 8 MB, so a large file can never bypass the encode. A 250 MB source
is, by construction, either long, high-bitrate, 4K, or 60 fps; all four are exactly what the
settings above normalise.

**Second-pass rule.** If the first-pass output still exceeds `MAX_VIDEO_UPLOAD_BYTES`
(pathological high-entropy source), re-encode once at **720p / 2.0 Mbps** rather than
rejecting. That yields ≈ 48 MB at the 180 s cap and always fits. Only if *that* fails does
the user see an error — so nobody is told "no" after waiting through a compression.

### 9.3 Compression time and device performance

On-device transcode with the hardware encoder runs roughly **0.2–0.6 × realtime** on
current mid-to-high-end devices, worse on old Android. Budget accordingly:

- A 60 s clip → ~15–40 s of compression. **This is the dominant cost in the whole flow** and
  must be represented honestly in the progress bar (§11), not hidden behind a spinner.
- Hold `expo-keep-awake` for the duration; a screen lock mid-transcode kills the job.
- Compress **once**, write to the cache directory, and key the result so a retry re-uses it
  rather than re-transcoding (§13).
- Show elapsed/estimated time and a **Cancel** button. A user staring at an unexplained
  40-second freeze will kill the app.

### 9.4 The backstop — why server-side transcode stays in the plan

Client-side compression is an **optimisation, never an enforcement point**. A patched
client, an old build, or a spike-failure on one platform all put an un-normalised original
in front of the presign endpoint. Therefore:

1. The **presign endpoint enforces the byte ceiling** (§12.2). That is the real gate.
2. **Iteration 5 Phase C stays exactly as written.** Its `-c copy -movflags +faststart` remux
   is still needed (client encoders do not reliably emit faststart), its ffprobe pass gives
   the server a *trusted* duration to correct the client-supplied `CreateVideoDto.duration`,
   and its `needsTranscode` gate becomes a rarely-taken path instead of the common one —
   which makes Phase C's disk/CPU risk profile dramatically better.
3. This is the direct answer to the brief's §5 concern about balancing quality: **the client
   picks a good encode, the server guarantees a playable container, and neither is trusted
   to do the other's job.**

---

## 10. Recommended direct-to-S3 architecture

### 10.1 Is it already implemented? No.

`getSignedUrl` is imported and used twice: once for **download** URLs
([upload.service.ts:79](../../src/modules/upload/upload.service.ts#L79)) and once inside
`generateProfileImageUploadUrl` ([:124](../../src/modules/upload/upload.service.ts#L124)) —
which **no controller calls** (D-59). There is no `@Post('presign')`, no `confirm` route
(`ConfirmUploadDto` exists and is referenced by nothing), and the mobile app has no code path
that PUTs to S3. **100 % of uploads proxy through the API today.**

### 10.2 Should we move to it? Yes — and this iteration owns it.

Iteration 5 Phase D already specifies this and marks it *"optional, separable"*. **That
classification should change.** Once the client compresses, the proxy hop is pure cost with
no remaining benefit: it doubles wall-clock, occupies a Render worker and its disk for the
duration, and buys no validation the presign endpoint cannot do more cheaply from
`fileSize`. This iteration takes Phase D over, makes it mandatory, and fixes two defects in
the plan as written (§10.4).

### 10.3 Target architecture

```
Mobile                              Backend                       S3
──────                              ───────                       ──
pick → validate (§12.1)
     → compress (§8 / §9)
     → measure compressed bytes
                    ──POST /upload/presign──▶  JwtAuthGuard
                       { type, fileName,       validate size vs type ceiling
                         contentType,          key = {prefix}/{userId}/{ts}-{uuid}.{ext}
                         fileSize }            createPresignedPost(
                                                 Conditions: [
                                                   ['content-length-range', 1, MAX],
                                                   ['eq','$Content-Type', contentType]])
                    ◀──{ url, fields, key,
                         expiresIn }──────────
     → createUploadTask(url, fileUri,
         MULTIPART, parameters: fields,
         fieldName: 'file', onProgress)
                    ────────────────────────────────────────────▶ POST (S3 enforces the
                                                                  size + type conditions)
     ◀──────────────── 204 ───────────────────────────────────────
                    ──POST /videos { rawVideoKey: key, … }──▶
                                               VideoService.create
                                                 • assert key startsWith `videos/{user.id}/`   ← fixes D-65
                                                 • HeadObject(key) → exists, size, ContentType ← fixes D-64
                                                 • persist row
                                               (Iter 5 Phase C: enqueue optimize)
```

**The backend never sees a media byte.** It authorises, bounds, and records.

### 10.4 Two corrections to Iteration 5 Phase D as written

> **Applied 2026-08-21.** Both corrections below, plus the strike of §2.3's incorrect
> `quality: 0.8` / `videoMaxDuration` claim (D-52), have been written into
> [05-DELIVERY-CDN-FASTSTART.md](05-DELIVERY-CDN-FASTSTART.md). Its Phase D is now marked
> **MOVED / SUPERSEDED** and points here; the wrong snippet is retained under a warning for
> history rather than deleted. No code was changed.

| # | Issue in `05-DELIVERY-CDN-FASTSTART.md` §5.D | Correction |
|---|---|---|
| 1 | The snippet signs a `PutObjectCommand` that includes `CacheControl`, but the frontend snippet sends only `Content-Type`. Any header included in the signed command becomes part of `SignedHeaders` — the client **must** send `Cache-Control: public, max-age=31536000, immutable` byte-for-byte or S3 returns **403 SignatureDoesNotMatch**. As written, Phase D would fail on its first request. | Either send both headers from the client, or move to presigned POST (below), where they are ordinary form fields. |
| 2 | **A presigned PUT URL does not bound the request body.** `validateFileSize(dto.fileSize)` validates a *number the client chose to send*. A client that declares 5 MB and PUTs 5 GB succeeds, and the bill is real. | Use **presigned POST** (`@aws-sdk/s3-presigned-post`) with `Conditions: [['content-length-range', 1, MAX]]`. S3 itself rejects an oversized body with **400 EntityTooLarge**. This is the only server-authoritative size gate available on a direct upload. |

> **[unverified] — Spike S-7.3.** `expo-file-system`'s `createUploadTask` with
> `uploadType: MULTIPART` sends `parameters` as form fields alongside the file field. S3's
> presigned-POST parser requires **the `file` field to be last** in the multipart body. If
> expo emits the file first, presigned POST cannot be used as-is. **Fallback if the spike
> fails:** presigned **PUT** (sending both signed headers per correction #1) plus a
> `HeadObject` size check in the confirm step, deleting and rejecting any object that
> exceeds the ceiling. Slightly worse (the bytes are already paid for) but correct.

### 10.5 What about images?

Images after compression are < 1 MB. The proxy cost for a 400 KB body is negligible, and
`/upload/profile-image` does useful server-side work (it writes `users.profileImage`).
**Recommendation: keep images on the existing multipart endpoints.** Route only **video**
through presign. This keeps the change surface small and leaves three working endpoints
untouched. Revisit only if image upload latency turns out to matter.

---

## 11. Recommended upload-progress architecture

### 11.1 Primitive

**Keep `expo-file-system`'s `createUploadTask`.** It is already in use, it is already
reporting true bytes, and it is the correct tool for React Native:

| Alternative | Why not |
|---|---|
| `axios` `onUploadProgress` | XHR under the hood. Streaming a `file://` URI through RN's XHR either buffers it into JS memory (fatal at 30 MB+) or reports an unknown total. |
| Raw `XMLHttpRequest` + `upload.onprogress` | Same memory problem. |
| AWS SDK v3 `Upload` (`@aws-sdk/lib-storage`) | Pulls the SDK and its crypto polyfill chain into the bundle, needs credentials on the device, and needs the file as a stream/blob. Wrong shape for RN. |
| S3 multipart with presigned part URLs | Genuinely necessary above ~100 MB or for resumable uploads. **Not needed at launch** — the median compressed clip is 7–20 MB (§9.2) and a single POST is simpler and faster. But the ceiling is 100 MB, so this is the documented escalation path if telemetry shows long-tail failures; the stall detector (§11.3) is the interim mitigation. |

### 11.2 Composite, monotonic, honest

The user's brief asks that `0 / 10 / 40 / 75 / 100` mean something. It cannot mean
"bytes uploaded" alone, because compression is the single largest phase. Make it mean
**"fraction of the whole publish flow completed"**, with every phase measured:

```js
// newboostraapp/src/utils/uploadProgress.js
const WEIGHTS = { compress: 0.30, upload: 0.65, publish: 0.05 };  // video
// images: { compress: 0.15, upload: 0.80, publish: 0.05 }

overall = W.compress * pCompress          // react-native-compressor onProgress (0..1)
        + W.upload   * pUpload            // totalBytesSent / totalBytesExpectedToSend
        + W.publish  * pPublish;          // 0 → 1 on POST /videos resolving
```

Three rules:

1. **Monotonic.** `setProgress(p => Math.max(p, next))`. This alone fixes D-56's 100 → 95
   regression permanently, regardless of what any phase reports.
2. **Label the phase.** `uploadStatusText` already exists in `UploadScreen`; drive it from
   the phase: `"Optimising video… 42%"` → `"Uploading… 71%"` → `"Publishing…"`. A 40-second
   compression that says *"Optimising"* is patience-inducing; the same 40 seconds behind
   *"Uploading 0%"* is a bug report.
3. **Calibrate the weights from measurements**, not intuition. Log phase durations on 20
   real uploads across a slow and a fast device (T-7.12) and set `WEIGHTS` from the medians.

### 11.3 Lifecycle — cancel, retry, failure, timeout, background, duplicates

New module: `newboostraapp/src/services/mediaUploadManager.js`. One object owns one upload's
whole lifecycle, so `UploadScreen` holds no transport state.

| Concern | Design |
|---|---|
| **Cancel** | Hold `taskRef` (the `UploadTask`) and `compressionIdRef`. Cancel button → `task.cancelAsync()` / `Video.cancelCompression(id)` + set `cancelledRef`, which every `await` boundary checks before continuing. Delete the compressed temp file. |
| **Retry** | Up to **3 attempts**, exponential backoff (1 s, 4 s, 9 s), **on transport failures only** — never on 4xx (except **403**, which means the presign expired → re-request presign, then retry). **Never re-compress on retry:** the compressed file is cached and re-used, so a retry starts at 30 % not 0 %. |
| **Failure** | Distinguish three classes in the UI: *validation* (fix the input), *transient* (Retry button), *permanent* (Start over). Today everything is one generic modal. |
| **Timeout** | `createUploadTask` has no timeout option. Implement a **stall detector**: record `lastProgressAt` in the callback; a `setInterval` that sees no advance for **60 s** calls `cancelAsync()` and triggers the retry path. This is strictly better than a wall-clock timeout, which would kill legitimate slow uploads. |
| **Backgrounding** | `expo-keep-awake` for the whole flow. An `AppState` listener records backgrounding; on foreground, if the task has died, drop into the retry path with the compressed file intact. **True background upload** (iOS `URLSessionConfiguration.background`) is out of scope — it needs a native module. Document that limitation rather than pretending otherwise. |
| **Duplicates** | Two mechanisms. (a) An `inFlightRef` guard in addition to the existing `disabled` prop. (b) **Presign once per attempt-set**: persist `{ compressedUri, key, presign }` to AsyncStorage as an upload draft, so a retry re-uses **the same S3 key** — a duplicate POST overwrites the same object instead of orphaning one. |
| **Orphans** | `VideoService.create` `HeadObject`s the key (§10.3), so a row can never point at a missing object. For objects uploaded but never published, add an **S3 lifecycle rule** expiring `videos/*/` objects older than 24 h that carry an `x-amz-meta-status: pending` tag, cleared on publish. ✅ **Ungated** — [Constraint #9 was lifted 2026-08-21](00-OVERVIEW.md#constraint-9). Create it whenever convenient; nothing in this iteration waits on it. |

---

## 12. Recommended limits

### 12.1 The constants — decided

**Video input is capped at 250 MB, and a 250 MB input is still compressed.** The input cap
and the upload ceiling are two different gates measuring two different things; the 50 MB
figure from an earlier draft of the brief is dropped and appears nowhere in this plan.

| Constant | Value | Enforced where | Meaning |
|---|---|---|---|
| `MAX_VIDEO_INPUT_BYTES` | **250 MB** | **Mobile only**, before compression | "This file is too large for us to even process." Above this the compression itself becomes the problem — minutes of transcode, and a real OOM risk on low-end Android. |
| `MAX_VIDEO_DURATION_S` | **180 s** | **Mobile**, from `asset.duration` | Bounds compression time and, with the §9.2 bitrate, bounds output size. This is the constant that makes the 100 MB ceiling derivable rather than arbitrary. |
| `MAX_VIDEO_UPLOAD_BYTES` | **100 MB** | **Mobile + backend presign + S3 `content-length-range`** | The brief's §8 rule: this is the most that may enter the bucket. Three layers, **S3 authoritative**. Derived in §9.2: 180 s × 3.63 Mbps ≈ 82 MB, plus VBR headroom. |
| `MAX_IMAGE_INPUT_BYTES` | **10 MB** | **Mobile + backend multer** | Unchanged from today; now enforced on the client too. |
| `MAX_IMAGE_UPLOAD_BYTES` | **1 MB** | **Mobile + backend** | The brief's §4 target, as a hard ceiling. |

**Why 250 MB in and 100 MB out is not a contradiction.** The input cap protects the *device*
(transcode time, memory, battery); the upload ceiling protects the *bucket and the network*.
A 250 MB 4K/60 source compresses to well under 100 MB at these settings — a 2.5× floor on
the saving, and typically far more, because a 250 MB file is almost always high-bitrate 4K
rather than a long 1080p clip.

**Nothing above 8 MB skips compression.** The skip-if-already-small rule (§9.2) is deliberately
set an order of magnitude below the upload ceiling so that no large file can take the
uncompressed path. The brief's §8 rule — *S3 holds the optimised media, not the original* —
holds for every video above 8 MB without exception.

> `MAX_VIDEO_UPLOAD_BYTES = 100 MB` sits exactly at the threshold where a **single** POST
> starts to be uncomfortable on a poor mobile network (see §11.1). The stall detector in
> §11.3 is what makes it safe. If real-world telemetry shows 100 MB uploads failing often,
> the fix is multipart-with-presigned-parts, **not** a lower ceiling — a lower ceiling would
> mean rejecting videos after the user already waited through a compression.

### 12.2 Where each is enforced — the two-layer rule the brief asks for

| Layer | Video | Image |
|---|---|---|
| **Mobile, pre-compression** | `MAX_VIDEO_INPUT_BYTES` + `MAX_VIDEO_DURATION_S` | `MAX_IMAGE_INPUT_BYTES` |
| **Mobile, post-compression** | `MAX_VIDEO_UPLOAD_BYTES` | `MAX_IMAGE_UPLOAD_BYTES` |
| **Backend presign** | `MAX_VIDEO_UPLOAD_BYTES` against `dto.fileSize` | n/a (images keep the proxy path) |
| **S3** | `content-length-range` condition — **authoritative** | n/a |
| **Backend multipart (legacy)** | drop 500 MB → `MAX_VIDEO_UPLOAD_BYTES` when the route is retired | multer 10 MB → **1 MB** once every shipped client compresses |

> **Do not lower the image multer cap to 1 MB in the same release as the client change.**
> Older installed builds still upload uncompressed images and would break. Lower it one
> release after client compression is at high adoption.

---

## 13. Changes required, by codebase

### 13.1 Mobile — `newboostraapp/`

| File | Change |
|---|---|
| `src/constants/media.js` **(new)** | All constants from §12.1 plus the §8.2/§9.2 presets. One source of truth. |
| `src/utils/mediaCompression.js` **(new)** | `compressImage(uri, preset)`, `compressVideo(uri, onProgress)`, `probeMedia(uri)`. Owns the iterate-to-target loop, the skip-if-already-small rule, and temp-file cleanup. |
| `src/utils/mediaValidation.js` **(new)** | `validateImageInput(asset)`, `validateVideoInput(asset)` returning `{ ok, reason }` with user-facing copy. |
| `src/utils/uploadProgress.js` **(new)** | The weighted, monotonic composite of §11.2. |
| `src/services/mediaUploadManager.js` **(new)** | Lifecycle owner: presign → upload → confirm, with cancel/retry/stall/AppState/draft persistence (§11.3). |
| `src/services/uploadService.js` | Add `presignVideo(meta)` and `uploadVideoDirect(uri, meta, onProgress)`. Add an `onProgress` parameter to `uploadThumbnail`/`uploadProfileImage`/`uploadChatImage` by switching them to `createUploadTask` (fixes D-58). **Delete the `uploadChatImage` → `uploadProfileImage` fallback (fixes D-55 — ship this one first, standalone).** |
| `src/config/api.config.js` | Add `UPLOAD.PRESIGN: '/upload/presign'`. |
| `src/screens/home/screens/UploadScreen.jsx` | Validate on pick; compress before upload; compress the auto-generated cover; drive progress from `uploadProgress.js`; **delete the fabricated `setUploadProgress(95)` / `(100)` lines** (fixes D-56); add a Cancel button and a Retry affordance. |
| `src/screens/home/components/FeedPostItem.jsx` | Compress the picked cover before `uploadThumbnail`. |
| `src/screens/home/screens/EditProfileScreen.jsx`, `SettingsScreen.jsx` | Compress with the `AVATAR` preset before `uploadProfileImage`. |
| `src/app/chat/[id].jsx` | Compress with the `CHAT` preset before `uploadChatImage`. |
| `package.json` | `npx expo install expo-image-manipulator expo-keep-awake` · `npm i react-native-compressor` (**after S-7.2 passes**) · rebuild both native projects. |

### 13.2 Backend — `boost-backend/`

| File | Change |
|---|---|
| `src/modules/upload/dto/presign-upload.dto.ts` **(new)** | `{ type: UploadType; fileName: string; contentType: string; fileSize: number; duration?: number }`. **Remember `forbidNonWhitelisted: true`** (Constraint #1) — every field must be declared. |
| `src/modules/upload/upload.service.ts` | Split `MAX_VIDEO_SIZE` into `MAX_VIDEO_UPLOAD_SIZE` (§12.1) and drop the 500 MB constant. Add `generatePresignedPost(userId, dto)` using `@aws-sdk/s3-presigned-post` with `content-length-range` + `eq $Content-Type`. Add `headObject(key)`. Extend the existing `IMMUTABLE_CACHE_CONTROL` into the POST fields. **Delete `generateProfileImageUploadUrl`** (dead — D-59) or repoint it at the new helper. |
| `src/modules/upload/upload.controller.ts` | Add `@Post('presign')`. Lower the video multer cap. Point `/upload/image` at a new `UploadType.CHAT_IMAGE` keyed under `chat/` (fixes D-62). |
| `src/modules/upload/dto/request-upload.dto.ts` | Add `CHAT_IMAGE = 'chat_image'` to `UploadType`; extend `generateS3Key`'s switch. |
| `src/modules/video/video.service.ts` | In `create`: **assert `dto.rawVideoKey.startsWith('videos/' + userId + '/')`** → `ForbiddenException` (fixes D-65); **`HeadObject` the key** → `BadRequestException` if absent, and reject if `ContentLength > MAX_VIDEO_UPLOAD_SIZE` (fixes D-64). Same assertions for `thumbnailKey`. |
| `src/modules/video/video.module.ts` | Import `UploadModule` (already exports `UploadService`) for the head-check. |
| `src/modules/feed/feed.service.ts` | In `present()`, map the populated user through `MediaUrlService`: `user: { ...video.user, profileImage: this.mediaUrl.toUrl(video.user?.profileImage) }` (fixes D-60, site 1 of 4). |
| `src/modules/video/video.service.ts` | Same mapping in `findOne()` — it populates `profileImage` and returns `...video` unmapped (D-60, site 2). |
| `src/modules/users/users.service.ts` | Same in `getProfile()` (`.select(… profileImage …)`, ~line 92) and in `update()`'s returned document (~line 165) (D-60, sites 3 and 4). |
| — | **Preferred over four call-site patches:** one `MediaUrlInterceptor` (or a `toPublicUser()` helper on `MediaUrlService`) applied wherever a user document is serialised, so site 5 does not appear later. Decide this in 7.F; the four-site list above is the minimum. |
| `npm i @aws-sdk/s3-presigned-post` | Peer of the already-installed `@aws-sdk/client-s3`. |

**Keep `POST /upload/video` alive for at least two releases** (Iteration 5 Phase D already
says one; two is safer given the app is live and adoption is not instant). Instrument it so
its usage can be watched before deletion.

### 13.3 S3 / CloudFront

| Change | Needed? | Notes |
|---|---|---|
| Bucket CORS | **No** | `expo-file-system` uploads natively; there is no browser preflight. Add it only if a web client is ever built. |
| IAM policy | **No change** | The backend already holds `s3:PutObject`; presigning delegates its own permission. |
| Bucket policy | **No change** | Presigned POST is authorised by the signature, not the policy. |
| CloudFront | **No change** | **Uploads must go to the S3 endpoint, never through the distribution** — it is configured `GET, HEAD` only ([05 §5.A](05-DELIVERY-CDN-FASTSTART.md)). Delivery is unaffected by this iteration. |
| Lifecycle rule for orphans | **Recommended** | Expire unpublished `videos/*/` objects after 24 h. ✅ **Ungated** ([Constraint #9 lifted](00-OVERVIEW.md#constraint-9)). Create it on the dev bucket first out of ordinary caution, not because a gate requires it. |
| Lifecycle rule for `videos/*/optimized/` | Deferred | Already covered by Iteration 5 Phase C's risk table. |

---

## 14. Which iteration does this belong to?

### 14.1 Recommendation: a new, dedicated **Iteration 7**, executed **next — before Iteration 4**

**Not Iteration 4.** Iteration 4 is *"frontend only, no backend change, no new dependency"*
and closes D-37…D-41 — preload, disk cache, cold start. It is entirely about the **playback**
half of the app. This work is about the **upload** half, requires backend changes and two new
native dependencies, and shares not one file with Iteration 4. Merging them would produce an
iteration that cannot be shipped or rolled back as a unit — the exact property
[00-OVERVIEW.md](00-OVERVIEW.md) says every iteration must have.

**Not folded into Iteration 5 either**, even though it takes over Phase D. Iteration 5 now
reduces to *verify Phase A* + *build Phase C*, and Phase C still needs **Redis provisioned
and a worker deployed**. This work needs neither: it is an app release plus one additive
endpoint. Chaining it behind Redis provisioning would stall it for no reason.

**What it does take from Iteration 5:** **Phase D moves here in full.** ✅ **Done —**
`05-DELIVERY-CDN-FASTSTART.md` now carries a `MOVED` banner on Phase D pointing at this
file, its phase table and `Closes:` line drop D-47/D-49, and §2.3's incorrect
`quality: 0.8` / `videoMaxDuration: 180` claim is struck and corrected (D-52). Iteration 5
is now three phases: **A** (CloudFront), **B** (cache-control backfill), **C** (faststart
remux + server-side covers).

### 14.2 Why it should run before Iteration 4

Four dependency arguments, strongest first:

1. **Iteration 4's disk cache is not designed until file sizes are known.** A phone-appropriate
   LRU budget holds ~4 uncompressed originals or ~40 compressed clips. Sizing the cache, the
   preload depth, and the eviction policy against today's file sizes means designing it twice.
2. **It makes the data wipe pay for itself.** The plan is to delete production data
   ([Constraint #9 lifted](00-OVERVIEW.md#constraint-9)). If Iteration 7 ships *before* the
   first uploads after that wipe, the bucket contains **only** compressed, correctly-headered
   objects from day one — §8's rule reached with zero migrations. Ship it after, and the
   bucket immediately starts re-accumulating exactly the originals the wipe just removed.
3. **It de-risks Phase C substantially.** Phase C's top two risks are disk exhaustion and CPU
   starving the web service. If the median input is a 26 MB pre-compressed 1080p clip instead
   of a 300 MB 4K original, `needsTranscode` is almost never true, and the job reduces to a
   seconds-long `-c copy` remux.
4. **It is independently shippable today.** No Redis, no worker, no data migration, no
   bucket-policy change, and — since [Constraint #9 was lifted](00-OVERVIEW.md#constraint-9) —
   nothing gated at all.

### 14.3 Recommended overall order from here

```
7.0  HOTFIX  — delete the uploadChatImage → uploadProfileImage fallback (D-55)   ← standalone, today
7.A  Client-side validation + limits constants                                    (mobile only)
7.B  Image compression, all four entry points                                     (mobile only)
7.C  Presigned direct-to-S3 for video + key/HeadObject assertions                 (mobile + backend)
7.D  Real composite progress + cancel/retry/stall/background                      (mobile only)
7.F  Backend media hygiene — D-60, D-62, D-63, dead code                          (backend only)
7.E  Video compression                                                            ← gated on spike S-7.2
4    Preload, disk cache, cold start                                              (now sized correctly)
5A   Verify CloudFront (already configured — run T-5.1…T-5.8, esp. 206 range)
5C   Faststart remux + covers      ← needs Redis + a worker; no longer gated on data
5·   Orphan lifecycle rule         ← ungated, do it whenever
     (5B Cache-Control backfill is DROPPED — superseded by the data wipe)
6    expo-av → expo-video migration
```

**7.A–7.D have no dependency on the video-compression spike** and should not wait for it.
If S-7.2 fails, 7.E is deferred to a later date and Iteration 5 Phase C carries the load —
everything else still ships.

### 14.4 Spikes to run before committing to 7.E

| # | Spike | Blocks | Fallback if it fails |
|---|---|---|---|
| **S-7.1** | Pin the exact `expo-image-manipulator` SDK-54 API against the installed package | 7.B | None needed; the module is first-party and certain to work — this is an API-shape check only. |
| **S-7.2** | `react-native-compressor` builds and runs on iOS + Android under `newArchEnabled: true`; measure compression time and output size on one high-end and one low-end device | 7.E | Defer 7.E; rely on Iteration 5 Phase C server-side transcode. Everything else in Iteration 7 is unaffected. |
| **S-7.3** | `createUploadTask` MULTIPART field ordering is compatible with S3 presigned POST | 7.C | Presigned **PUT** with both signed headers + `HeadObject` size verification at confirm (§10.4). |

### 14.5 Defect → step traceability — **no defect left behind**

Every defect this audit opened is assigned to exactly one step and one test. **If a defect
has no row here, it is not being fixed — that is the point of the table.** Check it off at
the end of implementation; do not close Iteration 7 with an unassigned row.

| ID | Defect (short) | Closed by | Verified by |
|---|---|---|---|
| D-50 | No client-side size/duration validation | **7.A** | T-7.2, T-7.9, T-7.10 |
| D-51 | No image compression | **7.B** | T-7.1, T-7.3, T-7.4, T-7.5 |
| D-52 | No video compression; `quality`/`videoMaxDuration` inert | **7.A** (delete the inert options, enforce duration from `asset.duration`) + **7.E** (actual transcode) | T-7.7, T-7.9a, T-7.10 |
| D-53 | 500 MB constants vs. intended limits | **7.C** | T-7.15 |
| D-54 | Media proxies through the API instance | **7.C** | T-7.17, T-7.18 |
| D-55 | Chat-image fallback overwrites the avatar | **7.0 hotfix** | T-7.23 |
| D-56 | Fabricated 95/100 progress steps | **7.D** | T-7.24, T-7.25 |
| D-57 | No cancel / retry / timeout / background | **7.D** | T-7.26 – T-7.31 |
| D-58 | Image uploads report no progress | **7.D** | T-7.34 |
| D-59 | `generateProfileImageUploadUrl` is dead code | **7.C** (delete or repoint) | T-7.41 |
| **D-60** | **Avatars bypass CloudFront — 4 serialisation sites** | **7.F** | **T-7.35, T-7.39** |
| D-61 | Size caps enforced only after the body is received | **7.C** for video (presigned POST + `content-length-range`). **Partially open for images** — see the residual below. | T-7.14 |
| **D-62** | **Chat images keyed under `profiles/`** | **7.F** | **T-7.40** |
| **D-63** | **`/upload/video` returns an unused 24 h presigned URL** | **7.F** | **T-7.41** |
| D-64 | Orphaned / duplicated objects on a failed publish | **7.C** (`HeadObject`) + **7.D** (same-key retry draft) | T-7.21, T-7.32, T-7.33 |
| D-65 | `rawVideoKey` is an unvalidated client string | **7.C** | T-7.20 |

#### Step 7.F — backend media hygiene (new; backend only, no mobile release needed)

Three fixes that had changes listed in §13.2 but no slot in the order. They share no code
with 7.A–7.E, carry no client dependency, and can ship in any backend release:

1. **D-60** — route `profileImage` through `MediaUrlService` at all four serialisation sites
   (§13.2). Behaviour is unchanged for empty values: today the client receives `''`, after
   the fix `null`, and both are falsy, so the existing `ui-avatars.com` fallback in
   [FeedPostItem.jsx:634-640](../../../newboostraapp/src/screens/home/components/FeedPostItem.jsx#L634-L640)
   still triggers. **No client change required.**
2. **D-62** — add `UploadType.CHAT_IMAGE` keyed under `chat/{userId}/`. **Additive only:**
   existing message rows hold absolute URLs to `profiles/…` objects that keep resolving, so
   no migration is needed either side of the data wipe.
3. **D-63** — stop returning a 24 h presigned URL from `/upload/video`. Nothing consumes it
   today, but it is the exact shape of the D-20 bug iteration 2 had to repair; leaving a
   loaded gun in the response is how it gets fired later.

#### Residual risk — accepted and stated, not hidden

- **D-61 closes only halfway.** Video gains a server-authoritative gate (S3 rejects an
  oversized body outright). **Images keep the multipart proxy path** (§10.5), so multer still
  aborts mid-stream *after* accepting bytes. Acceptable at a 10 MB cap against a 1 MB target;
  it fully closes only if images later move to presign, or when the multer cap drops to 1 MB
  once client-compression adoption is high (§12.2). **Do not mark D-61 closed at the end of
  this iteration — mark it *mitigated*.**

#### Adjacent finding, deliberately **not** in this iteration

Found during the audit, unrelated to media, recorded so it is not lost: the app calls
`POST /videos/{id}/view` ([videoService.js:246](../../../newboostraapp/src/services/videoService.js#L246))
and **no such route exists** — `VideoController` defines `POST /`, `GET my-videos`, `GET :id`,
`PATCH :id`, `DELETE :id`, `POST :id/like` and nothing else. `recordView` swallows the 404
(`catch → return { success: true }`), so **view counts are silently never recorded** and
`VideoService.incrementViewCount` is reachable from no route. Not a media-pipeline defect —
needs its own ticket.

---

## 15. Test plan

### Compression

| # | Test | Pass |
|---|---|---|
| T-7.1 | Pick a 9 MB photo → cover upload | Object in S3 is **< 1 MB**; long edge ≤ 1280; visually acceptable at full-screen. |
| T-7.2 | Pick an 11 MB photo | Rejected **on device** with a clear message. No network request is made. |
| T-7.3 | Auto-generated cover from a 4K video | Compressed before upload. Compare object size against the pre-change baseline. |
| T-7.4 | Compress a high-entropy image (foliage/noise) | Iteration loop converges; result < 1 MB; ≤ 4 attempts. |
| T-7.5 | Compress an already-small (200 KB) image | Skipped or near-lossless; output is **not larger** than the input. |
| T-7.6 | EXIF check on an uploaded image (`exiftool`) | No GPS tags present. |
| T-7.7 | Compress a 60 s 4K/60 clip | Output ≤ 1080p, ≤ 30 fps, H.264, ~26 MB. Play side-by-side against the source on-device: no visible artefacting at normal viewing distance. |
| T-7.8 | Compress an already-compliant 1080p/30 6 MB clip | **Skipped** (skip-if-already-small rule). Object bytes identical to the source. |
| T-7.9 | Pick a 260 MB video | Rejected on device before compression starts. |
| T-7.9a | **Pick a 240 MB 4K/60 video (just under the input cap)** | **Accepted, compressed, and the S3 object is ≤ 100 MB.** Not rejected, and not uploaded as-is. This is the test that proves "250 MB in, compressed out". |
| T-7.9b | Pathological high-entropy source whose first pass exceeds 100 MB | Second pass at 720p/2.0 Mbps fires automatically and succeeds. User never sees a post-compression rejection. |
| T-7.10 | Pick a 200 s video | Rejected on device with a duration message. |
| T-7.11 | Compress on a low-end Android device | Completes; wall-clock recorded; UI stays responsive; no OOM. |
| T-7.12 | **Weight calibration** — instrument 20 uploads across a fast and a slow device | Phase-duration medians recorded; `WEIGHTS` set from them. |

### Direct-to-S3

| # | Test | Pass |
|---|---|---|
| T-7.13 | `POST /upload/presign` for a video | Returns `{ url, fields, key, expiresIn }`; `key` is `videos/{callerId}/…`. |
| T-7.14 | Declare 10 MB, POST a 200 MB body | **S3 rejects with 400 EntityTooLarge.** The object does not exist. *(This is the test that proves the size gate is real.)* |
| T-7.15 | Declare a size above `MAX_VIDEO_UPLOAD_BYTES` | Backend **400**s at presign; no S3 call is made. |
| T-7.16 | Full publish, end to end | Object in S3 with correct `ContentType` **and** `CacheControl: public, max-age=31536000, immutable`; row created; video plays in the feed. |
| T-7.17 | **Render instance during a 100 MB upload** (the ceiling) | No `/tmp` growth, no CPU spike, other endpoints' latency unchanged. |
| T-7.18 | Wall-clock: direct vs. proxied, same file, same network, 5 runs each | Direct is measurably faster. Record both numbers. |
| T-7.19 | Expired presign (wait > `UPLOAD_URL_EXPIRATION`, then POST) | **403**. App re-presigns and retries transparently. |
| T-7.20 | **`POST /videos` with another user's `rawVideoKey`** | **403 Forbidden** (D-65). |
| T-7.21 | **`POST /videos` with a non-existent key** | **400** (`HeadObject` miss, D-64). |
| T-7.22 | Old app build still uploads via `POST /upload/video` | Works. |
| T-7.23 | Chat image after the D-55 fix, with `/upload/image` forced to fail | Message fails cleanly. **`users.profileImage` is unchanged.** |

### Progress & lifecycle

| # | Test | Pass |
|---|---|---|
| T-7.24 | Watch the bar through a full video publish | **Strictly monotonic 0 → 100.** Never decreases. No jump from a fabricated constant. Phase label matches the phase. |
| T-7.25 | Compare the reported percentage against a proxy's byte counter during the upload phase | Reported ≈ actual bytes within ±5 %. |
| T-7.26 | Cancel during compression | Stops within ~1 s. Temp files deleted. No S3 object created. |
| T-7.27 | Cancel during upload | `cancelAsync()` fires; no partial object is published; the draft is cleared. |
| T-7.28 | Kill wifi mid-upload, restore after 10 s | Retries automatically and completes. **Does not re-compress.** |
| T-7.29 | Kill wifi and leave it off | Retries 3×, then a clear retryable error with a working Retry button. |
| T-7.30 | Stall detector — throttle to ~0 B/s for 70 s | Upload is cancelled and retried at ~60 s, not hung. |
| T-7.31 | Background the app mid-upload for 60 s, return | Either completes or drops cleanly into the retry path with the compressed file re-used. |
| T-7.32 | Double-tap Publish | Exactly one object, exactly one row. |
| T-7.33 | Force `POST /videos` to fail after a successful S3 POST, then retry | The retry re-uses **the same key** — one object in the bucket, not two. |
| T-7.34 | Image upload progress (thumbnail/avatar/chat) | Reports real progress instead of nothing (D-58). |

### Delivery regression

| # | Test | Pass |
|---|---|---|
| T-7.35 | `curl "$API/feed/global?limit=20" \| jq -r '.docs[].user.profileImage'` | Every value's host is the **CloudFront** domain (D-60, site 1). |
| T-7.39 | Same check on the other three sites: `GET /videos/:id`, `GET /users/:id/profile`, `PATCH /users/me/profile-image` | CloudFront host in all three (D-60, sites 2–4). A user with **no** avatar returns `null` (not `''`) and the client still renders its `ui-avatars` fallback. |
| T-7.40 | Send a chat image after 7.F | Object key begins `chat/{userId}/`. An **older** message whose URL points at `profiles/…` still renders (D-62). |
| T-7.41 | `grep -rn "generateProfileImageUploadUrl" src/`, and inspect the `POST /upload/video` response body | No dead presign helper remains (D-59); the response contains **no** presigned URL (D-63). |
| T-7.36 | Scroll 20 items, proxy trace | Zero direct `s3.{region}` requests. |
| T-7.37 | Cold-cache first-frame latency, 10 compressed vs. 10 legacy videos | Compressed median measurably lower. Record both. |
| T-7.38 | Poster paint latency on compressed vs. legacy covers | Compressed median measurably lower. |

---

## 16. Success criteria

- [ ] **No original media reaches S3.** For every path, the object's byte count is smaller than the picked asset's, or the skip-if-already-small rule provably applied (T-7.1, T-7.3, T-7.5, T-7.7, T-7.8).
- [ ] **Every image object is < 1 MB** (T-7.1, T-7.4).
- [ ] **Every new video object is ≤ `MAX_VIDEO_UPLOAD_BYTES`**, enforced by S3 and not merely by the client (**T-7.14 is the load-bearing test**).
- [ ] **Limits are enforced in two independent layers** for every media type (§12.2, T-7.2, T-7.9, T-7.15).
- [ ] **A 100 MB video upload never touches the API instance's disk** (T-7.17).
- [ ] **A 250 MB source is accepted, compressed, and lands in S3 at ≤ 100 MB** (T-7.9a).
- [ ] **Progress is monotonic and byte-accurate within ±5 %** (T-7.24, T-7.25). No hardcoded constant anywhere in the progress path.
- [ ] **Cancel works within 1 s at every phase** (T-7.26, T-7.27).
- [ ] **A network interruption never forces a re-compression** (T-7.28).
- [ ] **A failed publish never orphans or duplicates an object** (T-7.32, T-7.33).
- [ ] **A user cannot publish another user's S3 key** (T-7.20).
- [ ] **A failed chat image never changes the user's avatar** (T-7.23).
- [ ] **Zero playback or poster regressions** across 50 items on both feeds.
- [ ] **Old app builds still upload and still play** (T-7.22).
- [ ] **Every row in §14.5's traceability table is closed, or explicitly marked *mitigated*** — no defect silently dropped. D-61 is expected to close as *mitigated*, not *closed*.

---

## 17. Rollback plan

Designed so that **every step is reversible by an app release or a single flag**, and no step
mutates existing data.

| Step | Rollback | Blast radius |
|---|---|---|
| **7.0 hotfix (D-55)** | Revert the commit. | None — it deletes a fallback that was actively harmful. |
| **7.A validation** | Set `MEDIA_VALIDATION_ENABLED = false` in `src/constants/media.js`; ship. Or revert. | Client only. Backend caps still apply. |
| **7.B image compression** | `IMAGE_COMPRESSION_ENABLED = false` → the picker URI is passed through to the existing, untouched `uploadService` calls. | Client only. Already-compressed objects in S3 stay valid and are strictly better than what they replaced. |
| **7.C direct-to-S3** | `DIRECT_UPLOAD_ENABLED = false` → falls back to `POST /upload/video`, **which is still deployed and still works**. No backend rollback needed. | Client only, provided the legacy route has not been deleted. **Do not delete it for two releases.** |
| Backend presign route | Additive. Leaving it deployed while clients ignore it is inert and costs nothing. | None. |
| `rawVideoKey` / `HeadObject` assertions | Behind `VIDEO_KEY_ASSERTIONS_ENABLED`. Applies to **creates only** — never retroactively — so legacy key formats are irrelevant either way. After the data wipe there are no legacy keys at all, which removes the last reason for caution here. | Low. Enable it from the start. |
| Image multer cap 10 MB → 1 MB | **Do not ship this until client compression adoption is high.** Reverting is a one-line redeploy. | Would 400 every upload from an older build. |
| **7.E video compression** | `VIDEO_COMPRESSION_ENABLED = false` → the original is uploaded, subject to the same `MAX_VIDEO_UPLOAD_BYTES` gate (so oversized clips are rejected rather than silently uploaded). | Client only. |
| Native dependency addition | Removing a native module requires a rebuild + store release, so **do not add `react-native-compressor` until S-7.2 passes.** The flag protects behaviour, not the binary. | Build-level. |
| Orphan lifecycle rule | Delete the rule. ✅ Ungated. Still worth rehearsing on the dev bucket, because the rule keys off a metadata tag and a wrong prefix would expire live objects. | **Irreversible for anything already expired** — the one item here that still deserves a careful eye, even without a formal gate. |

**Nothing in this iteration mutates an existing S3 object or an existing Mongo document.**
That was originally a requirement of Constraint #9; it remains true after
[the constraint was lifted](00-OVERVIEW.md#constraint-9), and it is why this iteration is
safe to ship either side of the planned data wipe. Legacy uncompressed objects keep serving
exactly as they do today until the wipe removes them; the new pipeline only governs new
uploads. **Preferred sequence: wipe first, then ship — so the bucket never re-accumulates
what the wipe just cleared.**

---

## 18. Implementation notes — 2026-08-22

### 18.1 Spike outcomes

| Spike | Outcome |
|---|---|
| **S-7.1** — `expo-image-manipulator` SDK-54 API | ✅ **Resolved.** Installed `~14.0.8`. The contextual API is the live one: `ImageManipulator.manipulate(uri).resize({width\|height}).renderAsync()` → `ImageRef.saveAsync({ compress, format: SaveFormat.JPEG })`. `manipulateAsync` still exists but is marked `@deprecated`. `ImageRef` carries `.width`/`.height`, which is how `compressImage` learns the source dimensions without a second decode. |
| **S-7.2** — `react-native-compressor` under New Architecture | ⚠️ **Partially resolved — device test still owed.** The current release is `2.0.3`, which is **Nitro-based** and therefore New-Architecture-native; `react-native-nitro-modules@0.37.0` was installed as its required peer. Both pods autolink (`ios/Podfile.lock` carries `react-native-compressor (2.0.3)` and `NitroModules`) and the Metro bundle builds. **What is still unverified: an actual on-device run**, plus the compression time / output size measurements the spike asked for. |
| **S-7.3** — `createUploadTask` multipart field ordering | ✅ **Resolved — presigned POST is viable.** Verified in the installed native source: iOS `ios/Legacy/NetworkingHelpers.swift:createMultipartBody` writes `options.parameters` **before** the file part, and Android `FileSystemLegacyModule.kt:910-918` adds `parameters` to the `MultipartBody.Builder` before `addFormDataPart(fieldName, …)`. Both put `file` last, which is what S3's presigned-POST parser requires. The PUT fallback was therefore not needed. |

### 18.2 Deviations from the plan as written

**The shipped code is the final post-iteration-7 state. No pre-iteration path survives**, at
the owner's direction (2026-08-22) — the two-release compatibility window in §13.2/§17 was
dropped in favour of a clean cut.

1. **`POST /upload/video` is deleted, not kept for two releases.** The proxied route was the
   whole of D-47/D-54: a 500 MB body buffered to the instance's `/tmp`. Keeping it alive meant
   keeping that defect alive. `UploadService.uploadFile` is now buffer-only (`memoryStorage`
   for images), the `fs` stream/unlink path is gone, and `MAX_VIDEO_INPUT_SIZE` no longer
   exists server-side — the only video ceiling on the backend is `MAX_VIDEO_UPLOAD_SIZE`
   (100 MB), enforced at presign and authoritatively by S3.

2. **The image multer cap is 1 MB, not 10 MB.** §12.2 held it at 10 MB for one release so old
   builds would not 400. With no old builds to support, the cap matches the client's own
   post-compression ceiling. This closes D-61 for images too — it is no longer "mitigated".

3. **No rollback flags.** `MEDIA_VALIDATION_ENABLED`, `IMAGE_COMPRESSION_ENABLED`,
   `VIDEO_COMPRESSION_ENABLED`, `DIRECT_UPLOAD_ENABLED` and `VIDEO_KEY_ASSERTIONS_ENABLED` are
   removed — each was an `if (!flag) { …pre-iteration behaviour… }` branch. §17's rollback
   story is now "revert the commit".

4. **Dead upload DTOs removed.** `RequestUploadDto`, `ConfirmUploadDto`, `DirectUploadDto` and
   the `SignedUploadUrl` interface were referenced by nothing; `UploadType` moved to
   `dto/upload-type.enum.ts`.

5. **The orphan lifecycle rule's tagging mechanism was not built.** §11.3 specifies expiring
   `videos/*/` objects that carry `x-amz-meta-status: pending`, cleared on publish — but S3
   lifecycle rules **cannot filter on metadata**, only on prefix and object *tags*. Making it
   work means adding a `tagging` form field to the presigned POST and a `PutObjectTagging` call
   at publish. That puts an untested field on the critical upload path, so it was left out
   rather than guessed at. D-64's row-level half is closed regardless (`HeadObject` at publish,
   plus same-key retry drafts). **Build the tagging field and the rule together, and rehearse
   both on the dev bucket.**

6. **`react-native-compressor` was installed despite §17's "not until S-7.2 passes".** Metro
   resolves `require` statically, so a `try { require(...) } catch {}` guard fails the bundle
   rather than degrading — the module cannot be referenced at all unless it is installed.

7. **fps and keyframe interval are not set.** §9.2 specifies 30 fps and a 2 s keyframe interval;
   `react-native-compressor` exposes only `bitrate` and `maxSize` in `manual` mode. Resolution
   and bitrate are enforced; frame-rate and GOP normalisation fall to Iteration 5 Phase C's
   remux, which was already the guarantee for container layout.

8. **D-60 was closed with a helper, not four call-site patches** — `MediaUrlService.toPublicUser()`,
   applied at all four sites, as §13.2's "preferred over four call-site patches" note asked.

### 18.2b S3 / IAM policy changes — REQUIRED, and §13.3 is wrong about this

§13.3 says "IAM policy: **No change**" and "Bucket policy: **No change**". That holds for the
presign work — `videos/*` is already granted and presigning delegates the signer's own
permission — but it is **wrong for D-62's new `chat/` prefix**.

Probed against `boostme-storage-dev` on 2026-08-22 (1-byte objects, all deleted afterwards):

| Prefix | Backend `s3:PutObject` | Anonymous read |
|---|---|---|
| `videos/` | ALLOW | 200 |
| `thumbnails/` | ALLOW | 200 |
| `profiles/` | ALLOW | 200 |
| **`chat/`** | **DENY** | untestable — cannot write there |
| `uploads/` | DENY | — |

Both the IAM policy and, by the same pattern, the bucket policy are **scoped to those three
prefixes**, not `bucket/*`. Chat uploads therefore fail with `AccessDenied` on `PutObject`
before the read policy even matters. Two additive changes on **both** buckets:

1. **IAM policy on the backend user** — add `arn:aws:s3:::{bucket}/chat/*` with `s3:PutObject`
   (the upload), `s3:GetObject` (`ChatService` presigns a GET for chat image keys) and
   `s3:DeleteObject` if mirroring the other prefixes.
2. **Bucket policy public-read statement** — add `arn:aws:s3:::{bucket}/chat/*` to its
   `Resource` list, or chat images 403 for viewers.

The policies could not be read from here: `boostme-backend-dev` lacks `s3:GetBucketPolicy` and
`cloudfront:ListDistributions`. Console access is needed.

### 18.3 What was added

**Backend** — `upload/dto/presign-upload.dto.ts` (new) · `UploadType.CHAT_IMAGE` ·
`UploadService.generatePresignedPost()` / `.headObject()` / `MAX_VIDEO_UPLOAD_SIZE` ·
`POST /upload/presign` · `VideoService.assertOwnedObject()` ·
`MediaUrlService.toPublicUser()` at four sites ·
`generateProfileImageUploadUrl` deleted · **`POST /upload/video` deleted** · image multer caps
lowered to 1 MB · dead upload DTOs removed.

**Mobile** — `src/constants/media.js`, `src/utils/mediaValidation.js`,
`src/utils/mediaCompression.js`, `src/utils/uploadProgress.js`,
`src/services/mediaUploadManager.js` (all new) · `uploadService` rewritten around one
`multipartUpload` primitive with progress on every path and no chat→profile fallback ·
`UploadScreen` validates, compresses, and delegates the whole publish to the manager, with a
Cancel button · cover/avatar/chat call sites compress before upload · the legacy
`uploadService.uploadFile` proxy method and its `UPLOAD.DIRECT` endpoint are gone.

**Dependencies** — `@aws-sdk/s3-presigned-post` (and `@aws-sdk/s3-request-presigner` bumped to
match `client-s3`, which otherwise produced a duplicate-`@aws-sdk/types` type conflict) ·
`expo-image-manipulator`, `expo-keep-awake`, `react-native-compressor`,
`react-native-nitro-modules` · `pod install` run; `react-native-compressor` added to
`app.json` plugins.

### 18.4 Verification actually performed

Backend `nest build` and `tsc --noEmit` clean (the one remaining `tsc` error,
`test/app.e2e-spec.ts`'s `import * as request from 'supertest'`, predates this work). Mobile
`expo export --platform ios` bundles, so every new import resolves. `createPresignedPost` was
called locally with dummy credentials and its policy inspected: conditions come out as
`content-length-range 1–104857600`, `eq $Content-Type`, and eq-bound `Content-Type` /
`Cache-Control` / `bucket` / `key`. **No test from §15 has been run** — all of them need a
device build, a live bucket, or both.
