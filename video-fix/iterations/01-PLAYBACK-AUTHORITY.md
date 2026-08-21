# Iteration 1 — Playback Authority & Viewport Correctness

**Scope:** frontend only. No backend change, no API change, no infra change, no new
dependency.
**Closes:** D-01 … D-16, D-42.

---

## 1. Objective

Make the feed player **deterministic**: at any moment exactly one video is playing, it is
the one filling the screen, and it stays in whatever play/pause state the user or the
scroll position put it in.

Concretely, after this iteration:

- The active item is chosen by arithmetic on the scroll offset, not by a viewability
  heuristic that can silently not fire.
- The item height used for snapping, layout and the item container is the **measured**
  height of the list viewport, not a module-load snapshot of `Dimensions.get('window')`.
- There is exactly **one** thing that decides play/pause: the `shouldPlay` prop.
- `FeedPostItem` stops re-rendering four times a second per playing video.

This is first because every later iteration is measured by watching the feed, and right
now the feed lies to you about what it is doing.

---

## 2. Problems addressed

### 2.1 The wrong video is selected (D-01)

[HomeScreen.jsx:129-141](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L129-L141)

```js
const onViewableItemsChanged = React.useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) {
        const visibleItem = viewableItems[0];   // ← lowest INDEX, not most visible
```

`viewableItems` is ordered by index. Mid-scroll between item 3 and item 4, both can be
viewable; `viewableItems[0]` is item **3** — the one leaving. The user sees item 4 and
hears item 3.

### 2.2 The selector can fail to fire at all (D-02)

[HomeScreen.jsx:143-146](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L143-L146)

```js
const viewabilityConfig = React.useRef({
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 100
}).current;
```

`minimumViewTime: 100` means an item must hold ≥50 % visibility for 100 ms *continuously*.
During a hard flick past two items, neither intermediate item satisfies that, and — this
is the part that bites — if the settling item's viewability event coalesces with the
scroll end, the callback may be skipped entirely. `activeVideoId` stays on the old item,
so the visible item computes `isFocused === false` and never plays. That is exactly the
reported "the next video is sometimes paused after a swipe".

### 2.3 Item height is a stale global (D-03)

```js
// HomeScreen.jsx:15
const { height } = Dimensions.get('window');

// FeedPostItem.jsx:35 and :1048
const { width, height } = Dimensions.get('window');
container: { width, height, backgroundColor: '#000' },
```

Three independent consumers of one module-load snapshot. `app.json` sets
`"edgeToEdgeEnabled": true` for Android, so the window metric and the actual height the
`FlatList` receives inside its `flex: 1` parent are not guaranteed to agree — and they
differ by the system bar insets on many devices. When `snapToInterval` and `getItemLayout`
use a height that is a few pixels off the real row height, the error accumulates with each
row: by item 10 the scroll offset is out of phase with the index by tens of pixels, and
`Math.round(offset / height)` — or any viewability threshold — starts resolving to the
neighbour.

`CustomTabBar` is `position: 'absolute', bottom: 0`
([CustomTabBar.jsx:134-135](newboostraapp/src/components/CustomTabBar.jsx#L134)), so it
does not shrink the list. The list genuinely is the full height of its parent — which is
exactly why measuring that parent is both correct and easy.

### 2.4 Three controllers fight over play/pause (D-04, D-05)

Inside one component:

```js
// (a) FeedPostItem.jsx:500 — declarative
shouldPlay={isFocused}

// (b) FeedPostItem.jsx:245-253 — imperative effect
useEffect(() => {
    if (!videoRef.current || !isVideoLoaded) return;
    isFocused ? videoRef.current.playAsync() : videoRef.current.pauseAsync();
    setIsPlaying(isFocused);
}, [isFocused, isVideoLoaded]);

// (c) FeedPostItem.jsx:307-313 — imperative tap handler
const togglePlayPause = async () => {
    isPlaying ? await videoRef.current.pauseAsync() : await videoRef.current.playAsync();
    setIsPlaying(!isPlaying);
};
```

`expo-av`'s `Video.render()` collects `shouldPlay` into a `status` object and pushes it to
the native view **on every render**
([node_modules/expo-av/build/Video.js:237-266](newboostraapp/node_modules/expo-av/build/Video.js#L237-L266)).
So the sequence is: user taps → (c) calls `pauseAsync()` → `setIsPlaying(false)` triggers a
re-render → that render re-sends `status.shouldPlay = isFocused = true` → the video resumes.
The pause survives for one frame.

The same render re-reads `this.props.source`, and the app hands it a fresh object literal
`source={{ uri: item.videoUrl }}` every time (D-05), so `expo-av`'s source-diffing can
re-issue a load.

### 2.5 The component re-renders itself four times a second (D-12)

[FeedPostItem.jsx:505-524](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L505-L524)

```js
onPlaybackStatusUpdate={(status) => {
    if (!status.isLoaded) return;
    setIsVideoLoaded(true);        // ← already true; still schedules a render
    setIsPlaying(status.isPlaying); // ← already the same value; still schedules a render
```

`expo-av`'s default `progressUpdateIntervalMillis` is 500 ms, and it also emits on every
buffering transition. React bails out of re-rendering only when `Object.is` says the value
is unchanged **and** it is the only update in the batch — `setIsVideoLoaded(true)` passes
that test, but the pair of them plus the inline arrow callback identity churn does not
reliably bail. In practice this component re-renders 2–4×/s per playing video, and it is
~1050 lines with no `React.memo` (D-13), rendered from an inline arrow `renderItem`
([HomeScreen.jsx:342-348](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L342-L348)),
inside a screen that subscribes to the entire Zustand store (D-14).

> **Correction to the analysis doc.** `VIDEO_FEED_CURRENT_IMPLEMENTATION.md` §5 says the
> root-level `VideoPlaybackProvider` means "every scroll re-renders the whole navigation
> tree". That is not what happens: the provider's `children` prop is a stable element
> object created once in `RootLayout`'s render, and React bails out of re-rendering an
> unchanged `children` element. What *does* happen is that every **context consumer**
> re-renders on every `activeVideoId` change — which is every mounted `FeedPostItem`. The
> fix is therefore `React.memo` + killing the internal state churn, not moving the
> provider. Memoising the context `value`
> ([VideoPlaybackContext.js:23-30](newboostraapp/src/context/VideoPlaybackContext.js#L23-L30))
> is still correct hygiene and is included below, but it is not the main lever.

### 2.6 Latent crashes and dead props (D-06 … D-11, D-15, D-16)

- `handleFollowToggle()` at [FeedPostItem.jsx:625](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L625) is undefined. The defined function is `handleFollow`. Pressing the `+` badge on any avatar throws `ReferenceError`.
- `styles.backButton` at [FeedPostItem.jsx:459](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L459) is not in that file's `StyleSheet` — resolves to `undefined`, so the back button renders unpositioned at the top-left of the flow.
- `initialScrollIndex` at [HomeScreen.jsx:341](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L341) has no `onScrollToIndexFailed`; on a restored session where the row hasn't been measured yet, RN throws.
- `RefreshControl` at [HomeScreen.jsx:361-367](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L361-L367) is attached to a `pagingEnabled` vertical pager and competes with the swipe gesture at offset 0.
- `<Video source={{ uri: item.videoUrl }}>` with `videoUrl: null` (no `rawVideoKey`) is rendered without a guard.
- The sync effect at [FeedPostItem.jsx:235-238](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L235-L238) lists `isGlobalFollowing` as a dependency but resets `isLiked` in the body, so following anyone anywhere in the app silently reverts every optimistic like on screen.
- Nothing ever calls `unloadAsync()`.
- `HomeScreen` passes `isActive`, `video/[id].jsx` passes `isFocused` — `FeedPostItem` reads neither.

---

## 3. Approach

Four changes, in this order:

1. **Measure the viewport, then render the list.** One `onLayout` on the list's parent
   produces `viewportHeight`. `snapToInterval`, `getItemLayout` and the item container all
   consume that single value. The list does not mount until it is known.

2. **Derive the active index from the scroll offset.** Replace `onViewableItemsChanged`
   with `onMomentumScrollEnd` (+ a velocity-gated `onScrollEndDrag` for slow drags that
   never enter momentum). Index is `Math.round(contentOffset.y / viewportHeight)`.
   Deterministic, fires exactly once per settle, cannot pick the outgoing item.

3. **One playback controller.** `shouldPlay={isFocused && !userPaused}` and nothing else.
   Delete the imperative effect. `togglePlayPause` becomes a pure `setUserPaused` toggle.
   `source` is memoised. `onPlaybackStatusUpdate` writes state only on transitions.

4. **Stop the render churn.** `React.memo` on `FeedPostItem`, `useCallback` on
   `renderItem`, per-field Zustand selectors on `HomeScreen`, memoised context value,
   `__DEV__`-gated logging.

---

## 4. Why this approach

**Why offset arithmetic instead of tuning the viewability config.** `viewabilityConfig` is
a *heuristic sampler*: it observes layout and reports what crossed a threshold for long
enough. It has no obligation to fire, and with `pagingEnabled` the information it produces
is redundant — the pager already guarantees the content offset lands on an exact multiple
of the row height. `Math.round(offsetY / rowHeight)` is not an approximation of the active
index; with a pager it *is* the active index. Removing viewability removes a whole class
of "sometimes it doesn't fire" bugs rather than making them rarer.

**Why measure instead of computing the height.** You could try to derive the true row
height from `Dimensions.get('window')` minus insets minus edge-to-edge corrections. That is
a per-OS-version guess. `onLayout` on the actual parent returns the actual number the
actual list actually got, on every device, including after a rotation or a system-bar
visibility change. It costs one extra render on mount.

**Why `shouldPlay` (declarative) rather than imperative `playAsync`/`pauseAsync`.** Given
that `expo-av` re-pushes `shouldPlay` to native on every render, the declarative prop is
guaranteed to win any race against an imperative call. You cannot make the imperative
calls authoritative without stopping the re-renders entirely, which you cannot guarantee.
So make the prop the only writer and give it a state variable (`userPaused`) that the tap
handler can move. Then a re-render re-asserts the state the user actually chose, which is
the behaviour you want anyway.

**Why not migrate to `expo-video` now.** It is the right destination (D-48: `expo-av` is
removed in SDK 55) and it is iteration 6. Doing it here would mean rewriting the player,
the poster, the status handling and the two feed surfaces in the same change as the
active-item logic — with no way to attribute a regression. Iteration 1 must stay boring.

---

## 5. Exact frontend changes

### 5.1 `src/context/VideoPlaybackContext.js`

Memoise the value and drop the per-change log.

```diff
-import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
+import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
@@
     const setActiveVideo = useCallback((id) => {
-        console.log(`[PLAYBACK_AUTHORITY] Authority granted to: ${id}`);
-        setActiveVideoId(id);
+        setActiveVideoId((prev) => (prev === id ? prev : id));
     }, []);
@@
-    const value = {
-        activeVideoId,
-        setActiveVideo,
-        isAppActive,
-        setAppState,
-        isScreenFocused,
-        setScreenFocus,
-    };
+    const value = useMemo(
+        () => ({
+            activeVideoId,
+            setActiveVideo,
+            isAppActive,
+            setAppState,
+            isScreenFocused,
+            setScreenFocus,
+        }),
+        [activeVideoId, setActiveVideo, isAppActive, setAppState, isScreenFocused, setScreenFocus],
+    );
```

The `setActiveVideoId((prev) => prev === id ? prev : id)` guard matters: `commitIndex`
is called on every settle, including settles that land back on the same item, and an
identical-value `setState` on the provider would otherwise still schedule a provider render.

### 5.2 New file — `src/utils/log.js`

```js
export const log = (...args) => { if (__DEV__) console.log(...args); };
export const warn = (...args) => { if (__DEV__) console.warn(...args); };
```

Replace the feed-path `console.log` calls listed in D-42 with `log(...)`, or delete them.
The ones that must go, at minimum:
[HomeScreen.jsx:130, 133, 136, 206](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L130),
[FeedPostItem.jsx:229-230](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L229-L230),
[VideoPlaybackContext.js:11](newboostraapp/src/context/VideoPlaybackContext.js#L11).

### 5.3 `src/screens/home/screens/HomeScreen.jsx`

**(a) Delete the dead `MOCK_POSTS` block** — lines 17-44.

**(b) Replace the store destructure** (lines 59-73) with per-field selectors:

```js
const videos          = useStore((s) => s.videos);
const page            = useStore((s) => s.page);
const hasNextPage     = useStore((s) => s.hasNextPage);
const lastScrollIndex = useStore((s) => s.lastScrollIndex);
const manualRefreshCount = useStore((s) => s.manualRefreshCount);

// action identities are created once by the slice and never change
const setVideos          = useStore((s) => s.setVideos);
const appendVideos       = useStore((s) => s.appendVideos);
const setPage            = useStore((s) => s.setPage);
const setHasNextPage     = useStore((s) => s.setHasNextPage);
const setActiveVideoId   = useStore((s) => s.setActiveVideoId);
const setLastScrollIndex = useStore((s) => s.setLastScrollIndex);
const resetFeedStore     = useStore((s) => s.resetFeedStore);
```

`storeActiveVideoId` is only read once inside the mount effect — read it there with
`useStore.getState().activeVideoId` instead of subscribing to it.

**(c) Add viewport measurement.** New state + a wrapper `View`:

```js
const [viewportHeight, setViewportHeight] = useState(0);

const handleListLayout = React.useCallback((e) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0) setViewportHeight((prev) => (prev === h ? prev : h));
}, []);
```

Wrap the `<FlatList>`:

```jsx
<View style={{ flex: 1 }} onLayout={handleListLayout}>
    {viewportHeight > 0 && (
        <FlatList ... />
    )}
</View>
```

**(d) Replace viewability with offset arithmetic.** Delete `onViewableItemsChanged`
(lines 129-141) and `viewabilityConfig` (lines 143-146). Add:

```js
const activeIndexRef = useRef(-1);

const commitIndex = React.useCallback((offsetY) => {
    if (!viewportHeight) return;
    const list = useStore.getState().videos;          // no stale closure
    if (list.length === 0) return;

    const raw = Math.round(offsetY / viewportHeight);
    const idx = Math.max(0, Math.min(raw, list.length - 1));
    if (idx === activeIndexRef.current) return;

    activeIndexRef.current = idx;
    setActiveVideo(list[idx].id);
    setLastScrollIndex(idx);
}, [viewportHeight, setActiveVideo, setLastScrollIndex]);

const handleMomentumScrollEnd = React.useCallback(
    (e) => commitIndex(e.nativeEvent.contentOffset.y),
    [commitIndex],
);

// A slow drag released with ~zero velocity never enters momentum, so
// onMomentumScrollEnd will not fire. Only commit here in that case —
// committing on a flick would briefly select the mid-flight item.
const handleScrollEndDrag = React.useCallback((e) => {
    const vy = e.nativeEvent.velocity?.y ?? 0;
    if (Math.abs(vy) < 0.05) commitIndex(e.nativeEvent.contentOffset.y);
}, [commitIndex]);
```

**(e) Seed the active item once, after measurement.**

```js
const didSeedRef = useRef(false);
useEffect(() => {
    if (didSeedRef.current) return;
    if (!viewportHeight || videos.length === 0) return;
    didSeedRef.current = true;
    const idx = Math.max(0, Math.min(lastScrollIndex, videos.length - 1));
    activeIndexRef.current = idx;
    setActiveVideo(videos[idx].id);
}, [viewportHeight, videos.length, lastScrollIndex, setActiveVideo]);
```

Reset `didSeedRef.current = false` inside `handleFeedTypeChange` and `handleRefresh`.

Also delete the `setActiveVideo(mappedVideos[0].id)` calls inside `fetchVideos`
(lines 237 and 245) — seeding is now this effect's job, and doing it in both places is how
you get a second authority back.

**(f) Stable `renderItem` and comment handler:**

```js
const openComments = React.useCallback((id) => setCommentVideoId(id), []);

const renderItem = React.useCallback(
    ({ item, index }) => (
        <FeedPostItem
            item={item}
            index={index}
            itemHeight={viewportHeight}
            onCommentPress={openComments}
        />
    ),
    [viewportHeight, openComments],
);
```

Note `isActive` is gone — `FeedPostItem` never read it.

**(g) The `FlatList` block** (lines 338-387) becomes:

```jsx
<FlatList
    ref={listRef}
    data={videos}
    keyExtractor={keyExtractor}
    renderItem={renderItem}
    extraData={viewportHeight}

    initialScrollIndex={lastScrollIndex > 0 ? lastScrollIndex : undefined}
    onScrollToIndexFailed={handleScrollToIndexFailed}

    removeClippedSubviews={true}
    windowSize={3}
    initialNumToRender={2}
    maxToRenderPerBatch={2}
    updateCellsBatchingPeriod={50}

    pagingEnabled
    showsVerticalScrollIndicator={false}
    snapToInterval={viewportHeight}
    snapToAlignment="start"
    disableIntervalMomentum          // ← one page per flick, never two
    decelerationRate="fast"

    onMomentumScrollEnd={handleMomentumScrollEnd}
    onScrollEndDrag={handleScrollEndDrag}

    getItemLayout={getItemLayout}
    onEndReached={handleLoadMore}
    onEndReachedThreshold={0.5}
    ListFooterComponent={...unchanged...}
    ListEmptyComponent={...unchanged, but use viewportHeight...}
/>
```

with, above the return:

```js
const keyExtractor = React.useCallback((item) => String(item.id), []);

const getItemLayout = React.useCallback(
    (_data, index) => ({ length: viewportHeight, offset: viewportHeight * index, index }),
    [viewportHeight],
);

const handleScrollToIndexFailed = React.useCallback((info) => {
    const offset = info.index * viewportHeight;
    listRef.current?.scrollToOffset({ offset, animated: false });
    setTimeout(() => {
        listRef.current?.scrollToIndex({ index: info.index, animated: false });
    }, 60);
}, [viewportHeight]);
```

`disableIntervalMomentum` is the second half of the "one swipe = one video" guarantee: it
stops a hard flick from carrying past the adjacent page, which is the other way the user
ends up on an item that was never committed as active.

**(h) Remove `refreshControl`** (lines 361-367) and the `tintColor` prop with it. Refresh
is already reachable two other ways — tapping the active header tab
([HomeScreen.jsx:99-103](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L99-L103))
and tapping the Home tab in `CustomTabBar` via `triggerManualRefresh`
([CustomTabBar.jsx:20-25](newboostraapp/src/components/CustomTabBar.jsx#L20)). Keep the
`isRefreshing` blocking overlay at lines 396-400; it is the refresh affordance now.

Also drop the `import { RefreshControl }` from line 2.

**(i) `handleRefresh`** — reset the seed flag and drop the `setTimeout` race:

```js
const handleRefresh = React.useCallback(() => {
    didSeedRef.current = false;
    activeIndexRef.current = -1;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    fetchVideos(true, 1);
}, []);
```

### 5.4 `src/screens/home/components/FeedPostItem.jsx`

**(a) Signature and container height.** Replace the module-level height dependency:

```diff
-const { width, height } = Dimensions.get('window');
+const { width } = Dimensions.get('window');
+const FALLBACK_HEIGHT = Dimensions.get('window').height;
@@
-const PostItem = ({ item, onCommentPress, showBack }) => {
+const PostItem = ({ item, index, itemHeight, onCommentPress, showBack }) => {
```

```js
const containerStyle = useMemo(
    () => [styles.container, { height: itemHeight || FALLBACK_HEIGHT }],
    [itemHeight],
);
```

and at line 1048:

```diff
-    container: { width, height, backgroundColor: '#000' },
+    container: { width, backgroundColor: '#000' },
```

Use `<View style={containerStyle}>` at line 455.

**(b) Add the missing style** (D-07), next to `container`:

```js
backButton: {
    position: 'absolute',
    left: 12,
    zIndex: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 20,
    padding: 6,
},
```

**(c) Fix the undefined call** (D-06) at line 625:

```diff
-                                    handleFollowToggle();
+                                    handleFollow();
```

**(d) Single playback controller.** Add near the other state (line 81):

```js
const [userPaused, setUserPaused] = useState(false);
const shouldPlay = isFocused && !userPaused;
```

**Delete** the effect at lines 245-253 in its entirety.

Replace `togglePlayPause` (lines 307-313):

```js
const togglePlayPause = useCallback(() => {
    if (!isFocused) return;
    setUserPaused((p) => !p);
}, [isFocused]);
```

Clear the pending single-tap timer on unmount (it currently can fire after unmount):

```js
useEffect(() => () => {
    if (singleTapTimeoutRef.current) clearTimeout(singleTapTimeoutRef.current);
}, []);
```

**(e) Memoised source + null guard** (D-05, D-10):

```js
const videoSource = useMemo(
    () => (item.videoUrl && item.videoUrl.startsWith('http') ? { uri: item.videoUrl } : null),
    [item.videoUrl],
);
```

**(f) Transition-only status writes** (D-12). Add refs, then rewrite the handler:

```js
const loadedRef  = useRef(false);
const playingRef = useRef(false);
const focusRef   = useRef(isFocused);
useEffect(() => { focusRef.current = isFocused; }, [isFocused]);

const handleStatus = useCallback((status) => {
    if (!status.isLoaded) return;

    if (!loadedRef.current) {
        loadedRef.current = true;
        setIsVideoLoaded(true);
    }
    if (status.isPlaying !== playingRef.current) {
        playingRef.current = status.isPlaying;
        setIsPlaying(status.isPlaying);
    }

    if (
        focusRef.current &&
        currentUser &&
        !hasSentReward &&
        status.positionMillis >= 10000
    ) {
        rewardService.recordWatch(item.id, Math.floor(status.positionMillis / 1000));
        setHasSentReward(true);
    }
}, [currentUser, hasSentReward, item.id]);
```

**(g) The `<Video>` element** (lines 495-525):

```jsx
{videoSource ? (
    <Video
        ref={videoRef}
        source={videoSource}
        style={styles.video}
        resizeMode="cover"
        shouldPlay={shouldPlay}
        isLooping
        progressUpdateIntervalMillis={1000}
        usePoster={false}
        onPlaybackStatusUpdate={handleStatus}
    />
) : (
    <View style={[styles.video, { backgroundColor: '#0B151B' }]} />
)}
```

`usePoster` / `posterSource` / `posterStyle` are removed here — the overlay `<Image>` at
lines 487-493 remains the single poster surface (D-22). Iteration 2 rebuilds what that
overlay shows.

`progressUpdateIntervalMillis={1000}` halves the native→JS bridge traffic; combined with
(f) it means the component re-renders on *state transitions* only.

**(h) Release the decoder on unmount** (D-15):

```js
useEffect(() => () => {
    videoRef.current?.unloadAsync?.().catch(() => {});
}, []);
```

**(i) Split the item-identity reset from the follow sync** (D-11). Replace the effects at
lines 222-224 and 235-238 with:

```js
// Everything that is per-item resets when the item identity changes.
useEffect(() => {
    setIsLiked(!!item.isLiked);
    setCurrentLikes(item.likes || '0');
    setHasSentReward(false);
    setUserPaused(false);
    setIsVideoLoaded(false);
    setIsPlaying(false);
    loadedRef.current = false;
    playingRef.current = false;
}, [item.id]);

// Follow state tracks the global list and nothing else.
useEffect(() => {
    setIsFollowing(isGlobalFollowing || item.isFollowing || false);
}, [isGlobalFollowing, item.isFollowing]);
```

**(j) Delete the debug effect** at lines 227-232.

**(k) `React.memo`** (D-13) at the export:

```js
export default React.memo(PostItem);
```

Default shallow comparison is correct here: `item` is the same object identity across
renders (it comes straight out of the Zustand `videos` array), `itemHeight` is a number,
and `onCommentPress` is now stable via `useCallback`.

**(l) `onCommentPress` call site** (line 546) — pass the id, since `HomeScreen`'s handler
now takes one:

```diff
-                    onPress={() => handleActionAuth(onCommentPress)}
+                    onPress={() => handleActionAuth(() => onCommentPress(item.id))}
```

### 5.5 `src/app/video/[id].jsx`

The second feed surface must use the same machinery or it will drift.

- Delete the local `activeVideoId` state (line 51) and the effect at 108-114 that writes
  the context from it. Read `activeVideoId` from `useVideoPlayback()` instead.
- Delete `onViewableItemsChanged` (98-106) and `viewabilityConfig` (159); add the same
  `onMomentumScrollEnd` / velocity-gated `onScrollEndDrag` / `commitIndex` trio, operating
  on the local `videos` array.
- Add the same `onLayout` measurement and gate the list on `viewportHeight > 0`.
- Stop passing `isFocused` (line 143) — pass `itemHeight={viewportHeight}` and `index`.
- Drop the extra `<View style={{ width: '100%', height }}>` wrapper at line 140; the item
  now sizes itself from `itemHeight`.
- Add `onScrollToIndexFailed` (it uses `initialScrollIndex` at line 152).
- Add `disableIntervalMomentum`.
- `setScreenFocus(true)` / `setAppState(true)` should move into a `useFocusEffect` so the
  flags are restored when this screen is popped, rather than being set once and left.

### 5.6 Files touched

```
newboostraapp/src/screens/home/screens/HomeScreen.jsx        (major)
newboostraapp/src/screens/home/components/FeedPostItem.jsx   (major)
newboostraapp/src/app/video/[id].jsx                          (major)
newboostraapp/src/context/VideoPlaybackContext.js             (minor)
newboostraapp/src/utils/log.js                                (new)
newboostraapp/src/components/CustomTabBar.jsx                 (read-only; no change)
```

---

## 6. Backend changes

**None.** No endpoint, DTO, schema, index or environment variable changes. Deploy the app
against the existing production API unchanged.

---

## 7. Caching / preloading / buffering / autoplay / pagination / API / delivery / performance

| Area | Change in this iteration |
|---|---|
| **Autoplay** | Rewritten. `shouldPlay = isFocused && !userPaused`, single writer. Autoplay now begins exactly when the settle commits, and a user pause survives re-renders. |
| **Buffering** | Indirectly improved: `source` is memoised so `expo-av` stops re-issuing loads on re-render (D-05), which was a cause of the mid-playback re-buffer. No new buffering strategy — that is iteration 4. |
| **Preloading** | None added. Deliberately. `windowSize={3}` is unchanged, so 3 `<Video>` instances still mount and contend for bandwidth (D-40); iteration 4 addresses that with a proper policy. |
| **Caching** | None. |
| **Pagination** | Unchanged wire behaviour. `onEndReached` / `onEndReachedThreshold` untouched. `handleLoadMore`'s stale-closure and dedup issues are iteration 3. |
| **API** | Untouched. |
| **Video delivery** | Untouched. Still direct progressive MP4 from `boostme-storage.s3.eu-north-1`. |
| **Performance** | `React.memo` + `useCallback` `renderItem` + Zustand selectors + memoised context value + transition-only status writes + `progressUpdateIntervalMillis: 1000` + `__DEV__`-gated logging. Expect the per-second re-render count of a playing `FeedPostItem` to go from 2–4 to ~0. |

---

## 8. Expected behaviour after this iteration

1. Swiping up plays the video that fills the screen — always, including on hard flicks and
   on slow drag-releases.
2. Exactly one audio stream is ever audible.
3. One swipe advances exactly one video.
4. Tapping the video pauses it and it **stays** paused until tapped again or swiped away.
5. Swiping away from a paused video and back plays it from where it looped to (not paused).
6. Pressing the `+` badge on an avatar follows the creator instead of crashing.
7. The back button on `/video/[id]` is positioned correctly.
8. Returning to the feed from another tab restores the previous row without a crash and
   without a blank screen.
9. The feed no longer prints per-scroll and per-item logs in a release build.
10. Liking a video and then following someone no longer un-likes the video.
11. A feed item whose `rawVideoKey` is missing shows a dark placeholder instead of a
    `<Video>` with a `null` URI.

**Explicitly still broken after this iteration** — do not treat these as regressions:

- The black screen before first frame (no poster). → Iteration 2.
- `hasLiked` always `false` on For You. → Iteration 3.
- `@firstname` handles instead of `@username`. → Iteration 3.
- Duplicate items on scroll-to-load. → Iteration 3.
- The Following feed never loading page 2. → Iteration 3 (D-33).
- Slow first frame / no prefetch. → Iteration 4.
- Slow playback for viewers outside Northern Europe. → Iteration 5.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `onLayout` fires with `height: 0` on first pass on some Android devices, so the list never mounts | Medium | The `h > 0` guard means we simply wait for the next layout pass. Add a 1 s fallback that sets `viewportHeight` to `Dimensions.get('window').height` if still 0, so the feed can never be permanently blank. **Include this fallback.** |
| Removing `onViewableItemsChanged` also removes the only thing that fired on programmatic scrolls (`scrollToOffset` from `handleRefresh`) | Medium | `scrollToOffset({ animated: false })` does not emit momentum events. This is why `handleRefresh` explicitly resets `didSeedRef`/`activeIndexRef` and lets the seed effect re-run. Verify in test T-1.7. |
| `disableIntervalMomentum` makes fast scrolling feel sluggish to users used to flicking through several videos | Low | It is the correct behaviour for a TikTok-style pager (TikTok itself is one-page-per-flick). If it tests badly, remove just this prop; the rest of the fix does not depend on it. |
| `React.memo` on `FeedPostItem` masks a genuine prop update, so an item shows stale like/follow counts | Medium | `item` objects are replaced (not mutated) by `setVideos`/`appendVideos`, so identity changes propagate. **But** `handleSaveEdit` at [FeedPostItem.jsx:167-173](newboostraapp/src/screens/home/components/FeedPostItem.jsx#L167-L173) **mutates `item` in place** — that already fails to re-render today and will keep failing. Covered by test T-1.11; the proper fix is to route the edit through the store, which is out of scope here. Note it and move on. |
| Removing `RefreshControl` is perceived as removing pull-to-refresh | Low | Two other refresh affordances exist and are unchanged. Confirm with the product owner before shipping if pull-to-refresh is considered a required gesture. |
| `unloadAsync()` on unmount races with an in-flight load and logs a rejected promise | Low | The `.catch(() => {})` swallows it. Confirm no red-box in dev. |
| Zustand per-field selectors change render timing enough to surface a different latent bug | Low | Ship 5.3(b) as its own commit so it can be reverted independently. |

### Contingency

If, after 5.3(c)–(g), swipes still land on the wrong item on a specific device, the
`FlatList` paging itself is the problem, not the selector. `react-native-pager-view@6.9.1`
is **already in `package.json`** and unused. Swapping the feed to `<PagerView orientation="vertical">`
with `onPageSelected` gives you a native pager that reports the settled page index
directly and removes offset arithmetic entirely. Treat that as a fallback branch, not the
default — it changes the windowing/recycling model and would need iteration 4 re-planned
around it.

---

## 10. Test plan

Device matrix: **one physical Android device with gesture navigation** (edge-to-edge is
the whole point of D-03), **one physical Android device with 3-button navigation**, and
**one physical iPhone**. Simulators will not reproduce D-03. Build a release-configuration
JS bundle (`npx expo start --no-dev --minify`) for the performance tests — dev-mode render
counts are meaningless.

Pre-condition for every test: at least **12** videos in the For You feed, and a warmed API
(`curl https://boost-backend-n9w3.onrender.com/api/health` returns before you start).

| # | Test | Steps | Pass |
|---|---|---|---|
| T-1.1 | **Correct item plays** | Swipe up slowly through 12 items, pausing 3 s on each | For all 12, the audible/playing video is the one filling the screen. 12/12. |
| T-1.2 | **Hard-flick correctness** | 50 rapid consecutive up-flicks, then 50 down-flicks | Every settle plays the visible item. **0** occurrences of a non-visible item playing. |
| T-1.3 | **No stuck-paused item** | Same 100 flicks as T-1.2 | Every settled item begins playing within 1 s of the settle. **0** stuck items. |
| T-1.4 | **One page per flick** | 20 hard flicks | Each flick advances exactly 1 index. **0** double-advances. |
| T-1.5 | **Tap-to-pause sticks** | On a playing video, tap once. Wait 5 s. | Video stays paused for the full 5 s. Play overlay icon visible throughout. 20/20 taps. |
| T-1.6 | **Tap-to-resume** | From T-1.5's paused state, tap once | Resumes within 300 ms. 20/20. |
| T-1.7 | **Pause does not leak across items** | Pause item N, swipe to N+1 | N+1 autoplays. Swipe back to N: N autoplays (does not stay paused). |
| T-1.8 | **Refresh restores authority** | Scroll to item 6. Tap the "For You" header tab. | List returns to offset 0, item 0 plays, no stuck state, no crash. |
| T-1.9 | **Tab round-trip** | Scroll to item 5 → tap Wallet tab → tap Home tab | Feed returns at item 5, item 5 plays, no `scrollToIndex` red-box, no blank screen. Repeat 10×. |
| T-1.10 | **Background/foreground** | While item 3 plays, background the app for 10 s, return | Playback paused while backgrounded (verify audio stops), item 3 resumes on return. |
| T-1.11 | **Follow badge** | Tap the `+` badge on any avatar you do not follow | Follow succeeds, badge disappears. **No `ReferenceError` in the JS log.** |
| T-1.12 | **Like survives an unrelated follow** | Like item 2. Scroll to item 4, follow that creator. Scroll back to item 2. | Item 2 is still liked. (Today it is not.) |
| T-1.13 | **Missing `rawVideoKey`** | Temporarily edit the feed mapper to force `videoUrl: null` on index 1 | Index 1 shows a dark placeholder. No crash, no red-box, neighbours unaffected. Revert the edit. |
| T-1.14 | **Deep-link surface** | From a profile grid, open a video (`/video/[id]`), swipe 5 items, press back | Same correctness as T-1.1/T-1.2 on that surface. Back button is positioned top-left with a rounded dark background. |
| T-1.15 | **Rotation / system-bar change** | (Android, if the device allows) toggle the navigation bar mode in system settings and return to the app | `viewportHeight` re-measures; snapping still lands exactly on item boundaries. |
| T-1.16 | **Re-render count** | Release bundle. Add a temporary `useRef` counter in `FeedPostItem` logged once per 5 s. Let one video play for 30 s untouched. | ≤ **2** renders in 30 s (mount + first status transition). Baseline is 60–120. Remove the counter before merging. |
| T-1.17 | **Scroll frame rate** | Release bundle. Flick continuously for 15 s while watching the RN perf monitor (or Android GPU profiler) | No sustained UI-thread frame drops below 50 fps. Record the number; iteration 4 will be compared to it. |
| T-1.18 | **No release logging** | Release bundle, `adb logcat \| grep -E '\[SCROLL\]\|\[PLAYBACK_AUTHORITY\]\|DEBUG_FINAL'` while scrolling 20 items | **Zero** matches. |
| T-1.19 | **Blank-feed guard** | Cold-launch 10× on the Android gesture-nav device | The feed renders every time. **0** launches where `viewportHeight` stays 0 and the list never appears. |
| T-1.20 | **No regression in comments/share/report** | Open the comment modal, share sheet, and report sheet from a feed item | All open and close normally; the underlying video pauses or continues as before (behaviour unchanged is acceptable). |

---

## 11. Success criteria

Every one of these must hold before starting iteration 2.

- [ ] **Wrong-item rate = 0** over 100 flicks (T-1.2). Baseline was non-zero.
- [ ] **Stuck-paused rate = 0** over 100 flicks (T-1.3). Baseline was non-zero.
- [ ] **Double-advance rate = 0** over 20 flicks (T-1.4).
- [ ] **Tap-pause stick rate = 20/20** (T-1.5). Baseline was near 0.
- [ ] **`FeedPostItem` renders ≤ 2 per 30 s** of uninterrupted playback in a release build (T-1.16).
- [ ] **Zero feed-path log lines** in a release build (T-1.18).
- [ ] **Zero crashes / red-boxes** across the full T-1.1 … T-1.20 pass on all three devices.
- [ ] **`grep -rn "handleFollowToggle" newboostraapp/src` returns nothing.**
- [ ] **`grep -rn "Dimensions.get" newboostraapp/src/screens/home newboostraapp/src/app/video` returns only the `FALLBACK_HEIGHT` line and the `width` line.**
- [ ] **`grep -rn "onViewableItemsChanged" newboostraapp/src` returns nothing.**
- [ ] **`grep -rn "playAsync\|pauseAsync" newboostraapp/src/screens/home/components/FeedPostItem.jsx` returns nothing.**
- [ ] T-1.9 (tab round-trip) passes **10/10** with no `scrollToIndex` failure.
- [ ] T-1.12 passes — the like/follow state cross-talk is gone.
- [ ] Scroll frame rate from T-1.17 is recorded in the baseline file for comparison in iteration 4.

If any box fails, fix it inside iteration 1. Do not carry a failure forward — iteration 2's
test plan assumes a deterministic player.
