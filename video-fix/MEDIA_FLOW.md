# Boostra — Media Flow (video + image), post-Iteration-7

Every path media takes through the app, in order, with the file and line that implements each
step. Written against the tree on 2026-08-22.

Two independent pipelines:

- **Video** — compressed on device, uploaded **direct to S3** via a presigned POST. The API
  never sees a media byte.
- **Image** — compressed on device, uploaded **through the API** (three multipart endpoints).
  Kept proxied because images are under 1 MB after compression and `/upload/profile-image`
  does server-side work.

---

## 0. The constants everything is measured against

All limits and presets live in one file: [`newboostraapp/src/constants/media.js`](newboostraapp/src/constants/media.js)

| Constant | Value | Line | Enforced where |
|---|---|---|---|
| `MAX_VIDEO_INPUT_BYTES` | 250 MB | [:7](newboostraapp/src/constants/media.js#L7) | Mobile only, before compression |
| `MAX_VIDEO_DURATION_S` | 180 s | [:8](newboostraapp/src/constants/media.js#L8) | Mobile only, from `asset.duration` |
| `MAX_VIDEO_UPLOAD_BYTES` | 100 MB | [:10](newboostraapp/src/constants/media.js#L10) | Mobile + backend presign + **S3 (authoritative)** |
| `MAX_IMAGE_INPUT_BYTES` | 10 MB | [:11](newboostraapp/src/constants/media.js#L11) | Mobile only, before compression |
| `MAX_IMAGE_UPLOAD_BYTES` | 1 MB | [:12](newboostraapp/src/constants/media.js#L12) | Mobile + backend multer |
| `IMAGE_PRESETS` | COVER / AVATAR / CHAT | [:14](newboostraapp/src/constants/media.js#L14) | `compressImage` |
| `VIDEO_PRESET` | 1920 px @ 3.5 Mbps | [:26](newboostraapp/src/constants/media.js#L26) | `compressVideo` pass 1 |
| `VIDEO_SECOND_PASS` | 1280 px @ 2.0 Mbps | [:28](newboostraapp/src/constants/media.js#L28) | `compressVideo` pass 2 |
| `VIDEO_SKIP_BELOW_BYTES` | 8 MB | [:31](newboostraapp/src/constants/media.js#L31) | skip-if-already-small |
| `UPLOAD_PROGRESS_WEIGHTS` | compress .30 / upload .65 / publish .05 | [:35](newboostraapp/src/constants/media.js#L35) | progress tracker |
| `UPLOAD_MAX_ATTEMPTS` / backoff | 3 / 1s,4s,9s | [:40-41](newboostraapp/src/constants/media.js#L40-L41) | retry loop |
| `UPLOAD_STALL_TIMEOUT_MS` | 60 s | [:43](newboostraapp/src/constants/media.js#L43) | stall detector |
| `UPLOAD_DRAFT_KEY` | AsyncStorage key | [:48](newboostraapp/src/constants/media.js#L48) | resume/retry draft |

Backend mirror: `MAX_VIDEO_UPLOAD_SIZE` [upload.service.ts:39](boost-backend/src/modules/upload/upload.service.ts#L39),
`MAX_IMAGE_UPLOAD_SIZE` [:41](boost-backend/src/modules/upload/upload.service.ts#L41).

---

## 1. VIDEO — publish flow, end to end

```
pick → validate → compress → presign → POST to S3 → upload cover → POST /videos
```

### 1.1 Pick and validate

| Step | Code |
|---|---|
| User taps the upload card, picker opens (no `quality`/`videoMaxDuration` — both are no-ops for a library video pick) | [UploadScreen.jsx:54](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L54) |
| Size gate (250 MB) then duration gate (180 s), returns `{ ok, reason }` | [mediaValidation.js:33](newboostraapp/src/utils/mediaValidation.js#L33) |
| Rejection surfaces as a modal, nothing is uploaded | [UploadScreen.jsx:69](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L69) |
| Auto cover extracted from frame at 500 ms | [UploadScreen.jsx:75](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L75) |

> **Order matters:** size is checked before duration, so a 300 MB / 12-minute file reports the
> size error, not the duration one.

### 1.2 Publish is delegated to one lifecycle object

`UploadScreen` holds no transport state — it creates a manager and calls `run()`.

| Step | Code |
|---|---|
| Resolve the cover URI (custom → auto → extract now) | [UploadScreen.jsx:120-137](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L120-L137) |
| `inFlightRef` guard against double-publish | [UploadScreen.jsx:123](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L123) |
| Manager created with progress + status callbacks | [UploadScreen.jsx:144](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L144) |
| `manager.run({ videoAsset, coverUri, meta })` | [UploadScreen.jsx:151](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L151) |
| Cancel button → `manager.cancel()` | [UploadScreen.jsx:178](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L178) |
| The whole lifecycle | [mediaUploadManager.js:239](newboostraapp/src/services/mediaUploadManager.js#L239) |

### 1.3 Compress

| Step | Code |
|---|---|
| Probe bytes / duration / resolution via `getVideoMetaData` | [mediaCompression.js:144](newboostraapp/src/utils/mediaCompression.js#L144) |
| **Skip** if ≤ 8 MB *and* ≤ 1920 px long edge | [mediaCompression.js:186-195](newboostraapp/src/utils/mediaCompression.js#L186-L195) |
| Pass 1 — 1920 px @ 3.5 Mbps, H.264, via `react-native-compressor` | [mediaCompression.js:159](newboostraapp/src/utils/mediaCompression.js#L159) |
| Pass 2 — 1280 px @ 2.0 Mbps, only if pass 1 exceeded 100 MB | [mediaCompression.js:207-217](newboostraapp/src/utils/mediaCompression.js#L207-L217) |
| Hard failure if still over the ceiling | [mediaCompression.js:219](newboostraapp/src/utils/mediaCompression.js#L219) |
| Compressed file cached in the draft so a retry never re-encodes | [mediaUploadManager.js:253-283](newboostraapp/src/services/mediaUploadManager.js#L253-L283) |
| Screen stays awake for the whole run | [mediaUploadManager.js:245](newboostraapp/src/services/mediaUploadManager.js#L245) |

**Not set by this stage:** frame rate, keyframe interval, and `faststart` container layout —
`react-native-compressor` exposes only bitrate and max dimension. A server-side remux still
owns those.

### 1.4 Presign

| Step | Code |
|---|---|
| Client asks the API to authorise one upload | [uploadService.js:107](newboostraapp/src/services/uploadService.js#L107) |
| Route `POST /upload/presign` (JWT-guarded) | [upload.controller.ts:28](boost-backend/src/modules/upload/upload.controller.ts#L28) |
| Request DTO — every field must be declared or `forbidNonWhitelisted` 400s it | [presign-upload.dto.ts:16](boost-backend/src/modules/upload/dto/presign-upload.dto.ts#L16) |
| Video-only guard, content-type guard, 100 MB guard | [upload.service.ts:118-131](boost-backend/src/modules/upload/upload.service.ts#L118-L131) |
| Key minted server-side: `videos/{userId}/{ts}-{uuid}.{ext}` | [upload.service.ts:188](boost-backend/src/modules/upload/upload.service.ts#L188) |
| `createPresignedPost` with `content-length-range` + `eq $Content-Type` | [upload.service.ts:135-148](boost-backend/src/modules/upload/upload.service.ts#L135-L148) |
| `Cache-Control: immutable` baked into the signed fields | [upload.service.ts:48](boost-backend/src/modules/upload/upload.service.ts#L48) |

> **Why POST and not PUT:** a presigned PUT cannot bound the request body — the client could
> declare 5 MB and send 5 GB. Only presigned POST carries `content-length-range`, which makes
> **S3 itself** the authoritative size gate (`400 EntityTooLarge`).

### 1.5 Upload to S3

| Step | Code |
|---|---|
| Retry loop, 3 attempts, reuses one key across attempts | [mediaUploadManager.js:162](newboostraapp/src/services/mediaUploadManager.js#L162) |
| One attempt + stall detector (`createUploadTask` has no timeout option) | [mediaUploadManager.js:116](newboostraapp/src/services/mediaUploadManager.js#L116) |
| The actual POST — `parameters: fields` then the file field last | [uploadService.js:135](newboostraapp/src/services/uploadService.js#L135) |
| Shared multipart primitive with real bytes-sent progress | [uploadService.js:44](newboostraapp/src/services/uploadService.js#L44) |
| 403 → presign expired → re-presign and retry | [mediaUploadManager.js:184](newboostraapp/src/services/mediaUploadManager.js#L184) |
| Other 4xx → permanent, no retry | [mediaUploadManager.js:186](newboostraapp/src/services/mediaUploadManager.js#L186) |
| Draft persisted so a retry reuses the same S3 key (no orphans, no duplicates) | [mediaUploadManager.js:76](newboostraapp/src/services/mediaUploadManager.js#L76) |
| Presign freshness check before reuse | [mediaUploadManager.js:92](newboostraapp/src/services/mediaUploadManager.js#L92) |

`expo-file-system` writes form `parameters` **before** the file part on both platforms
(iOS `NetworkingHelpers.swift:createMultipartBody`, Android `FileSystemLegacyModule.kt:910-918`),
which is what S3's presigned-POST parser requires.

### 1.6 Cover upload, then publish the row

| Step | Code |
|---|---|
| Cover compressed with the `COVER` preset, then uploaded | [mediaUploadManager.js:215](newboostraapp/src/services/mediaUploadManager.js#L215) |
| A failed cover is non-fatal — publishes coverless, never the video URL | [mediaUploadManager.js:230](newboostraapp/src/services/mediaUploadManager.js#L230) |
| `POST /videos` with `rawVideoKey` + `thumbnailKey` | [video.controller.ts:25](boost-backend/src/modules/video/video.controller.ts#L25) |
| Payload contract | [create-video.dto.ts:43](boost-backend/src/modules/video/dto/create-video.dto.ts#L43) |
| **Key ownership + existence assertions** | [video.service.ts:31](boost-backend/src/modules/video/video.service.ts#L31) |
| Applied to `rawVideoKey` (with size ceiling) and `thumbnailKey` | [video.service.ts:81-90](boost-backend/src/modules/video/video.service.ts#L81-L90) |
| `HeadObject` backing the existence check | [upload.service.ts:167](boost-backend/src/modules/upload/upload.service.ts#L167) |

`assertOwnedObject` rejects three ways: key not prefixed `videos/{callerId}/` → **403**;
no object in S3 → **400**; object over the ceiling → **400**. Creates only — it never
re-validates existing rows.

### 1.7 Progress

Composite of three measured phases, monotonic by construction.

| Step | Code |
|---|---|
| Weighted tracker | [uploadProgress.js:8](newboostraapp/src/utils/uploadProgress.js#L8) |
| `Math.max(current, next)` — the bar can never regress | [uploadProgress.js:14](newboostraapp/src/utils/uploadProgress.js#L14) |
| Phase → status text mapping | [mediaUploadManager.js:104](newboostraapp/src/services/mediaUploadManager.js#L104) |

`compress` is fed by the encoder callback, `upload` by `totalBytesSent / totalBytesExpectedToSend`,
`publish` by the cover upload and `POST /videos` resolving. No hardcoded constant anywhere in
the path.

---

## 2. IMAGE — four entry points, one pipeline

All four call `validateImageInput` → `compressImage` → an upload method, then delete the temp file.

| # | Surface | Preset | Pick site | Compress + upload |
|---|---|---|---|---|
| 1 | Cover at publish (custom pick) | `COVER` | [UploadScreen.jsx:84](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L84) | via manager [mediaUploadManager.js:215](newboostraapp/src/services/mediaUploadManager.js#L215) |
| 2 | Cover at publish (auto frame) | `COVER` | [UploadScreen.jsx:75](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L75) | same path — **the auto frame is often the largest image in the flow** |
| 3 | Cover on edit | `COVER` | [FeedPostItem.jsx:144](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L144) | [FeedPostItem.jsx:185](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L185) |
| 4 | Profile photo (Edit Profile) | `AVATAR` | [EditProfileScreen.jsx:179](newboostraapp/src/screens/home/screens/EditProfileScreen.jsx#L179), [:198](newboostraapp/src/screens/home/screens/EditProfileScreen.jsx#L198) | [EditProfileScreen.jsx:218](newboostraapp/src/screens/home/screens/EditProfileScreen.jsx#L218) |
| 5 | Profile photo (Settings) | `AVATAR` | [SettingsScreen.jsx:152](newboostraapp/src/screens/home/screens/SettingsScreen.jsx#L152), [:171](newboostraapp/src/screens/home/screens/SettingsScreen.jsx#L171) | [SettingsScreen.jsx:191](newboostraapp/src/screens/home/screens/SettingsScreen.jsx#L191) |
| 6 | Chat attachment | `CHAT` | [chat/[id].jsx:333](newboostraapp/src/app/chat/[id].jsx#L333) | [chat/[id].jsx:377](newboostraapp/src/app/chat/[id].jsx#L377) |

### 2.1 Compression algorithm

[mediaCompression.js:55](newboostraapp/src/utils/mediaCompression.js#L55)

1. Reject above 10 MB before doing any work.
2. Render once to read true dimensions from the `ImageRef`.
3. **Skip** if already under the preset target *and* within the max edge.
4. Loop up to 4 times: resize to max edge → JPEG encode at quality → measure. If over target,
   drop quality by 0.10 (floor 0.50); at the floor, shrink the edge by 20 %.
5. Reject if still over 1 MB.
6. If the re-encode came out *larger* than the input, keep the original.

A single `{maxEdge, quality}` pair cannot guarantee a byte ceiling — JPEG size varies by an
order of magnitude with image content — hence measure-and-retry. **EXIF (including GPS) is
dropped by the re-encode**, so location data stops reaching S3.

Preset targets: COVER 1280 px / q0.75 / ≤400 KB · AVATAR 512 px / q0.80 / ≤150 KB ·
CHAT 1600 px / q0.75 / ≤700 KB. All under the 1 MB hard ceiling.

### 2.2 Upload

| Endpoint | Client | Controller | S3 prefix |
|---|---|---|---|
| `POST /upload/thumbnail` | [uploadService.js:173](newboostraapp/src/services/uploadService.js#L173) | [upload.controller.ts:119](boost-backend/src/modules/upload/upload.controller.ts#L119) | `thumbnails/{userId}/` |
| `POST /upload/profile-image` | [uploadService.js:182](newboostraapp/src/services/uploadService.js#L182) | [upload.controller.ts:38](boost-backend/src/modules/upload/upload.controller.ts#L38) | `profiles/{userId}/` |
| `POST /upload/image` (chat) | [uploadService.js:192](newboostraapp/src/services/uploadService.js#L192) | [upload.controller.ts:82](boost-backend/src/modules/upload/upload.controller.ts#L82) | `chat/{userId}/` |

Shared server-side write: [upload.service.ts:250](boost-backend/src/modules/upload/upload.service.ts#L250) —
validates size, mints the key, `PutObject` with `Cache-Control: immutable`, returns a **public**
(never presigned) URL. Key layout: [upload.service.ts:188](boost-backend/src/modules/upload/upload.service.ts#L188).
Upload types: [upload-type.enum.ts](boost-backend/src/modules/upload/dto/upload-type.enum.ts).

> `uploadChatImage` has **no fallback to `uploadProfileImage`**
> ([uploadService.js:191](newboostraapp/src/services/uploadService.js#L191)). It used to, and
> since `/upload/profile-image` writes `users.profileImage` server-side, a failed chat
> attachment silently became the user's avatar.

> ⚠️ **`chat/` needs an S3 policy grant.** The backend IAM user is scoped to `videos/*`,
> `thumbnails/*`, `profiles/*` — verified by probe. Chat uploads fail with `AccessDenied` on
> `PutObject` until `chat/*` is added to both the IAM policy and the public-read bucket policy.

---

## 3. DELIVERY — how media comes back out

The backend is the single source of truth for URLs; the client composes nothing.

| Step | Code |
|---|---|
| Key → absolute CloudFront URL; legacy absolute S3 URLs are rewritten onto the CDN host | [media-url.service.ts:26](boost-backend/src/common/services/media-url.service.ts#L26) |
| User serialiser — puts `profileImage` on the CDN host | [media-url.service.ts:40](boost-backend/src/common/services/media-url.service.ts#L40) |
| Feed wire format (`videoUrl`, `thumbnailUrl`, `user`) | [feed.service.ts:56](boost-backend/src/modules/feed/feed.service.ts#L56) |
| Single video (`GET /videos/:id`) | [video.service.ts:193](boost-backend/src/modules/video/video.service.ts#L193) |
| `GET /users/:id/profile` | [users.service.ts:132](boost-backend/src/modules/users/users.service.ts#L132) |
| `PATCH /users/me/profile-image` and `PATCH /users/me` | [users.service.ts:176](boost-backend/src/modules/users/users.service.ts#L176) |
| Chat images are presigned on read | [chat.service.ts:22](boost-backend/src/modules/chat/chat.service.ts#L22) |

`toPublicUser` is applied at **all four** user-serialisation sites, so avatars no longer bypass
CloudFront. A user with no avatar returns `null` (not `''`) — both falsy, so the client's
`ui-avatars` fallback still fires.

Client side:

| Step | Code |
|---|---|
| Pass-through for absolute URLs, prefix for bare keys | [media.js:16](newboostraapp/src/utils/media.js#L16) |
| Poster URL, rejecting anything ending in a video extension | [media.js:24](newboostraapp/src/utils/media.js#L24) |
| Feed mapping | [HomeScreen.jsx:41-42](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L41-L42) |
| Next-two poster prefetch | [HomeScreen.jsx:129](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L129) |
| Poster, with deterministic gradient fallback | [FeedPoster.jsx:7](newboostraapp/src/screens/home/components/FeedPoster.jsx#L7) |

---

## 4. Where the limits actually bite

| Layer | Video | Image |
|---|---|---|
| Mobile, pre-compression | 250 MB + 180 s | 10 MB |
| Mobile, post-compression | 100 MB | 1 MB |
| Backend presign | 100 MB vs declared `fileSize` | n/a |
| **S3** | `content-length-range` — **authoritative** | n/a |
| Backend multer | n/a (no proxied video route) | 1 MB |

The client is an optimisation, never an enforcement point. A patched or stale client still
cannot get an oversized object into the bucket, because S3 rejects the body itself.

---

## 5. Reading the logs

Mobile logging is `__DEV__`-gated ([log.js](newboostraapp/src/utils/log.js)), so it compiles out
of release builds. Backend uses `console`, so it lands in Render logs.

| Tag | Where | Shows |
|---|---|---|
| `[compress:image:PRESET]` | mediaCompression | `IN` size+dims → per-attempt edge/quality/result → `OUT` with saving % · `SKIPPED` · `REVERTED` · `FAILED` |
| `[compress:video]` | mediaCompression | `IN` size/res/duration → `pass 1` → `pass 2` → `OUT` with saving % |
| `[upload:presign]` | uploadService | request meta → `granted key=…` or `DENIED <status>` |
| `[upload:s3]` | uploadService | `POST <bytes>` → `ACCEPTED <status> in Xs (Y MB/s)` or `REJECTED` with S3's XML |
| `[upload:<method>]` | uploadService | image upload `OK`/`FAILED`/`ERROR` |
| `[publish]` | mediaUploadManager | `START` → per-phase timings → retries → `DONE`/`CANCELLED`/`ABORTED` |
| `[presign]` `[head]` `[publish]` `[upload]` | backend | grant/deny, HeadObject hit/miss, key assertions, row created |

---

## 6. Test media

`videos/` in the repo root holds downloaded samples, named by the gate each one exercises:
`over250_*` hit the input-size gate, `under250_*` clear it but hit the 180 s duration gate, and
`compresses_sintel_trailer_1080p_14MB.mp4` (0:52, 13.9 MB) is the only one that clears both and
actually runs compression.

To exercise compression on something genuinely large you need ≤180 s at high bitrate — a
30-second 4K/60 phone recording lands around 200 MB, which is the "large input, compressed
output" case.
