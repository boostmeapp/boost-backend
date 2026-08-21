# Iteration 4 — Preloading, Disk Cache & Cold Start

**Scope:** frontend only. No backend change, no new dependency.
**Closes:** D-37 … D-41.
**Depends on:** Iteration 1 (measured index arithmetic — the prefetch trigger hangs off
`commitIndex`), Iteration 3 (`videoUrl` arrives ready-to-use from the server).

---

## 1. Objective

Stop waiting. Today the first byte of a video is requested at the moment the item is
already on screen; this iteration makes the next video's bytes arrive **before** the user
swipes, and makes the first video's bytes start arriving **before** the feed screen even
mounts.

Three separate latencies, three separate fixes:

| Latency | Today | After |
|---|---|---|
| Swipe → first frame of the next video | full network round-trip + buffer, every time | file already on disk, or already buffering |
| Launch → first frame of the first video | 2 s splash + 2 AsyncStorage reads + feed fetch + *then* the video request | feed fetch starts during the splash; video request starts as soon as the feed lands |
| Re-watch of a video seen earlier | full re-download from Stockholm | disk cache hit |

---

## 2. Problems addressed

### 2.1 Nothing is prefetched (D-37)

There is no warm-up path anywhere in the feed. The sequence for every single video is:

```
item scrolls into view
  → FlatList renders the cell
    → <Video> mounts
      → expo-av opens a connection to boostme-storage.s3.eu-north-1
        → bytes start arriving
          → enough buffered to decode
            → first frame
```

Every one of those arrows is serial, and the first three cannot begin until the swipe has
already finished. From Stockholm to a device on 4G outside Europe that is comfortably a
second of dead time per swipe, on top of TCP+TLS setup, on a file with no `faststart` atom
(D-44) so the player may have to range-request the tail before it can decode anything.

### 2.2 The cache that exists is dead code, and would not help if it weren't (D-38, D-39)

[videoCacheService.js](newboostraapp/src/services/videoCacheService.js) implements exactly
the right shape — `getCachedUrl`, `downloadVideo`, `cacheNextVideos(videos, currentIndex)`
with `PRELOAD_COUNT = 3`. Verified: **zero imports across `newboostraapp/src`.**

And if you simply wired it up as written, it would still be close to useless:

```js
// videoCacheService.js:7-20
async initialize() {
    const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (dirInfo.exists) {
        await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });   // ← every launch
    }
```

It wipes the whole cache on every launch, so there is no cross-session benefit at all. It
also has no size cap and no eviction, so within one long session it grows without bound
until the OS evicts the app's cache directory (or the device runs out of space). And
`downloadAsync` writes directly to the final path, so a download interrupted by a
backgrounded app leaves a **truncated file at the real filename** — which the next
`getCachedUrl` reports as a cache hit, and the player then fails to open.

`cacheNextVideos` also fires up to 4 concurrent full-file downloads with no queue and no
cancellation, which is the opposite of what you want when the active player needs
bandwidth.

### 2.3 Three to five players all pull bytes at once (D-40)

`windowSize={3}` + `initialNumToRender={2}`
([HomeScreen.jsx:349-352](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L349-L352))
means roughly the cells at `activeIndex - 1`, `activeIndex` and `activeIndex + 1` are
mounted. Each mounted `<Video>` opens its own connection and begins buffering on mount,
because `expo-av` loads on source assignment regardless of `shouldPlay`.

That is not *entirely* bad — it is the only reason the feed feels tolerable today, since
`activeIndex + 1` gets an accidental head start. But it is unscheduled: all three compete
for the same socket budget at exactly the moment the visible one is trying to reach its
first decodable frame. The visible video is the one that loses, because it starts last.

### 2.4 Cold start is serial and padded (D-41)

```
App launch
 └─ RootLayout mounts
     ├─ SplashScreen.hideAsync() immediately
     ├─ a black GIF overlay is force-shown for a hardcoded 2000 ms   ← _layout.jsx:37
     └─ prepare(): await getUserData() → await getAccessToken() → store.login()
 └─ app/index.jsx mounts
     ├─ ANOTHER await getAccessToken() + await getUserData()          ← index.jsx:21-22
     └─ router.replace('/home')
 └─ HomeScreen mounts
     └─ useEffect → fetchVideos() → GET /feed/global
 └─ setVideos(...) → FlatList renders item 0
 └─ <Video> mounts and only NOW requests the MP4
```

Two independent facts make this bad:

- The 2000 ms GIF overlay is a **fixed** cost that overlaps with *nothing*. During it, the
  app could be fetching the feed and warming the first video; instead it idles.
- `index.jsx` re-reads the exact two AsyncStorage keys `_layout.jsx`'s `prepare()` already
  read, and `router.replace('/home')` is gated behind that second read completing.

Add a cold Render instance and the whole chain can run into tens of seconds.

---

## 3. Approach

1. **Rewrite `videoCacheService`** into something that survives launches: persistent, size-capped
   with true LRU eviction, atomic writes via a `.part` file, in-flight de-duplication, a
   single-slot queue, and cancellation.
2. **Prefetch on settle, not on render.** `commitIndex` (iteration 1) enqueues `N+1` then
   `N+2` and cancels anything for items now behind the cursor.
3. **Schedule the neighbour player.** Mount `activeIndex + 1`'s `<Video>` only after the
   active item reports `isLoaded`, so the visible video gets the bandwidth first.
   `activeIndex - 1` renders poster-only.
4. **Resolve the source once per item**, preferring a cached local file, and never swap the
   source after playback has started.
5. **Overlap the cold start.** Kick the feed fetch from `_layout.jsx`'s `prepare()`,
   in parallel with the splash animation; dismiss the splash when the feed lands (bounded
   below and above); delete the duplicate AsyncStorage reads in `index.jsx`.
6. **(Optional sub-task)** Now that files land on disk, extract a poster frame *locally* for
   coverless videos — closing the long tail that iteration 2 deliberately left open.

---

## 4. Why this approach

**Why a full-file disk cache rather than tuning the player's buffer.** `expo-av` exposes no
buffer configuration — there is no `preferredForwardBufferDuration`, no `minBufferMs`. The
only lever available at this layer is "is the file already on the device". That changes
next-video start latency from *network-bound* to *disk-bound*, which is the single largest
available win before touching delivery (iteration 5) or the player engine (iteration 6).

**Why LRU with a hard byte cap, tracked in AsyncStorage.** `FileSystem.getInfoAsync`
returns `modificationTime`, which does not update on *read* — so it cannot express
recency-of-use, only recency-of-write. A separate index keyed by cache filename, holding
`{ size, lastAccess }`, is a dozen lines and gives real LRU. The cap matters because
`FileSystem.cacheDirectory` is subject to OS reclamation under storage pressure: an
unbounded cache does not just waste space, it makes the OS delete your files at
unpredictable times.

**Why `.part` + `moveAsync` rather than downloading straight to the target.** A truncated
file at the real filename is worse than no file, because every subsequent lookup reports a
hit and every playback fails. Writing to `${name}.part` and renaming only on a verified
200 makes a partial download invisible. `moveAsync` within the same filesystem is atomic.

**Why prefetch only 2 ahead, not the 3 the dead service used.** Each item is a full,
untranscoded, uncapped-resolution MP4 (D-49 — the picker uses `quality: 1`). Three of those
in flight is tens of megabytes of speculative traffic on a mobile plan for content the user
may never reach. Two is enough to cover a normal swipe cadence; the queue depth of one
means the third never starts until the second finishes, which is a natural throttle.

**Why gate the neighbour player on the active one being loaded.** This is the smallest
change that converts uncoordinated contention into a priority order. The visible video
gets the whole pipe until it can decode; only then does its successor start warming. It
also composes correctly with the disk cache: if `N+1` is already on disk, its "load" is
instant and the gate costs nothing.

**Why never swap the source mid-playback.** `expo-av` treats a source change as a fresh
load — position resets, the surface goes black, buffering restarts. A cache download that
completes while its video is playing must not be used until the next time that item mounts.
Resolving the source exactly once per `item.id` makes this structural rather than a rule
someone has to remember.

**Why not reduce `windowSize`.** Dropping to `windowSize={1}` would kill the accidental
head start that currently makes the feed bearable, and this iteration replaces that
accident with a scheduled version rather than removing it. Leave the windowing alone;
control the *player mounting* instead.

---

## 5. Exact frontend changes

### 5.1 Rewrite — `src/services/videoCacheService.js`

Replace the file entirely.

```js
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { log } from '@/utils/log';

const CACHE_DIR   = (FileSystem.cacheDirectory || FileSystem.documentDirectory) + 'videos/';
const INDEX_KEY   = '@videoCache/index/v1';
const MAX_BYTES   = 400 * 1024 * 1024;   // hard cap
const TARGET_BYTES = 320 * 1024 * 1024;  // evict down to this when the cap is hit

/** Stable, collision-free filename for a remote URL (path only — ignore query). */
const filenameFor = (url) => {
    const path = String(url).split('?')[0];
    let h = 5381;
    for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
    const ext = (path.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'mp4').toLowerCase();
    return `${h.toString(36)}.${ext}`;
};

let index = null;                 // { [filename]: { size, lastAccess } }
let indexDirty = false;
const inFlight = new Map();       // url -> { promise, resumable }
let queue = [];                   // urls waiting for the single download slot
let active = null;                // url currently downloading

const loadIndex = async () => {
    if (index) return index;
    try { index = JSON.parse((await AsyncStorage.getItem(INDEX_KEY)) || '{}'); }
    catch { index = {}; }
    return index;
};

const persistIndex = async () => {
    if (!indexDirty) return;
    indexDirty = false;
    try { await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index || {})); } catch {}
};

const videoCacheService = {
    /**
     * Ensure the directory exists. Deliberately does NOT clear it — the whole
     * point of a disk cache is that it survives launches.
     */
    async initialize() {
        await loadIndex();
        const info = await FileSystem.getInfoAsync(CACHE_DIR);
        if (!info.exists) {
            await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
        }
        // Reconcile: drop index entries whose file the OS reclaimed.
        const names = info.exists ? await FileSystem.readDirectoryAsync(CACHE_DIR) : [];
        const present = new Set(names);
        for (const name of Object.keys(index)) {
            if (!present.has(name)) { delete index[name]; indexDirty = true; }
        }
        // Drop orphaned .part files from interrupted downloads.
        await Promise.all(
            names.filter(n => n.endsWith('.part'))
                 .map(n => FileSystem.deleteAsync(CACHE_DIR + n, { idempotent: true }).catch(() => {})),
        );
        await persistIndex();
    },

    /** Local file URI if cached, else null. Touches LRU on a hit. */
    async getCachedUri(url) {
        if (!url) return null;
        await loadIndex();
        const name = filenameFor(url);
        if (!index[name]) return null;

        const uri = CACHE_DIR + name;
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists || info.size === 0) {
            delete index[name]; indexDirty = true; persistIndex();
            return null;
        }
        index[name].lastAccess = Date.now();
        indexDirty = true;
        persistIndex();
        return uri;
    },

    /** Queue a download. At most one runs at a time. Safe to call repeatedly. */
    prefetch(url) {
        if (!url || !url.startsWith('http')) return;
        if (inFlight.has(url) || queue.includes(url) || active === url) return;
        queue.push(url);
        this._pump();
    },

    /** Drop anything not in `keep` from the queue and cancel the active download if stale. */
    cancelExcept(keep = []) {
        const keepSet = new Set(keep.filter(Boolean));
        queue = queue.filter(u => keepSet.has(u));
        if (active && !keepSet.has(active)) {
            const entry = inFlight.get(active);
            entry?.resumable?.cancelAsync?.().catch(() => {});
        }
    },

    async _pump() {
        if (active || queue.length === 0) return;
        const url = queue.shift();
        active = url;

        const name = filenameFor(url);
        const finalUri = CACHE_DIR + name;
        const partUri  = finalUri + '.part';

        const run = (async () => {
            const existing = await this.getCachedUri(url);
            if (existing) return existing;

            const resumable = FileSystem.createDownloadResumable(url, partUri);
            inFlight.set(url, { resumable });

            try {
                const res = await resumable.downloadAsync();
                if (!res || res.status !== 200) throw new Error(`status ${res?.status}`);

                const info = await FileSystem.getInfoAsync(partUri);
                if (!info.exists || info.size === 0) throw new Error('empty download');

                // Atomic: the real filename only ever appears complete.
                await FileSystem.moveAsync({ from: partUri, to: finalUri });

                await loadIndex();
                index[name] = { size: info.size, lastAccess: Date.now() };
                indexDirty = true;
                await persistIndex();
                await this._evictIfNeeded();

                log('[CACHE] stored', name, Math.round(info.size / 1024) + 'kb');
                return finalUri;
            } catch (e) {
                await FileSystem.deleteAsync(partUri, { idempotent: true }).catch(() => {});
                return null;
            } finally {
                inFlight.delete(url);
            }
        })();

        inFlight.set(url, { ...(inFlight.get(url) || {}), promise: run });
        await run;
        active = null;
        this._pump();
    },

    async _evictIfNeeded() {
        await loadIndex();
        let total = Object.values(index).reduce((s, e) => s + (e.size || 0), 0);
        if (total <= MAX_BYTES) return;

        const byAge = Object.entries(index).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        for (const [name, entry] of byAge) {
            if (total <= TARGET_BYTES) break;
            await FileSystem.deleteAsync(CACHE_DIR + name, { idempotent: true }).catch(() => {});
            total -= entry.size || 0;
            delete index[name];
            indexDirty = true;
        }
        await persistIndex();
    },
};

export default videoCacheService;
```

### 5.2 New hook — `src/hooks/useCachedVideoSource.js`

```js
import { useEffect, useRef, useState } from 'react';
import videoCacheService from '@/services/videoCacheService';

/**
 * Resolves a playable source exactly ONCE per item.
 *
 * expo-av treats a source change as a fresh load — position resets and the
 * surface goes black — so a download that finishes mid-playback must not be
 * swapped in. It will be picked up the next time this item mounts.
 */
export default function useCachedVideoSource(url) {
    const [source, setSource] = useState(null);
    const resolvedFor = useRef(null);

    useEffect(() => {
        if (!url) { setSource(null); resolvedFor.current = null; return; }
        if (resolvedFor.current === url) return;
        resolvedFor.current = url;

        let alive = true;
        setSource({ uri: url });                     // stream immediately…
        videoCacheService.getCachedUri(url).then((local) => {
            // …and upgrade to the local file only if we already had it before
            // the player did anything with the remote URI.
            if (alive && local && resolvedFor.current === url) setSource({ uri: local });
        }).catch(() => {});

        return () => { alive = false; };
    }, [url]);

    return source;
}
```

> The `setSource({ uri: url })` first / upgrade-second ordering matters: `getCachedUri`
> hits AsyncStorage and the filesystem, which is a tick or two. Rendering the remote URI
> first means a cache **miss** costs nothing; a cache **hit** swaps within the same frame
> budget, before `expo-av` has issued a request. If T-4.9 shows a visible flash on hits,
> flip it to render nothing until the check resolves — the check is fast enough that a
> one-frame delay is preferable to a double load.

### 5.3 `src/context/VideoPlaybackContext.js` — add scheduling state

```diff
     const [activeVideoId, setActiveVideoId] = useState(null);
+    const [activeIndex, setActiveIndexState] = useState(0);
+    const [activeReady, setActiveReady] = useState(false);
     const [isAppActive, setIsAppActive] = useState(true);
     const [isScreenFocused, setIsScreenFocused] = useState(true);
@@
     const setActiveVideo = useCallback((id) => {
         setActiveVideoId((prev) => (prev === id ? prev : id));
+        setActiveReady(false);          // the new active item has not loaded yet
     }, []);
+
+    const setActiveIndex = useCallback((i) => {
+        setActiveIndexState((prev) => (prev === i ? prev : i));
+    }, []);
+
+    /** Called by the active item the first time expo-av reports isLoaded. */
+    const markActiveReady = useCallback(() => setActiveReady(true), []);
```

Add `activeIndex`, `setActiveIndex`, `activeReady`, `markActiveReady` to the memoised
`value` and its dependency array.

### 5.4 `src/screens/home/screens/HomeScreen.jsx`

**(a) Initialise the cache once, at mount:**

```js
useEffect(() => { videoCacheService.initialize().catch(() => {}); }, []);
```

**(b) Extend `commitIndex`** (from iteration 1 §5.3(d) / iteration 2 §6.7(b)):

```js
const commitIndex = React.useCallback((offsetY) => {
    if (!viewportHeight) return;
    const list = useStore.getState().videos;
    if (list.length === 0) return;

    const raw = Math.round(offsetY / viewportHeight);
    const idx = Math.max(0, Math.min(raw, list.length - 1));
    if (idx === activeIndexRef.current) return;

    activeIndexRef.current = idx;
    setActiveVideo(list[idx].id);
    setActiveIndex(idx);                      // ← new, drives player mounting
    setLastScrollIndex(idx);

    // Posters (cheap, from iteration 2)
    for (let i = 1; i <= 2; i++) {
        const n = list[idx + i];
        if (n?.thumbnailUrl) Image.prefetch(n.thumbnailUrl).catch(() => {});
    }

    // Videos: warm N+1 then N+2, and stop wasting bandwidth on anything behind us.
    const wanted = [list[idx + 1]?.videoUrl, list[idx + 2]?.videoUrl].filter(Boolean);
    videoCacheService.cancelExcept(wanted);
    wanted.forEach((u) => videoCacheService.prefetch(u));
}, [viewportHeight, setActiveVideo, setActiveIndex, setLastScrollIndex]);
```

**(c) Warm the first two items as soon as a feed page lands.** At the end of the successful
branch of `fetchVideos`:

```js
// The item the user is about to see is streaming already; warm the next two.
mappedVideos.slice(1, 3).forEach((v) => v.videoUrl && videoCacheService.prefetch(v.videoUrl));
```

**(d) Skip the fetch when the splash already did it** — the mount effect
([HomeScreen.jsx:281-290](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L281-L290))
already reads `if (videos.length === 0) fetchVideos()`, which is exactly right once
`_layout.jsx` populates the store. No change needed; just do not regress it.

### 5.5 `src/screens/home/components/FeedPostItem.jsx`

**(a) Take `index`, read the schedule from context:**

```js
const { activeVideoId, activeIndex, activeReady, isAppActive, isScreenFocused, markActiveReady }
    = useVideoPlayback();

const isFocused = useMemo(
    () => item.id === activeVideoId && isAppActive && isScreenFocused,
    [item.id, activeVideoId, isAppActive, isScreenFocused],
);

// Mount a player for the visible item always; for its successor only once the
// visible one can decode, so the visible one gets the bandwidth first.
const shouldMountPlayer = useMemo(() => {
    if (isFocused) return true;
    if (index === activeIndex) return true;                 // focused-but-backgrounded
    if (index === activeIndex + 1) return activeReady;      // scheduled warm-up
    return false;                                           // behind us: poster only
}, [isFocused, index, activeIndex, activeReady]);
```

**(b) Cached source:**

```js
const videoSource = useCachedVideoSource(item.videoUrl);
```

replacing the `useMemo` from iteration 1 §5.4(e). The `null`-guard behaviour is preserved
because the hook returns `null` for a falsy url.

**(c) Signal readiness** in `handleStatus` (iteration 1 §5.4(f)):

```diff
     if (!loadedRef.current) {
         loadedRef.current = true;
         setIsVideoLoaded(true);
+        if (focusRef.current) markActiveReady();
     }
```

**(d) Gate the element:**

```jsx
{shouldMountPlayer && videoSource ? (
    <Video ref={videoRef} source={videoSource} ... />
) : (
    <View style={[styles.video, { backgroundColor: '#0B151B' }]} />
)}
```

The `FeedPoster` from iteration 2 sits above this and is `visible={!isVideoLoaded || !isPlaying}`,
so an unmounted-player cell shows its cover — which is what "poster only" means.

### 5.6 `src/app/_layout.jsx` — overlap the cold start

```jsx
const SPLASH_MIN_MS = 800;    // let the GIF actually be seen
const SPLASH_MAX_MS = 2500;   // never hold the user hostage to a cold Render instance

export default function RootLayout() {
  const [isSplashGifFinished, setIsSplashGifFinished] = useState(false);
  const [feedReady, setFeedReady] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => { SplashScreen.hideAsync().catch(() => {}); }, []);

  // Dismiss when the feed has landed, but never before MIN and never after MAX.
  useEffect(() => {
    const elapsed = Date.now() - startedAt.current;
    if (feedReady) {
      const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
      const t = setTimeout(() => setIsSplashGifFinished(true), wait);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setIsSplashGifFinished(true), Math.max(0, SPLASH_MAX_MS - elapsed));
    return () => clearTimeout(t);
  }, [feedReady]);

  useEffect(() => {
    async function prepare() {
      try {
        const [user, token] = await Promise.all([
          storageService.getUserData(),
          storageService.getAccessToken(),
        ]);

        if (user && token) {
          useStore.getState().login(user);
          useStore.getState().setBootstrapped(true);
          configurePurchases(user._id || user.id).catch(() => {});
          followService.getFollowing(user._id || user.id).then(/* unchanged */);
        } else {
          useStore.getState().setBootstrapped(true);
        }

        // Fetch the feed NOW, in parallel with the splash animation, instead of
        // waiting for HomeScreen to mount. apiClient reads the token from storage
        // itself, so this is correct for both signed-in and guest launches.
        await videoCacheService.initialize().catch(() => {});
        const res = await videoService.getAllVideos({ limit: 20 });
        if (res.success) {
          const mapped = res.data.map(mapFeedVideo);        // shared mapper — see below
          useStore.getState().setVideos(mapped);
          useStore.getState().setNextCursor(res.nextCursor ?? null);
          useStore.getState().setHasNextPage(res.nextCursor != null);
          mapped.slice(1, 3).forEach(v => v.videoUrl && videoCacheService.prefetch(v.videoUrl));
        }
      } catch (e) {
        // A failed prefetch must never block launch; HomeScreen will retry.
      } finally {
        setFeedReady(true);
      }
    }
    prepare();
  }, []);
  ...
```

This requires extracting the feed mapper out of `HomeScreen` so both callers use it:

**New file — `src/screens/home/mapFeedVideo.js`.** Move the body of the `result.data.map(...)`
callback ([HomeScreen.jsx:198-232](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L198-L232))
verbatim into an exported `mapFeedVideo(video, { feedType } = {})`, importing
`toMediaUrl` / `toPosterUrl` from `@/utils/media`. `HomeScreen` then imports it. This is a
pure move — do it as its own commit so a regression is trivially bisectable.

Add `bootstrapped: false, setBootstrapped: (v) => set({ bootstrapped: v })` to the auth
slice in `src/store/index.js`.

### 5.7 `src/app/index.jsx` — stop re-reading AsyncStorage

```diff
   useEffect(() => {
-    const initializeApp = async () => {
-      try {
-        const token = await storageService.getAccessToken();
-        const userData = await storageService.getUserData();
-        if (token && userData) { login(userData); setLandingUser(userData); setIsLoggedIn(true); }
-      } catch (e) { console.error(e); }
-      finally { setIsLoading(false); }
-    };
-    initializeApp();
-  }, []);
+    // _layout.jsx's prepare() already read these two keys and populated the store.
+    // Reading them again here just delays router.replace by two more round-trips.
+    if (!bootstrapped) return;
+    const u = useStore.getState().user;
+    setLandingUser(u);
+    setIsLoggedIn(!!u);
+    setIsLoading(false);
+  }, [bootstrapped]);
```

with `const bootstrapped = useStore((s) => s.bootstrapped);` above.

### 5.8 Optional sub-task — local poster extraction for coverless videos

This closes the long tail that iteration 2 left open (old rows with `thumbnailUrl: ''`),
and it is only possible now that files land on disk. Ship it **as a separate commit** so it
can be reverted without touching the cache.

In `FeedPostItem`, after the `posterUri` memo:

```js
const [derivedPoster, setDerivedPoster] = useState(null);

useEffect(() => {
    // Only for the visible item, only when there is no real cover, and only
    // against a LOCAL file — never a remote URL (that was D-21).
    if (posterUri || !isFocused || !item.videoUrl) return;
    let alive = true;
    videoCacheService.getCachedUri(item.videoUrl).then((local) => {
        if (!alive || !local) return;
        return VideoThumbnails.getThumbnailAsync(local, { time: 500 })
            .then((r) => { if (alive && r?.uri) setDerivedPoster(r.uri); });
    }).catch(() => {});
    return () => { alive = false; };
}, [posterUri, isFocused, item.videoUrl]);
```

and pass `posterUri={posterUri || derivedPoster}` to `FeedPoster`. Re-import
`expo-video-thumbnails` in this file for this sub-task only.

Note the poster arrives *after* playback starts, so it does not help the current view — it
helps when the user swipes back to that item. That is a real but modest benefit; if T-4.16
shows any frame cost, drop this sub-task. The proper fix is server-side extraction
(iteration 5).

### 5.9 Files touched

```
newboostraapp/src/services/videoCacheService.js          (full rewrite)
newboostraapp/src/hooks/useCachedVideoSource.js          (new)
newboostraapp/src/screens/home/mapFeedVideo.js           (new — pure move out of HomeScreen)
newboostraapp/src/context/VideoPlaybackContext.js        (+activeIndex, +activeReady)
newboostraapp/src/screens/home/screens/HomeScreen.jsx    (prefetch, cache init, mapper import)
newboostraapp/src/screens/home/components/FeedPostItem.jsx (player gating, cached source)
newboostraapp/src/app/_layout.jsx                        (parallel bootstrap, adaptive splash)
newboostraapp/src/app/index.jsx                          (drop duplicate storage reads)
newboostraapp/src/store/index.js                         (+bootstrapped)
newboostraapp/src/app/video/[id].jsx                     (pass index; set activeIndex)
```

---

## 6. Backend changes

**None.**

---

## 7. Caching / preloading / buffering / autoplay / pagination / API / delivery / performance

| Area | Change |
|---|---|
| **Caching** | A real persistent disk cache: 400 MB cap, LRU eviction to 320 MB, an AsyncStorage index, atomic `.part` writes, orphan reconciliation on launch. Survives app restarts, so a re-watch is a disk read. |
| **Preloading** | Two videos ahead, one at a time, cancelled when the user scrolls past them. First page's items 1 and 2 warmed during the splash. Posters (from iteration 2) unchanged at 2 ahead. |
| **Buffering** | Scheduled instead of contended: `activeIndex + 1`'s player mounts only after `activeIndex`'s reports `isLoaded`. `activeIndex - 1` no longer holds a player at all. |
| **Autoplay** | Unchanged semantics; the `shouldPlay` single-controller from iteration 1 is untouched. A cell with no mounted player simply shows its poster. |
| **Pagination** | Unchanged (cursor pagination from iteration 3). Prefetch respects page boundaries naturally — `list[idx + 1]` is undefined at the tail and nothing is enqueued. |
| **API** | Unchanged. The feed request just moves earlier in the launch sequence. |
| **Delivery** | Unchanged host. Cache hits mean fewer origin requests, which is a direct cost reduction on S3 egress and pre-pays for iteration 5. |
| **Performance** | Cold start loses the fixed 2 s floor and two AsyncStorage round-trips. Concurrent video connections per settle drop from ~3 to 1 (+1 scheduled). Memory is bounded rather than growing with session length. |

---

## 8. Expected behaviour after this iteration

1. Swiping to the next video shows a frame near-instantly when it was prefetched — the
   common case at normal scroll speed.
2. Swiping back to a previously watched video starts immediately from disk.
3. Killing and relaunching the app still hits the cache for recently watched videos.
4. Launch reaches the first frame noticeably sooner; on a warm API the splash dismisses
   early rather than always burning 2 s.
5. On a cold Render instance the splash still dismisses at 2.5 s and the feed loading state
   takes over — the user is never held on the GIF.
6. Only the visible video competes for bandwidth until it can decode.
7. Storage used by the app plateaus; it does not grow without bound over a long session.
8. Backgrounding mid-download leaves no corrupt cache entry — the next launch cleans the
   `.part` file up.

**Still outstanding:** playback still originates in Stockholm, and files are still
non-faststart single-rendition MP4s, so a *cache miss* is as slow as it was. → Iteration 5.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Prefetch eats a user's mobile data.** Two uncompressed originals per settle, on `quality: 1` uploads, is potentially 20–60 MB per two swipes. | **High — this is the biggest risk in the iteration** | Three layers: (a) iteration 2 already capped the picker at `quality: 0.8` / 180 s; (b) iteration 5 introduces transcoding, which is the real fix; (c) **ship a "Data saver" toggle in settings that sets prefetch depth to 0**, and consider defaulting prefetch to 1 rather than 2 until transcoding lands. Measure with T-4.13 before deciding. |
| A prefetch saturates the link and *slows* the active video | Medium | The single-slot queue plus `cancelExcept` bounds it to one concurrent download, and the scheduled-neighbour gate means the active player is never competing with two things. If T-4.6 regresses vs iteration 1, reduce prefetch depth to 1. |
| `createDownloadResumable` / `cancelAsync` behaves differently on `expo-file-system@19`'s legacy shim | Medium | Verify in isolation first (T-4.1) before wiring it into the feed. If `cancelAsync` is unavailable, fall back to letting the download finish — the queue still bounds concurrency. |
| AsyncStorage index and the filesystem drift (OS reclaims `cacheDirectory` under pressure) | Medium | `initialize()` reconciles both directions on every launch, and `getCachedUri` re-verifies with `getInfoAsync` before returning a hit. |
| Two `FeedPostItem`s both call `markActiveReady`, or it fires for a non-active item | Low | Guarded by `focusRef.current` at the call site, and `setActiveVideo` resets `activeReady` to `false` on every settle. |
| Moving the feed fetch into `_layout.jsx` fires it on **every** app launch including deep links into non-feed screens | Medium | That is acceptable — it is one 20-item request and it warms the Render instance. But confirm it does not double-fetch: `HomeScreen`'s mount effect must see `videos.length > 0` and skip (T-4.11). |
| The extracted `mapFeedVideo` diverges from what `HomeScreen` did | Medium | Do the extraction as a **pure move** in its own commit with no behaviour change, verify the feed is identical, then build on it. |
| Splash dismisses at 800 ms on a fast connection and feels abrupt | Low | Tune `SPLASH_MIN_MS`. It is a product judgement, not a correctness issue. |
| Cache filename hash collision | Very low | djb2 over the full path with a 36-radix suffix; keys already contain a uuid. If paranoid, append the path length to the name. |
| Local thumbnail extraction (§5.8) costs frames on the UI thread | Medium | It is an isolated optional commit with its own test (T-4.16). Revert it alone if it costs anything. |

---

## 10. Test plan

Release bundle, physical devices, warmed API. For the network tests, use a throttled
connection profile (Charles/Network Link Conditioner at "3G" ≈ 780 kbps down, 100 ms RTT) —
on office wifi every one of these tests passes trivially and tells you nothing.

### Phase A — the cache in isolation

| # | Test | How | Pass |
|---|---|---|---|
| T-4.1 | **Resumable download + cancel work on this SDK** | A scratch screen: `prefetch(url)`, then `cancelExcept([])` after 300 ms | No unhandled rejection. No `.part` left behind after `initialize()` runs next launch. |
| T-4.2 | **Atomic write** | `prefetch(url)`, kill the app mid-download, relaunch | `getCachedUri(url)` returns `null` (not a truncated file). No `.part` in the directory after `initialize()`. |
| T-4.3 | **Persistence across launches** | Watch 3 videos. Force-quit. Relaunch. | `getCachedUri` returns a local path for all 3. |
| T-4.4 | **Eviction** | Temporarily set `MAX_BYTES = 30 * 1024 * 1024`, prefetch 10 videos | Directory size stays ≤ 30 MB. The **oldest-accessed** files are the ones gone. Restore the constant. |
| T-4.5 | **De-duplication** | Call `prefetch(sameUrl)` 5 times rapidly | Exactly one network request (verify in the proxy). |

### Phase B — feed behaviour

| # | Test | Steps | Pass |
|---|---|---|---|
| T-4.6 | **Swipe latency, throttled** | 3G profile. 20 swipes at a normal cadence (≈2 s per video). Screen recording. | Median swipe→first-frame **≤ 400 ms**, p90 **≤ 900 ms**. Compare against the `T-swipe` baseline in `00-OVERVIEW.md`; expect ≥ 60 % improvement at the median. |
| T-4.7 | **Fast-scroll does not stall** | 3G profile. 30 rapid flicks. | No item takes > 3 s to show a frame. `cancelExcept` is doing its job — verify in the proxy that requests for skipped items are aborted. |
| T-4.8 | **Backward swipe is instant** | Watch 5 videos, then swipe back through all 5 | Each shows a frame in < 200 ms (disk). |
| T-4.9 | **No double-load on a cache hit** | Proxy trace while swiping to a prefetched item | **Zero** network requests for that video's key at playback time. No visible black flash on the swap. |
| T-4.10 | **No mid-playback source swap** | Start item N (cache miss, streaming). Let its prefetch finish while it plays. | Playback does **not** restart, does not go black, position keeps advancing. |
| T-4.11 | **No double fetch on launch** | Proxy trace on cold launch | Exactly **one** `GET /feed/global`. `HomeScreen` does not issue a second. |
| T-4.12 | **Only one video downloads at a time** | Proxy trace during a settle | At most 2 concurrent connections to the media host (the active player + one prefetch), never 3+. Baseline was 3–5. |
| T-4.13 | **Data usage per 10 videos watched** | Reset OS per-app data counter, watch exactly 10 videos end to end, read the counter | Record the number. Compare to (sum of those 10 file sizes) × 1.2. If it exceeds 1.5×, prefetch depth is too aggressive — reduce to 1. |
| T-4.14 | **Storage plateaus** | Watch 40 videos in one session, check app storage in OS settings | ≤ 400 MB + app size. Monotonic growth is a fail. |
| T-4.15 | **Neighbour scheduling** | Instrument `markActiveReady` and the `<Video>` mount of `activeIndex + 1` with timestamps | The `+1` player mounts **after** the active reports loaded, never before. |
| T-4.16 | **Local poster extraction (optional sub-task)** | With §5.8 in, watch a coverless video, swipe away, swipe back | The second visit shows a real frame. Frame rate during the extraction is within 5 % of T-1.17. If not, revert §5.8. |

### Phase C — cold start

| # | Test | Steps | Pass |
|---|---|---|---|
| T-4.17 | **Warm-API launch** | Warm the API. Force-quit. Screen-record a cold launch, count frames to first video frame. 5 runs. | Median **T-launch ≤ 60 %** of the `00-OVERVIEW.md` baseline. |
| T-4.18 | **Cold-API launch** | Let Render go cold (or block the API with a proxy delay of 20 s). Launch. | Splash dismisses at ~2.5 s. The "Loading Feed…" state appears. **No** indefinite GIF, no crash, and the feed appears when the API responds. |
| T-4.19 | **Offline launch** | Airplane mode, force-quit, relaunch | Splash dismisses at 2.5 s. Empty/error state shown. No crash, no hang. |
| T-4.20 | **Signed-in vs guest launch** | Both paths, 3 runs each | Both reach the feed. Signed-in still shows correct `hasLiked` (iteration 3 must not regress). |
| T-4.21 | **Deep link launch** | Cold-launch straight into `/video/[id]` via the URL scheme | Works. The background feed fetch does not interfere or crash. |

### Phase D — regression

| # | Test | Pass |
|---|---|---|
| T-4.22 | Re-run T-1.2, T-1.3, T-1.4, T-1.5 | Identical results. |
| T-4.23 | Re-run T-2.14, T-2.15 (black-gap tests) | Still 0/20. |
| T-4.24 | Re-run T-3.19 (duplicate ids over 60 items) | Still zero. |
| T-4.25 | Frame rate, 15 s continuous flick, vs T-1.17 | Within 5 %, or better. |

---

## 11. Success criteria

- [ ] **Median swipe→first-frame ≤ 400 ms and p90 ≤ 900 ms on a 3G profile** (T-4.6), and at least a 60 % median improvement over the baseline. This is the headline number.
- [ ] Backward swipes to watched videos show a frame in **< 200 ms** (T-4.8).
- [ ] **Zero** network requests at playback time for an item that was prefetched (T-4.9).
- [ ] **Zero** mid-playback source swaps (T-4.10).
- [ ] **≤ 2** concurrent connections to the media host at any moment (T-4.12). Baseline was 3–5.
- [ ] Cache survives a force-quit (T-4.3) and never exceeds its cap (T-4.4, T-4.14).
- [ ] A killed mid-download leaves **no** usable-looking corrupt file (T-4.2).
- [ ] **Median T-launch ≤ 60 %** of the baseline on a warm API (T-4.17).
- [ ] Splash always dismisses within 2.5 s, including offline and cold-API (T-4.18, T-4.19).
- [ ] Exactly **one** `GET /feed/global` on cold launch (T-4.11).
- [ ] Data usage for 10 watched videos is **≤ 1.5×** the sum of their file sizes (T-4.13) — or prefetch depth was reduced to 1 and this was re-measured.
- [ ] `grep -rn "videoCacheService" newboostraapp/src` returns **more than the definition** — i.e. it is no longer dead code.
- [ ] `grep -rn "deleteAsync(CACHE_DIR" newboostraapp/src` shows no unconditional wipe on `initialize`.
- [ ] Full regression sweep clean (T-4.22 … T-4.25).
