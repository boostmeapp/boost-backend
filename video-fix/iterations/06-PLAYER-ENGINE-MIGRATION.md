# Iteration 6 — Player Engine Migration (`expo-av` → `expo-video`), Preroll & Optional ABR

**Scope:** frontend rewrite of the player layer, plus an optional backend HLS pipeline.
**Closes:** D-48. Completes D-44.
**Depends on:** all of 1–5. Do this last.

> Three stages, shipped separately. Stage 1 is mandatory (the app cannot move to Expo
> SDK 55 without it). Stage 2 is where the remaining perceived latency goes. Stage 3 is
> **conditional** — read §4.C before committing to it, because it retires the disk cache
> you built in iteration 4.

| Stage | What | Mandatory? |
|---|---|---|
| **1** | 1:1 `expo-av` → `expo-video` migration, semantics preserved | Yes |
| **2** | Player pool + explicit preroll + buffer tuning | Strongly recommended |
| **3** | HLS ABR ladder | Only if measurements justify it |

---

## 1. Objective

Replace the deprecated player with the supported one, and in doing so gain the two controls
`expo-av` never offered: **explicit buffer configuration** and **players that exist before
their view does**. Those are what turn "the next video loads fast" into "the next video is
already decoded and paused on frame one".

---

## 2. Problems addressed

### 2.1 `expo-av` is deprecated and removed in SDK 55 (D-48)

[package.json:23](newboostraapp/package.json#L23) pins `expo-av@~16.0.8` on Expo SDK 54
([package.json:21](newboostraapp/package.json#L21)). `expo-av`'s `Video` component is
deprecated in favour of `expo-video` and is removed in SDK 55. Every SDK upgrade from here
is blocked on this migration. This is a deadline, not a preference.

### 2.2 The `expo-av` render model is the root cause of half of iteration 1's work

```js
// node_modules/expo-av/build/Video.js:237-266
const status = { ...this.props.status };
['progressUpdateIntervalMillis','positionMillis','shouldPlay','rate', ...]
  .forEach((prop) => { if (prop in this.props) status[prop] = this.props[prop]; });
```

Playback state is pushed to native **on every render**, from props. That is why the
imperative `pauseAsync()` in `togglePlayPause` could never win
([FeedPostItem.jsx:307-313](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L307-L313)),
and why iteration 1 had to make the declarative prop the single authority. It works, but it
means playback is coupled to React's render cycle.

`expo-video` inverts this: the player is an imperative object with a lifetime independent of
any component, and the view is a thin surface attached to it. `player.pause()` is
authoritative, full stop. There is no render that can undo it.

### 2.3 There is no way to buffer ahead

`expo-av` exposes no buffer configuration at all. Iteration 4 worked around this at the
file level — download the whole file to disk — which is effective but blunt: it spends the
user's data on entire videos to save the first two seconds of one.

`expo-video` exposes `player.bufferOptions`, so you can ask for exactly the forward buffer
you want, and `createVideoPlayer()` lets a player exist and buffer while its `VideoView` is
not mounted. That is the actual mechanism short-form feeds use.

### 2.4 The HLS scaffolding is still fiction (D-44, remainder)

`manifestUrl`, `chunks: VideoChunk[]` with `quality`/`resolution`/`bitrate`/`playlistUrl`/
`segmentPattern`/`segmentDuration`/`totalSegments`
([video.schema.ts:18-78](boost-backend/src/database/schemas/video/video.schema.ts#L18-L78)),
`VIDEO_QUALITIES=360p,720p,1080p` and `VIDEO_CHUNK_DURATION=4` in `.env`, and
`ENV.VIDEO_QUALITIES` / `ENV.VIDEO_CHUNK_DURATION`
([env.ts:119-127](boost-backend/src/config/env.ts#L119-L127)) all describe an ABR pipeline
that does not exist. Iteration 5 built the ffmpeg infrastructure that would make it
possible. Stage 3 either finishes it or formally deletes the scaffolding — leaving it as a
third state is how the next engineer wastes a week.

---

## Stage 1 — 1:1 migration

### 3.1 Approach

Install `expo-video`, replace the `<Video>` element in the two files that use it for
playback, and preserve iteration 1's semantics exactly: one authority, `userPaused` state,
transition-only React updates. Change nothing else. This stage should produce **no
observable behaviour difference**; that is how you know it is correct.

### 4.1 Why a straight port first

The temptation is to migrate and adopt the player pool in one change. Don't: the pool
changes lifetime management, the migration changes the API, and if a video stops playing
you will not know which one did it. A 1:1 port is verifiable against iteration 1's test
plan line by line — every test should give an identical result.

### 5.1 Exact changes

**Install:**

```bash
npx expo install expo-video
# expo-av stays installed until Stage 1 is verified on both platforms.
```

`expo-video` requires a native rebuild (`expo run:android` / `expo run:ios` or a new EAS
build) — it will not work in an existing dev client that lacks the module.

If you want background audio or PiP, add the config plugin in `app.json`; the feed needs
neither, so the default (no plugin entry) is correct.

**API mapping — verify each against the installed version's `.d.ts` before relying on it:**

| `expo-av` | `expo-video` |
|---|---|
| `<Video source={{uri}} />` | `const player = useVideoPlayer(source, setup)` + `<VideoView player={player} />` |
| `shouldPlay={bool}` | `player.play()` / `player.pause()` |
| `isLooping` | `player.loop = true` (in the setup callback) |
| `resizeMode="cover"` | `contentFit="cover"` on `VideoView` |
| `usePoster` / `posterSource` | *(not used — `FeedPoster` from iteration 2 is the poster)* |
| `onPlaybackStatusUpdate` | `useEvent(player, 'statusChange')`, `useEvent(player, 'playingChange')`, `useEvent(player, 'timeUpdate')` |
| `progressUpdateIntervalMillis` | `player.timeUpdateEventInterval = 1` (seconds) |
| `playAsync()` / `pauseAsync()` | `player.play()` / `player.pause()` |
| `unloadAsync()` | automatic for `useVideoPlayer`; `player.release()` for `createVideoPlayer` |
| `setStatusAsync({ positionMillis })` | `player.currentTime = seconds` |
| `isMuted` | `player.muted` |
| *(none)* | `player.bufferOptions` ← the new capability |
| *(none)* | `createVideoPlayer(source)` ← the other new capability |

**`FeedPostItem.jsx`** — replace the player block:

```jsx
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';

// videoSource comes from useCachedVideoSource (iteration 4 §5.2) — an { uri } object,
// which expo-video accepts directly.
const player = useVideoPlayer(shouldMountPlayer ? videoSource : null, (p) => {
    p.loop = true;
    p.muted = false;
    p.timeUpdateEventInterval = 1;
});

// Single authority, same as iteration 1: one effect, one input, one output.
useEffect(() => {
    if (!player) return;
    if (isFocused && !userPaused) player.play();
    else player.pause();
}, [player, isFocused, userPaused]);

// Transition-only React state, same as iteration 1 §5.4(f).
const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player?.playing ?? false });
const { status }    = useEvent(player, 'statusChange',  { status: player?.status ?? 'idle' });

useEffect(() => {
    if (status === 'readyToPlay' && !loadedRef.current) {
        loadedRef.current = true;
        setIsVideoLoaded(true);
        if (focusRef.current) markActiveReady();          // iteration 4 §5.5(c)
    }
}, [status, markActiveReady]);
```

The watch-reward logic that lived inside `onPlaybackStatusUpdate`
([FeedPostItem.jsx:511-523](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L511-L523))
moves to a `timeUpdate` listener:

```js
useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (focusRef.current && currentUser && !hasSentRewardRef.current && currentTime >= 10) {
        hasSentRewardRef.current = true;
        rewardService.recordWatch(item.id, Math.floor(currentTime));
        setHasSentReward(true);
    }
});
```

Note `currentTime` is **seconds**, not milliseconds — the old code compared against
`positionMillis >= 10000`. Getting this wrong means the reward fires 1000× too early or
never. Cover it explicitly in T-6.6.

The view:

```jsx
{shouldMountPlayer && videoSource ? (
    <VideoView
        player={player}
        style={styles.video}
        contentFit="cover"
        nativeControls={false}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
    />
) : (
    <View style={[styles.video, { backgroundColor: '#0B151B' }]} />
)}
```

`videoRef` and the `unloadAsync` cleanup from iteration 1 §5.4(h) are deleted —
`useVideoPlayer` releases the player when the component unmounts.

**`UploadScreen.jsx`** also imports `Video` from `expo-av`
([UploadScreen.jsx:22, 236-243](newboostraapp/src/screens/home/screens/UploadScreen.jsx#L236-L243))
for the small preview thumbnail. Migrate it too — it is four lines — so `expo-av` can be
uninstalled.

**Then, only after both platforms pass:**

```bash
npm uninstall expo-av
```

`grep -rn "expo-av" newboostraapp/src` must return nothing.

### 10.1 Test plan — Stage 1

The test is: **iteration 1's entire test plan, re-run, unchanged results.**

| # | Test | Pass |
|---|---|---|
| T-6.1 | Re-run T-1.1 … T-1.20 in full, on all three devices | Identical results to iteration 1. Any difference is a migration bug. |
| T-6.2 | Re-run T-2.14, T-2.15 (black gaps) | Still 0/20. |
| T-6.3 | Re-run T-4.6, T-4.8, T-4.9, T-4.10 (cache behaviour) | Unchanged. `useCachedVideoSource` still feeds the player and there is still no mid-play source swap. |
| T-6.4 | **Player release** — scroll 100 items, then check native memory | Plateaus. No monotonic climb from unreleased players. This is the classic migration failure. |
| T-6.5 | **Audio session** — play a video, receive a phone call, hang up | Playback pauses and resumes sanely. |
| T-6.6 | **Watch reward timing** — instrument `recordWatch`; watch one video for 30 s | Fires exactly once, at ~10 s, with a seconds value near 10. **Not** at 10 ms, not never. |
| T-6.7 | `grep -rn "expo-av" newboostraapp/src` and `newboostraapp/package.json` | No matches. |
| T-6.8 | Fresh native build installs and runs on both platforms | Yes. |

### 11.1 Success criteria — Stage 1

- [ ] Every iteration-1 test gives an identical result (T-6.1).
- [ ] Native memory plateaus over 100 items (T-6.4).
- [ ] Watch reward fires once, at the right time, in seconds (T-6.6).
- [ ] `expo-av` is uninstalled and ungreppable (T-6.7).
- [ ] Release builds produced and smoke-tested on both platforms (T-6.8).

---

## Stage 2 — Player pool and explicit preroll

### 3.2 Approach

Hold **three** long-lived players at the screen level rather than one per cell:
`previous`, `current`, `next`. On each settle, rotate the pool and call
`replaceAsync(nextItem.source)` on the player that just became `next`, then let it buffer
while paused. Cells receive a player rather than creating one.

Plus: set `player.bufferOptions` so the forward buffer is sized for a short-form feed
rather than the platform default.

### 5.2 Exact changes

**New — `src/hooks/useVideoPlayerPool.js`:**

```js
import { useEffect, useMemo, useRef } from 'react';
import { createVideoPlayer } from 'expo-video';

const BUFFER_OPTIONS = {
    // Short-form: buffer a few seconds forward, not the platform default of tens.
    preferredForwardBufferDuration: 6,
    waitsToMinimizeStalling: false,   // start sooner, tolerate an early stall
};

/**
 * Three long-lived players: [prev, current, next].
 * Rotating instead of creating means the "next" player is already warm when the
 * user swipes, and decoder resources are bounded to three regardless of feed length.
 */
export default function useVideoPlayerPool() {
    const pool = useMemo(
        () => [0, 1, 2].map(() => {
            const p = createVideoPlayer(null);
            p.loop = true;
            p.timeUpdateEventInterval = 1;
            Object.assign(p, { bufferOptions: BUFFER_OPTIONS });
            return p;
        }),
        [],
    );

    useEffect(() => () => pool.forEach(p => p.release()), [pool]);

    const slotRef = useRef(0);   // index in `pool` currently acting as "current"

    /** Assign sources for a new active index. Returns { prev, current, next }. */
    const rotateTo = (items, activeIndex) => {
        const cur  = slotRef.current;
        const next = (cur + 1) % 3;
        const prev = (cur + 2) % 3;
        return { prevPlayer: pool[prev], currentPlayer: pool[cur], nextPlayer: pool[next] };
    };

    return { pool, slotRef, rotateTo };
}
```

**`HomeScreen`** owns the pool and publishes the mapping `videoId -> player` through
`VideoPlaybackContext`. `commitIndex` (iterations 1/4) additionally:

```js
// after setActiveIndex(idx)
const nextItem = list[idx + 1];
if (nextItem?.videoUrl) {
    const src = await resolveSource(nextItem.videoUrl);   // cache-aware, iteration 4
    nextPlayer.replaceAsync(src);                          // buffers while paused
}
```

**`FeedPostItem`** stops calling `useVideoPlayer` and instead reads its player from context
by `item.id`, rendering `<VideoView player={player} />` when one is assigned and the
`FeedPoster` otherwise. The single-authority effect is unchanged — it just operates on a
player it was handed.

### 4.2 Why

**Why three and not more.** Each player holds a hardware decoder session. Android in
particular has a small, device-dependent limit (often 4–8 concurrent H.264 decoders across
the whole system), and exceeding it fails in ways that look like random black frames.
Three covers `prev` (swipe-back), `current` and `next` (preroll), which is the entire
working set of a vertical pager.

**Why `waitsToMinimizeStalling: false`.** For short-form, starting 400 ms sooner and risking
one stall is a better trade than a clean start after a long wait — the user swipes away
from a slow video long before they complain about a stall. Revisit if T-6.13 shows stalls
becoming common.

**Why `preferredForwardBufferDuration: 6`.** Videos are ≤180 s (iteration 2 capped the
picker) and the user's median dwell is a few seconds. Buffering 30 s ahead of a video they
will abandon at second 4 wastes their data and competes with the *next* video's preroll,
which is the thing that actually affects perceived speed.

### 10.2 / 11.2 Test plan and criteria — Stage 2

| # | Test | Pass |
|---|---|---|
| T-6.9 | **Preroll works** — 3G profile, instrument the swipe→first-frame interval, 20 swipes | Median **≤ 150 ms**, p90 **≤ 400 ms**. Compare against iteration 4's T-4.6 numbers. |
| T-6.10 | **Decoder count bounded** — Android, scroll 100 items, `adb shell dumpsys media.player` (or Media3 logs) | Never more than 3 active codec sessions. |
| T-6.11 | **Swipe back is instant** — the `prev` player still holds its source | < 100 ms to first frame. |
| T-6.12 | **No cross-talk** — rapid flicks | Never two players audible. Never the wrong video on screen. (Re-run T-1.2 semantics against the pool.) |
| T-6.13 | **Stall rate** — 3G profile, watch 20 videos to completion | Count stalls > 500 ms. Record. If more than ~1 in 20, raise `preferredForwardBufferDuration` or set `waitsToMinimizeStalling: true`. |
| T-6.14 | **Data usage per 10 videos** — repeat T-4.13 | Should be **lower** than iteration 4's figure if you also reduce the disk prefetch depth now that preroll covers the swipe case. |
| T-6.15 | Full regression: iterations 1–4 test plans | Clean. |

- [ ] Median swipe→first-frame **≤ 150 ms** on 3G (T-6.9).
- [ ] Never more than 3 concurrent decoder sessions (T-6.10).
- [ ] Stall rate ≤ 1 in 20 videos on 3G (T-6.13).
- [ ] Data usage per 10 videos not worse than iteration 4 (T-6.14).
- [ ] Full 1–4 regression clean (T-6.15).

---

## Stage 3 — HLS ABR (conditional)

### 4.C Decide before you build

**Do not start this stage by default.** Run the decision first:

After iteration 5 + Stage 2, measure on a throttled 3G profile:

- stall rate per 20 videos (T-6.13),
- median swipe→first-frame (T-6.9),
- data used per 10 videos (T-6.14).

**Build Stage 3 only if** the stall rate is materially above your target *and* it is driven
by bitrate rather than by latency. If the numbers are acceptable, the correct action is the
opposite one: **delete the scaffolding** — `manifestUrl`, `chunks`, `VideoChunk`,
`VIDEO_QUALITIES`, `VIDEO_CHUNK_DURATION`, `ENV.VIDEO_QUALITIES`,
`ENV.VIDEO_CHUNK_DURATION` — so nobody re-discovers a half-built pipeline in six months.

Three things make HLS a genuine trade-off rather than a strict upgrade here:

1. **It retires iteration 4's disk cache.** You cannot meaningfully `downloadAsync` a
   manifest and its segments through `expo-file-system`. Adopting HLS means giving up
   full-file prefetch and relying entirely on player preroll — which Stage 2 now provides,
   but which is a different performance profile: better on variable networks, worse on
   swipe-back and on re-watch.
2. **Short-form is the weak case for ABR.** The adaptation algorithm needs several segments
   to converge on the right rendition; on a 15-second clip that the user abandons at second
   4, it barely gets started. This is why several large short-form products serve
   progressive MP4 with a server-chosen rendition rather than client-side ABR.
3. **Storage and processing multiply.** Three renditions segmented at 4 s means roughly
   3× the storage and a real transcode per rendition, versus iteration 5's cheap `-c copy`
   remux for most videos.

A cheaper middle option that captures most of the benefit: **have the client request a
rendition**. Produce a 480p and a 720p MP4 in iteration 5's pipeline, add a
`?q=` hint or a client-sent `Save-Data`/connection-type header, and let `MediaUrlService`
pick the key. No manifests, no segments, the disk cache keeps working, and a user on a bad
connection gets a file they can actually stream. Consider this before full HLS.

### 5.C If you do build it

**Backend** — extend iteration 5's `video-processing` job with an `hls` step:

```
ffmpeg -i in.mp4 \
  -filter_complex "[0:v]split=3[v1][v2][v3];[v1]scale=w=640:h=-2[v1out];[v2]scale=w=1280:h=-2[v2out];[v3]scale=w=1920:h=-2[v3out]" \
  -map "[v1out]" -c:v:0 libx264 -b:v:0 800k  -preset veryfast \
  -map "[v2out]" -c:v:1 libx264 -b:v:1 2500k -preset veryfast \
  -map "[v3out]" -c:v:2 libx264 -b:v:2 5000k -preset veryfast \
  -map a:0 -map a:0 -map a:0 -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_segment_filename "out/%v/seg_%03d.ts" \
  -master_pl_name master.m3u8 -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  "out/%v/playlist.m3u8"
```

`-hls_time 4` is exactly `VIDEO_CHUNK_DURATION=4` from `.env`, and the three ladder rungs
correspond to `VIDEO_QUALITIES=360p,720p,1080p` — the scaffolding finally means something.
Skip rungs above the source resolution (do not upscale).

Upload `out/` to `videos/{userId}/hls/{videoId}/`, then write:

```ts
manifestUrl: mediaUrl.toUrl(`videos/${userId}/hls/${videoId}/master.m3u8`),
chunks: [
  { quality: '360p',  resolution: '640x…',  bitrate: 800_000,  playlistUrl: …, segmentPattern: 'seg_%03d.ts', segmentDuration: 4, totalSegments: n },
  { quality: '720p',  … },
  { quality: '1080p', … },
],
```

— the exact shape `VideoChunk` already declares
([video.schema.ts:19-41](boost-backend/src/database/schemas/video/video.schema.ts#L19-L41)).

Add `manifestUrl` to `FEED_PROJECTION` and emit it in `present()` alongside `videoUrl`.
**Keep `videoUrl` populated** — it is the fallback and the swipe-back/disk-cache path.

**CloudFront:** the distribution already exists (Iteration 5 Phase A is done), so this is
adding behaviours to it, not creating one. Manifests and segments need different cache
behaviours from the MP4s.
Add a behaviour for `*.m3u8` with a short TTL (they are VOD and immutable, so a long TTL is
also defensible) and one for `*.ts` with the immutable policy. Confirm `Content-Type` is
`application/vnd.apple.mpegurl` for `.m3u8` and `video/mp2t` for `.ts` — S3 guesses these
wrong and a wrong `Content-Type` on the manifest breaks playback on iOS.

**Frontend:** prefer the manifest when present.

```js
const source = useMemo(
    () => (item.manifestUrl ? { uri: item.manifestUrl } : cachedSource),
    [item.manifestUrl, cachedSource],
);
```

`expo-video` plays HLS natively on both platforms (AVPlayer / Media3) — no extra library.
Note that `useCachedVideoSource` is bypassed for HLS items, which is the tradeoff in §4.C(1).

### 10.3 / 11.3 Test plan and criteria — Stage 3

| # | Test | Pass |
|---|---|---|
| T-6.16 | `curl -sI "https://$CF/…/master.m3u8"` | `200`, `Content-Type: application/vnd.apple.mpegurl`. |
| T-6.17 | `ffprobe "https://$CF/…/master.m3u8"` | Lists all three variants with correct bandwidths. |
| T-6.18 | **Playback on both platforms** | HLS items play; iOS and Android both. |
| T-6.19 | **Adaptation** — start on 3G, switch to wifi mid-video | Rendition steps up within a few segments (verify with a proxy: segment paths change directory). |
| T-6.20 | **Fallback** — a video with `manifestUrl: null` | Plays from `videoUrl`. Mixed feeds of HLS and MP4 items work. |
| T-6.21 | **Stall rate on 3G**, 20 videos | Materially better than the Stage 2 figure from T-6.13. **If it is not, revert Stage 3** — you have paid 3× storage for nothing. |
| T-6.22 | **Swipe-back latency** | Note the regression vs T-6.11 (no disk cache for HLS). Confirm it is acceptable. |
| T-6.23 | Full regression, iterations 1–5 | Clean. |

- [ ] Manifests served with the correct `Content-Type` (T-6.16).
- [ ] Both platforms play HLS (T-6.18).
- [ ] Rendition adapts on a network change (T-6.19).
- [ ] MP4 fallback still works for un-transcoded videos (T-6.20).
- [ ] **Stall rate materially better than Stage 2** (T-6.21). If not, this stage is reverted, not tuned.
- [ ] Swipe-back regression is quantified and accepted (T-6.22).

---

## 7. Caching / preloading / buffering / autoplay / pagination / API / delivery / performance

| Area | Change |
|---|---|
| **Buffering** | First real control: `preferredForwardBufferDuration`, `waitsToMinimizeStalling`. Stage 2 makes the forward buffer a tuned parameter instead of a platform default. |
| **Preloading** | Stage 2 replaces "download the whole next file" with "the next player is already buffering the next file". Iteration 4's disk cache remains valuable for swipe-back and re-watch — keep it, but consider reducing prefetch depth from 2 to 1 once preroll lands (T-6.14). |
| **Autoplay** | Same semantics as iteration 1 (`isFocused && !userPaused`), now enforced by an imperative player that no render can override. |
| **Caching** | Unchanged in Stages 1–2. Stage 3 bypasses the disk cache for HLS items — the main cost of that stage. |
| **Pagination / API** | Unchanged in Stages 1–2. Stage 3 adds `manifestUrl` to the feed projection and response. |
| **Delivery** | Stage 3 adds `.m3u8` / `.ts` cache behaviours and `Content-Type` corrections to CloudFront. |
| **Performance** | Bounded decoder sessions (3). Playback fully decoupled from React's render cycle. `expo-av` removed from the bundle. |

---

## 8. Expected behaviour after this iteration

**After Stage 1:** everything behaves exactly as it did after iteration 5, the app builds
against a supported player, and the SDK 55 upgrade path is open.

**After Stage 2:** swiping feels immediate. The next video is decoded and paused on its
first frame before the swipe finishes, so the poster is replaced by real video within a
frame or two rather than after a network round-trip. Swiping back is instant. Memory and
decoder use are bounded regardless of how far the user scrolls.

**After Stage 3 (if built):** viewers on poor connections get a lower rendition instead of
a stall, and `manifestUrl` / `chunks` / `VIDEO_QUALITIES` finally describe reality.

**If Stage 3 is correctly declined:** the scaffolding is deleted and the schema stops
promising a pipeline that does not exist.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **API drift.** The mapping table above is written against `expo-video` as of SDK 54; event names and `bufferOptions` fields have moved between versions | **High** | Verify every symbol against `node_modules/expo-video/build/*.d.ts` in the version you install, before writing the migration. Treat the table as a guide, not a contract. |
| **Native rebuild required.** `expo-video` will not appear in an existing dev client | Certain | Plan for a new dev client / EAS build before starting. Do not debug "module not found" for an hour. |
| **Unreleased players leak decoders** — the classic migration failure | Medium-High | Stage 1 uses `useVideoPlayer` (auto-released). Stage 2 uses `createVideoPlayer` and **must** release in a cleanup. T-6.4 and T-6.10 exist specifically for this. |
| **`currentTime` is seconds, `positionMillis` was milliseconds** | Medium | T-6.6. A silent 1000× error in the watch-reward path is a payouts bug, not a cosmetic one. |
| **Pool rotation desynchronises from the list** on a fast flick that skips an index | Medium | Rotation is driven by `commitIndex`, which iteration 1 made deterministic and which fires once per settle. Handle the skip case by re-assigning all three sources when `|newIndex - oldIndex| > 1` rather than rotating. Test with T-6.12. |
| **Audio session / focus differs from `expo-av`** | Medium | T-6.5 (phone call) plus a manual check against another audio app. |
| **Stage 3 storage and processing cost** | Medium | Gate on the §4.C decision. Do not build it on principle. |
| **Wrong `Content-Type` on `.m3u8`** silently breaks iOS HLS | Medium | Set it explicitly on upload; verify with T-6.16. S3 will guess `binary/octet-stream` otherwise. |
| **Doing Stages 1 and 2 in one change** | — | Don't. Stage 1's whole value is that it is verifiable by "nothing changed". |

---

## 12. Closing the plan

When this iteration is done, walk the defect register in
[00-OVERVIEW.md](video-fix/00-OVERVIEW.md) top to bottom and confirm every row is either
closed or consciously deferred with a reason. The rows most likely to still be open:

- **D-36** — boosted videos still get no ranking advantage. `getPersonalizedFeed` remains
  unrouted and, as written, unroutable at scale (it loads every ready video into memory).
  This is a revenue feature sitting dark; it deserves its own design: a scheduled job
  writing a precomputed `rankScore`, an index on it, and a keyset paginate over
  `{rankScore: -1, _id: -1}` reusing iteration 3's paginator.
- **D-45** — `processingStatus` is still a constant. Iteration 5 deliberately left it that
  way so a worker outage cannot hide videos; `optimizationStatus` carries the real state.
  Either document that permanently or retire `processingStatus` from the schema.
- **D-49** — the upload picker cap is a client-side hint. Iteration 5's transcode gate is
  the real enforcement; consider also rejecting oversized sources at the presign step.
