# Live Streaming — Frontend Implementation Roadmap

**Target repo:** `boostra-app` (Expo SDK 54, React Native 0.81.5, Expo Router, Zustand, dev-client + EAS)
**Provider:** Stream Video (`@stream-io/video-react-native-sdk`) — **the same SDK already installed for Video Calling**
**Scope:** Host broadcast + viewer watch, live chat overlay, hearts, coin gifting
**Companion document:** `../backend/IMPLEMENTATION_ROADMAP.md`
**Assumes:** `../../VideoCalling/frontend/IMPLEMENTATION_ROADMAP.md` Iterations 1–4 are complete

---

## How to use this document

Each iteration is **independently executable**. Implement one, test it, verify the completion criteria, commit, and only then start the next.

Iterations 1–4 produce a watchable stream. Iterations 5–7 build the interaction layer from the mockups. Iterations 8–10 make it discoverable and shippable.

---

## The headline: no new native dependencies

The calling roadmap's Iteration 1 was a high-risk native compatibility gate — New Architecture, static frameworks, WebRTC pods, CallKit. **That work is already done and it is not repeated here.**

Livestreaming uses `@stream-io/video-react-native-sdk` — already installed, already linked, already validated on your hardware. This roadmap adds **zero** native modules. It is pure JavaScript and UI work.

That is the concrete payoff of choosing one vendor for both features, and it is why the effort estimate at the end is roughly half the calling one despite a comparable screen count.

> If you have **not** built Video Calling yet, you must still complete its frontend Iterations 1–4 first. They establish the native stack, the Stream client, and the auth lifecycle — shared infrastructure, not calling-specific work.

### What each mockup panel maps to

| Mockup | Route | Stream SDK component |
|---|---|---|
| **Live Stream Own** | `src/app/live/host.jsx` | `HostLivestream` |
| **Live Stream Others** | `src/app/live/[id].jsx` | `ViewerLivestream` |

Everything else in those screens — the chat overlay, follow button, viewer pill, hearts, the gift icon — is yours, and is built in Iterations 5–7.

### Where things go

```
src/services/
  livestreamService.js      # REST + socket client for streams
  streamService.js          # RENAMED from callService.js (Iteration 1)

src/context/
  StreamProvider.jsx        # RENAMED from CallProvider.jsx

src/app/live/
  _layout.jsx
  setup.jsx                 # backstage: camera check before going live
  host.jsx                  # broadcasting  (mockup: Live Stream Own)
  [id].jsx                  # watching      (mockup: Live Stream Others)

src/components/live/
  LiveChatOverlay.jsx       # shared by host and viewer
  LiveChatInput.jsx
  ViewerCountPill.jsx
  LiveBadge.jsx
  HeartBurst.jsx
  GiftSheet.jsx
  GiftAnimation.jsx
  HostHeader.jsx

src/hooks/
  useLivestreamSocket.js
  useLiveChat.js
```

---

# Iteration 1 — Generalise the calling foundation

### Goal
Widen the calling-specific service and provider so livestreaming shares them. No new behaviour, and **no regression in calling**.

### Prerequisites
- **Video Calling frontend Iterations 1–4** complete.
- **Livestreaming backend Iteration 1** deployed (`POST /stream/token`).

### Implementation steps
1. **Rename `src/services/callService.js` → `src/services/streamService.js`.** Token fetch, client construction, connection lifecycle, and `tokenProvider` are all shared; only the call-specific REST wrappers are not.
2. Split the module cleanly:
   - `streamService.js` — `fetchToken`, `connect`, `disconnect`, `getClient`.
   - `callService.js` — keeps only `initiateCall`, `acceptCall`, `rejectCall`, `endCall`, `getHistory`, importing the client from `streamService`.
3. Point `fetchToken` at `POST /stream/token`. The backend keeps `/calls/token` as an alias for one release, so deploy order is not a hazard — but update the client anyway.
4. **Rename `CallProvider.jsx` → `StreamProvider.jsx`.** Its job was never call-specific: connect on login, disconnect on logout, reconnect on foreground. `useIncomingCall` stays mounted inside it.
5. Update the mount in `src/app/_layout.jsx`.
6. Add a livestream slice to the Zustand store, mirroring the call slice and **also excluded from `persist`**:
   - `activeLivestream`, `livestreamRole` (`'host' | 'viewer' | null`), `livestreamConnectionState`
   - Actions: `setActiveLivestream`, `clearLivestream`
7. Create `src/services/livestreamService.js` as a stub with the REST wrappers (`create`, `goLive`, `end`, `join`, `leave`, `getFeed`, `getFollowingFeed`) plus `CALLS`-style endpoint entries under a new `LIVESTREAMS` key in `src/config/api.config.js`.
8. **Keep the abstraction boundary.** No component may import `StreamVideoClient` directly — the same rule the calling roadmap established. Livestream screens go through `livestreamService`.

### Files / modules affected
- `src/services/streamService.js` *(renamed)*, `callService.js` *(slimmed)*, `livestreamService.js` *(new)*
- `src/context/StreamProvider.jsx` *(renamed)*
- `src/app/_layout.jsx`, `src/store/index.js`, `src/config/api.config.js`

### API / event flow
```
Login ──> StreamProvider ──> streamService.connect()
                               └──> POST /stream/token ──> StreamVideoClient
                                       └──> serves BOTH calling and livestreaming
```

### Error and edge-case handling
- **Calling regression** — this iteration edits working code. Every calling test must still pass; that is the primary acceptance criterion.
- **Stale imports** → grep for `callService` across the app after the split; a missed import fails at runtime, not build time, in a JS project.
- **Persisted livestream state** → excluded, for the same reason as call state: a rehydrated `activeLivestream` would navigate a user into a dead stream on launch.
- **Two client instances** → `getOrCreateInstance` is idempotent, but verify only one connection appears in the Stream dashboard.

### Testing procedure
1. Full calling regression: outgoing, incoming, video, audio, CallKit ring on a killed device. All pass.
2. `POST /stream/token` is the request actually sent — verify in a network log.
3. Log in → exactly one client connection in the dashboard.
4. Grep: no file outside `streamService.js` imports `StreamVideoClient`.
5. Set `activeLivestream`, force-kill, relaunch → null.
6. Log out and back in as another user → no client leakage.

### Expected result
One Stream foundation serving both features, calling untouched.

### Completion criteria
- [ ] Full calling regression passes, including native ringing
- [ ] `streamService` / `callService` / `livestreamService` split cleanly
- [ ] Provider renamed and remounted correctly
- [ ] Livestream state excluded from persistence
- [ ] Single client instance verified
- [ ] No direct SDK imports outside `streamService.js`

---

# Iteration 2 — Backstage setup screen

### Goal
Before a host goes live, let them check framing, pick a title, and confirm. This is what backstage mode exists for, and skipping it means every stream opens with a shot of someone's ceiling.

### Prerequisites
- Iteration 1.
- **Backend Iteration 3** (`POST /livestreams`, `go-live`).

### Implementation steps
1. Create `src/app/live/_layout.jsx` — stack, headers hidden, `gestureEnabled: false` (swiping away a live broadcast must be impossible).
2. Create `src/app/live/setup.jsx`:
   - Full-screen local camera preview (the host's own video track, not yet published to anyone).
   - Title input, optional.
   - Flip-camera and mic-toggle controls.
   - A prominent **Go Live** button.
   - A clear "You are not live yet" indicator. Ambiguity here is how hosts accidentally broadcast.
3. On mount: request camera and microphone via the existing `useCallPermissions` hook from the calling roadmap. Denied → explain and back out.
4. `POST /livestreams` on mount to create the backstage call, then join it in backstage mode so the preview is the real pipeline rather than a raw camera view — what the host sees is then what viewers will get.
5. **Go Live** → `POST /livestreams/:id/go-live`, then `router.replace('/live/host')`. `replace`, so backstage is not behind the live screen in the stack.
6. Back / cancel → `POST /livestreams/:id/end` to clean up the backstage record, then navigate away. Never abandon it silently.
7. Show an eligibility error clearly if `POST /livestreams` returns `403` — explain *why* (follower threshold, restriction, unverified email) using the backend's error code.

### Files / modules affected
- `src/app/live/_layout.jsx`, `src/app/live/setup.jsx` *(new)*
- `src/services/livestreamService.js`
- `src/hooks/useCallPermissions.js` (reused as-is)

### API / event flow
```
Mount ──> permissions ──> POST /livestreams { title }
                             └──> { streamId, streamCallId, status: 'backstage' }
                             └──> join call in backstage (local preview only)

Go Live ──> POST /livestreams/:id/go-live ──> replace('/live/host')
Cancel  ──> POST /livestreams/:id/end ──> back
```

### Error and edge-case handling
- **Not eligible** → `403`. Show the specific reason; a generic "something went wrong" here generates support tickets.
- **Already hosting** → `409`. Offer to return to the existing stream rather than failing.
- **Permission denied** → explain, offer settings, back out cleanly with no orphaned backstage record.
- **App backgrounded in backstage** → the camera stops. On return, restart the preview; do not show a frozen last frame that looks live.
- **Host kills the app in backstage** → the backend sweeper (Iteration 10) cleans it up after 30 minutes. Harmless, since backstage is invisible.
- **Double-tap Go Live** → disable the button on first press.
- **Network drop before Go Live** → show a clear failure, keep the preview, allow retry without recreating the stream.

### Testing procedure
1. Eligible host opens setup → live camera preview within ~2 seconds.
2. Flip camera and mute both work in preview.
3. Ineligible user → the specific reason appears.
4. Cancel → the backstage record becomes `ended` in Mongo.
5. Go Live → status `live`; lands on the host screen.
6. Background during setup, return → preview restarts, not frozen.
7. Deny camera → clean explanation, no orphaned record.
8. Double-tap Go Live → exactly one transition.
9. Airplane mode, tap Go Live → clear error, retry works after restoring network.

### Expected result
A host can frame their shot and go live deliberately, never accidentally.

### Completion criteria
- [ ] Local preview works through the real Stream pipeline
- [ ] "Not live yet" state is unambiguous
- [ ] Cancel always cleans up the backstage record
- [ ] Eligibility errors are specific
- [ ] Backgrounding recovers the preview
- [ ] Transition to live uses `replace`

---

# Iteration 3 — Host broadcast screen

### Goal
Build the **Live Stream Own** mockup panel: full-screen camera, LIVE badge, viewer count, and host controls.

### Prerequisites
- Iterations 1–2.

### Implementation steps
1. Create `src/app/live/host.jsx` wrapping the SDK's `HostLivestream`.
2. Layout, per the mockup:
   - Full-bleed camera fills the screen.
   - **Top bar:** back chevron, circular host avatar, host name, a red **LIVE** badge, and a viewer-count pill with an eye icon on the right (`153,123` in the mockup — format with `k`/`M` abbreviation above 10,000).
   - **Bottom:** the chat overlay (Iteration 5) and the message input, with a heart button at the right.
   - Controls: flip camera, mute, end stream.
3. Extract `LiveBadge`, `ViewerCountPill`, and `HostHeader` into `src/components/live/` — the viewer screen reuses all three.
4. Viewer count comes from the socket's `viewerCount` event (backend Iteration 6), which arrives on a 5-second interval. **Animate the number change** rather than snapping, so a jump from 12 to 340 reads as growth rather than a glitch.
5. **End stream** requires a confirmation dialog. An accidental tap ending a live broadcast is unrecoverable.
6. End → `POST /livestreams/:id/end`, leave the call, navigate to a simple summary (duration, peak viewers, messages, gift coins) using the backend's final record.
7. `expo-keep-awake` while broadcasting. Lock to portrait.
8. **Warn on backgrounding.** See the edge cases — this is the defining difference between a stream and a call.

### Files / modules affected
- `src/app/live/host.jsx` *(new)*
- `src/components/live/LiveBadge.jsx`, `ViewerCountPill.jsx`, `HostHeader.jsx` *(new)*
- `src/services/livestreamService.js`

### API / event flow
```
Mount ──> already joined and live from setup
      ──> socket: joinStream { streamId }  (host also joins the chat room)

socket 'viewerCount' (every 5s) ──> animated pill update
socket 'streamMessage'          ──> chat overlay
socket 'giftReceived'           ──> gift animation (Iteration 7)

End ──> confirm ──> POST /livestreams/:id/end ──> leave ──> summary screen
```

### Error and edge-case handling
- **Backgrounding kills the broadcast.** Unlike a call, iOS will not let the camera run in the background — the `audio` background mode keeps audio alive, but video stops. Options: (a) warn the host prominently before they background, and (b) show viewers a "host stepped away" state rather than a frozen frame. **Do not pretend the stream is healthy.** This is the single most important edge case in this iteration.
- **Incoming call while broadcasting** → they conflict over camera and audio. Recommended: auto-reject incoming calls while live, and tell the caller the user is live. Decide explicitly rather than discovering it in production.
- **Network drop** → "Reconnecting…" overlay; the SDK retries. The backend's 60-second grace period (Iteration 10) governs whether the stream survives; surface the countdown so the host knows what is happening.
- **Camera unavailable** (another app holds it) → cannot broadcast video; offer to end rather than streaming a black screen.
- **Zero viewers** → show an encouraging empty state, not `0` in a way that reads as broken.
- **Very large viewer counts** → abbreviate (`2.5k`, `153k`); never render an unbounded number that breaks the pill layout.
- **Thermal throttling on long streams** → monitor; a 2-hour broadcast heats a phone significantly. Note observed behaviour for the runbook.

### Testing procedure
1. Go live → camera fills the screen, LIVE badge visible, count starts at 0 or 1.
2. Compare against the mockup at several device sizes.
3. Three viewers join → the pill updates within ~5 seconds, animated.
4. Flip camera and mute → viewers see and hear the change.
5. Tap End → confirmation required; confirm → summary shows correct stats.
6. **Background the app while live** → the warning appears; viewers see "host stepped away", not a frozen frame.
7. Return to foreground → video resumes.
8. Airplane mode for 20s → "Reconnecting…"; restore → recovers.
9. Receive an incoming call while live → behaves per the decision above.
10. 30-minute broadcast → no leak; record thermal and battery behaviour.

### Expected result
A host can broadcast reliably, with honest status at every moment.

### Completion criteria
- [ ] Matches the **Live Stream Own** mockup
- [ ] Viewer count updates smoothly and abbreviates correctly
- [ ] End requires confirmation and shows a summary
- [ ] Backgrounding is warned about and surfaced honestly to viewers
- [ ] Incoming-call conflict resolved deliberately
- [ ] Reconnection handled without ending the stream prematurely

---

# Iteration 4 — Viewer watch screen

### Goal
Build the **Live Stream Others** mockup panel: full-screen playback, host header with a Follow button, viewer count, and a close button.

### Prerequisites
- Iterations 1–3.
- **Backend Iteration 4** (`join`, `leave`).

### Implementation steps
1. Create `src/app/live/[id].jsx` wrapping the SDK's `ViewerLivestream`, reading `streamId` from route params.
2. Layout, per the mockup:
   - Full-bleed host video.
   - **Top bar:** back chevron, host avatar with a **LIVE** badge overlapping its lower-left, host name, viewer-count pill (`2.5k`), a **Follow** pill button, and an **×** close button on the right.
   - **Bottom:** chat overlay and input (Iteration 5), plus a gift button and a heart button — the two icons at the bottom-right of the mockup.
   - Reuse `LiveBadge`, `ViewerCountPill`, and `HostHeader` from Iteration 3.
3. On mount: `POST /livestreams/:id/join`, then join the Stream call as a viewer. **Viewers publish nothing** — no camera or microphone permission is required to watch, and asking for it would be both unnecessary and alarming. Only the gift and chat paths touch anything sensitive.
4. **Follow button** wired to the existing `followService`, with optimistic update and rollback on failure. Hide it when already following, per the mockup.
5. On unmount / close / back: `POST /livestreams/:id/leave` and leave the call. Best-effort — the backend reconciles crashed viewers within 60 seconds.
6. Handle stream end mid-watch: on `streamEnded`, show "Stream ended" with the host's avatar and a follow prompt, then allow dismissal. Do not dump the user back to the feed without explanation.
7. Show a loading state while connecting, with the host's cached avatar and name from the feed so there is no blank screen.

### Files / modules affected
- `src/app/live/[id].jsx` *(new)*
- `src/components/live/*` (reused)
- `src/services/livestreamService.js`, `followService.js` (reused)

### API / event flow
```
Mount ──> POST /livestreams/:id/join ──> { streamCallId, host, viewerCount, isFollowingHost }
      ──> join Stream call as viewer (receive-only)
      ──> socket joinStream { streamId }

Follow tap ──> followService (optimistic, rollback on failure)
socket 'streamEnded' ──> "Stream ended" state
Close / back / unmount ──> POST /livestreams/:id/leave ──> leave call ──> back to feed
```

### Error and edge-case handling
- **Stream ended between feed tap and join** → `409 STREAM_NOT_LIVE`. Show "This stream has ended" and return to the feed. This is the **most common error path in the whole feature** — a stale feed entry — so it must be fast and graceful, not an error dialog.
- **Blocked by the host** → `403` with neutral copy, consistent with calling.
- **Requesting camera permission as a viewer** → a bug. Viewers are receive-only; verify no prompt appears.
- **Host drops** → video freezes. Show "Host reconnecting…" during the backend grace period, then "Stream ended" if it expires.
- **Poor viewer network** → the SDK adapts quality automatically. Show a buffering indicator; do not implement your own bitrate logic.
- **Backgrounding as a viewer** → video pauses, which is fine and expected. Resume on return; consider whether audio should continue (recommended: yes, like a podcast — it is the behaviour users expect).
- **Rapid join/leave** (feed scrubbing) → debounce to avoid a storm of join/leave requests.
- **Follow fails** → roll back the optimistic state and show a toast.

### Testing procedure
1. Tap a live stream in the feed → video plays within a few seconds; host header correct.
2. Compare against the **Live Stream Others** mockup at several device sizes.
3. **Verify no camera or microphone prompt appears for a viewer.**
4. Follow → button state updates; verify persistence on the backend.
5. Host ends the stream → "Stream ended" appears; dismiss returns to the feed.
6. Open a stale feed entry for an ended stream → graceful message, no error dialog.
7. Close via × and via back → both call `leave`; the count decrements.
8. Force-kill the viewer app → the count corrects within 60 seconds.
9. Background as a viewer → behaves per the audio decision; resumes on return.
10. Throttled network → quality adapts; a buffering indicator appears.
11. Five viewers on one stream → all see the same video and count.

### Expected result
Viewers can watch reliably, with every failure path explained rather than dumped.

### Completion criteria
- [ ] Matches the **Live Stream Others** mockup
- [ ] No camera/mic permission requested for viewers
- [ ] Follow works optimistically with rollback
- [ ] Ended-stream states handled gracefully on both entry and mid-watch
- [ ] Leave called on every exit path
- [ ] Quality adaptation and buffering surfaced

---

# Iteration 5 — Live chat overlay

### Goal
The chat overlay visible in both mockup panels — a shared component used by the host and viewer screens.

### Prerequisites
- Iterations 1–4.
- **Backend Iteration 6** (livestream gateway **and the Redis adapter fix**).

### Implementation steps
1. Create `src/hooks/useLivestreamSocket.js` — connects to the `/livestream` namespace using the same pattern as `chatService.connectSocket()` (auth token in handshake, websocket transport, reconnection). Do **not** reuse the `/chat` socket; separate namespaces were a deliberate backend decision.
2. Create `src/hooks/useLiveChat.js` — subscribes to `streamMessage`, maintains a bounded local list, exposes `send()`.
3. Create `src/components/live/LiveChatOverlay.jsx`, per the mockup:
   - Bottom-left stack of translucent dark pill-shaped rows.
   - Each row: small circular avatar, bold username, message beneath.
   - **Newest at the bottom**, older rows fading upward.
   - Non-interactive scroll-back is fine; the video is the focus.
4. Create `LiveChatInput.jsx` — a rounded "Type your message…" field with a send icon, matching the mockup. Host and viewer share it.
5. **Cap the rendered list at ~50 messages.** An unbounded list on a busy stream is a guaranteed memory leak and frame-rate collapse. Trim aggressively.
6. Use `FlatList` with `inverted` for efficient rendering; avoid re-rendering the whole overlay per message.
7. Keyboard handling: `react-native-keyboard-controller` is already a dependency — the input must rise above the keyboard without covering the video's focal point.
8. Handle `messageError` (rate limited) by showing a brief inline hint to that user only.
9. Replay the last-50 history that the backend sends on join, so a viewer arriving mid-stream sees context rather than an empty overlay.

### Files / modules affected
- `src/hooks/useLivestreamSocket.js`, `useLiveChat.js` *(new)*
- `src/components/live/LiveChatOverlay.jsx`, `LiveChatInput.jsx` *(new)*
- `src/app/live/host.jsx`, `src/app/live/[id].jsx`

### API / event flow
```
Mount ──> connect /livestream namespace (JWT) ──> joinStream { streamId }
                                                    └──> last 50 messages replayed

send ──> sendStreamMessage { streamId, text }
     ──> server broadcasts 'streamMessage' to the room
     ──> every client (host + viewers) appends, list trimmed to 50

'messageError' ──> inline rate-limit hint, this client only
```

### Error and edge-case handling
- **Unbounded message list** → the performance trap. Trim to 50, always.
- **Message flood** → batch state updates rather than calling `setState` per message; at 20 messages/second, per-message updates will drop frames.
- **Socket disconnects mid-stream** → auto-reconnect and rejoin the room. Show a subtle "chat reconnecting" hint; never block the video.
- **Rate limited** → inline hint to the sender only, matching the backend's socket-scoped error.
- **Keyboard covers the video** → the overlay must compress, not the video shrink awkwardly. Test on a small device.
- **Empty chat** → render nothing, not an empty-state card. The mockup's chat area is transparent when idle.
- **Very long username or message** → truncate with ellipsis; the pill must not wrap to five lines.
- **Messages arriving before the host screen mounts** → buffer briefly in the hook.

### Testing procedure
1. Host and two viewers → a message from any of them appears for all within ~1 second.
2. **Two backend instances, viewers on different instances** → messages still reach everyone. If this fails, the backend's Redis adapter is not working; stop and fix that first.
3. Join mid-stream → the last 50 messages replay immediately.
4. Send 200 messages → the list stays at 50; no memory growth; frame rate stable.
5. Flood at 20 msg/sec → UI stays responsive.
6. Exceed the rate limit → the inline hint shows for that user only.
7. Kill and restore the network → chat reconnects and rejoins the room.
8. Open the keyboard on a small device → input visible, video not obscured.
9. Very long username and 200-character message → truncate cleanly.
10. Compare against both mockup panels.

### Expected result
Live chat that matches the mockups and stays smooth under load.

### Completion criteria
- [ ] Matches the chat overlay in both mockup panels
- [ ] Verified working across two backend instances
- [ ] List capped; no memory growth over 200 messages
- [ ] Batched updates keep the UI responsive at 20 msg/sec
- [ ] History replays on join
- [ ] Keyboard handling correct on small devices

---

# Iteration 6 — Hearts and reactions

### Goal
The heart button in both mockups, with a floating-heart animation, built to survive hundreds of concurrent tappers.

### Prerequisites
- Iterations 1–5.
- **Backend Iteration 7** (aggregated reaction broadcasting).

### Implementation steps
1. Add a heart button to the bottom-right of both screens, per the mockups.
2. **Local tap → immediate local animation.** Never wait for the server round trip; the animation must feel instant.
3. Send `sendReaction` to the socket, **debounced** — batch rapid taps into one emission per ~500ms with a count, matching the backend's aggregation model.
4. Receive `{ type: 'heart', count: N }` on a ~1-second interval and animate `N` hearts rising.
5. Create `HeartBurst.jsx` using `react-native-reanimated` (already a dependency) — **animate on the UI thread**, never with JS-driven `Animated` timing. At 50 simultaneous hearts, a JS-driven animation will drop frames badly.
6. **Cap concurrent rendered hearts at ~20–30**, regardless of the incoming count. If 200 hearts arrive, render 25 with randomised paths; visually indistinguishable, and it protects the frame rate.
7. Randomise each heart's horizontal drift, scale, and duration so the effect looks organic rather than mechanical.
8. Recycle heart views rather than mounting and unmounting hundreds of components.

### Files / modules affected
- `src/components/live/HeartBurst.jsx` *(new)*
- `src/hooks/useLiveChat.js` (or a sibling `useLiveReactions.js`)
- `src/app/live/host.jsx`, `src/app/live/[id].jsx`

### API / event flow
```
Tap ──> local animation immediately (no round trip)
    ──> debounced sendReaction (~500ms batches)

socket '{ type: heart, count: N }' (every ~1s)
    ──> render min(N, 25) hearts with randomised paths, recycled views
```

### Error and edge-case handling
- **JS-thread animation** → the trap. Reanimated on the UI thread, always.
- **Unbounded concurrent hearts** → cap at 25. A viral moment must not freeze the app.
- **Own reaction rendered twice** (locally and from the broadcast) → acceptable and barely perceptible; deduplicating is not worth the complexity, but confirm it does not double-burst visibly.
- **Socket down** → local animation still fires on tap. Reactions are decorative; they must never surface an error.
- **Rapid tapping** → debounced client-side and rate limited server-side.
- **Low-end devices** → test on the oldest device you support; lower the cap if the frame rate suffers.

### Testing procedure
1. Tap the heart → animation fires instantly, with no perceptible delay.
2. Host and viewers → a viewer's taps produce hearts on the host's screen.
3. Tap 20 times in a second → one debounced emission, smooth local animation.
4. Simulate a broadcast of 500 → capped at ~25 rendered; frame rate holds.
5. Profile during sustained reactions → animation runs on the UI thread (verify with the performance monitor).
6. Kill the socket → local animation still works.
7. Test on the oldest supported device → 60fps, or adjust the cap and record the number.
8. Confirm hearts do not obscure the chat overlay or controls.

### Expected result
Hearts feel alive and cost nothing in frame rate.

### Completion criteria
- [ ] Local tap animates instantly
- [ ] Reanimated UI-thread animation, verified
- [ ] Concurrent hearts capped and views recycled
- [ ] Emissions debounced
- [ ] Socket outage degrades silently
- [ ] 60fps on the oldest supported device

---

# Iteration 7 — Gifting

### Goal
The gift button in the **Live Stream Others** mockup: a gift picker, the coin spend, and an on-screen animation. This iteration touches real money.

### Prerequisites
- Iterations 1–6.
- **Backend Iteration 8** (gift service, atomic ledger).
- Existing `coinService.js`, `purchasesService.js`, `iapService.js`.

### Implementation steps
1. Create `GiftSheet.jsx` — a bottom sheet listing the gift catalogue (icon, name, coin cost), with the user's current coin balance shown prominently at the top.
2. **Fetch the catalogue and prices from the server.** Never hardcode prices in the app; the backend treats client-supplied prices as untrusted, and a mismatch would present the user one price and charge another.
3. Tapping a gift → optimistic local animation, then `POST /livestreams/:id/gifts` with a client-generated **idempotency key**. On failure, roll back the animation and show the reason.
4. **Insufficient balance** → do not show an error. Transition straight into the existing coin purchase flow (`coinService` / `purchasesService`), and on successful purchase, return to the sheet with the updated balance. This is the revenue path; friction here is expensive.
5. Create `GiftAnimation.jsx` — a larger, more prominent animation than hearts, with the sender's name and the gift icon, shown on **every** client via the `giftReceived` broadcast. A gift nobody else sees defeats the purpose.
6. Queue gift animations rather than overlapping them; show one at a time for ~2–3 seconds.
7. Update the local coin balance in the Zustand store from the server's authoritative response, never by local arithmetic.
8. Host side: show gift notifications and a running total for the stream.

### Files / modules affected
- `src/components/live/GiftSheet.jsx`, `GiftAnimation.jsx` *(new)*
- `src/services/livestreamService.js`
- `src/services/coinService.js`, `purchasesService.js` (reused)
- `src/store/index.js` (balance updates)
- `src/app/live/[id].jsx`, `host.jsx`

### API / event flow
```
Gift button ──> GET catalogue + balance ──> GiftSheet

Select gift ──> optimistic animation
            ──> POST /livestreams/:id/gifts { giftKey, idempotencyKey }
                   ├── 200 ──> balance updated from server response
                   │            socket 'giftReceived' ──> animation on ALL clients
                   └── 402 ──> coin purchase flow ──> on success, return to sheet
```

### Error and edge-case handling
- **Insufficient balance** → route into purchase, not an error dialog.
- **Double-tap** → disable on first press **and** send an idempotency key. Never rely on the UI alone to prevent a double charge.
- **Network failure after the request is sent** → the outcome is unknown. Retry with the **same idempotency key**; the backend deduplicates. This is exactly why the key exists.
- **Stream ends mid-gift** → the backend completes it. Show confirmation, not an error.
- **Stale prices** → refetch the catalogue when the sheet opens.
- **Balance drift** → always take the server's `newBalance`; never compute locally.
- **Gift animation spam** → queue and cap; a stream where twenty gifts land at once must not become unwatchable.
- **IAP restrictions** — coin purchase must go through the existing RevenueCat/IAP path on both platforms. Any non-IAP purchase route for digital gifts on iOS risks App Store removal. Reuse `purchasesService`; do not build a new path.

### Testing procedure
1. Open the gift sheet → catalogue and current balance load from the server.
2. Send a gift with sufficient balance → animation on **all** clients; balance decreases correctly.
3. Send with insufficient balance → the purchase flow opens; after purchase, the sheet returns with the new balance and the gift can be sent.
4. Double-tap a gift → charged once.
5. Kill the network mid-request, retry with the same key → charged once.
6. Verify the host sees the gift and the running total.
7. Send five gifts rapidly → animations queue, no overlap, no frame drops.
8. Tamper with the price in the request → the server price is charged.
9. Verify the coin ledger reconciles exactly against the balance after ten gifts.
10. Full IAP purchase on both platforms in a sandbox account.

### Expected result
Gifting is smooth, visible to everyone, and never charges twice.

### Completion criteria
- [ ] Catalogue and prices fetched from the server
- [ ] Gift animation shown on all clients
- [ ] Insufficient balance routes into the existing IAP purchase flow
- [ ] Idempotency key prevents double charging, verified under network failure
- [ ] Balance always taken from the server
- [ ] Animations queued and capped
- [ ] Ledger reconciles exactly after repeated gifting

---

# Iteration 8 — Discovery and entry points

### Goal
Let users find live streams and let eligible hosts start one. Without this, the feature is unreachable.

### Prerequisites
- Iterations 1–7.
- **Backend Iteration 5** (feeds, notifications).

### Implementation steps
1. **Live-now surface** — decide placement deliberately. Recommended: a horizontal rail of live hosts at the top of the home feed (the pattern users already know from other apps), plus a dedicated list screen for "see all".
2. Each card: host avatar with a LIVE ring, name, viewer count, and thumbnail if available. Tap → `/live/[id]`.
3. **Following feed first.** `GET /livestreams/following` is the higher-value surface; make it the default tab if you build a dedicated screen, with "All" secondary.
4. **Go Live entry point** — recommended in the existing upload/create flow rather than as a new tab, so it sits alongside the other content-creation actions. Hidden entirely for ineligible users; there is no value in showing a button that always returns `403`.
5. Handle the go-live push notification: tapping it deep-links to `/live/[id]` via the existing `boostra` scheme and notification metadata handling in `pushNotificationService.js`.
6. Poll or socket-refresh the live rail — the backend emits `hostWentLive` over the existing chat gateway `user_<id>` rooms, so prefer the socket and fall back to a refresh on screen focus.
7. Empty state: a proper "No one is live right now" with a prompt to follow more creators, not a blank space.

### Files / modules affected
- `src/app/(tabs)/home.jsx` (live rail)
- `src/app/live/index.jsx` *(new — see-all list)*
- `src/app/upload.jsx` (Go Live entry)
- `src/services/livestreamService.js`
- `src/services/pushNotificationService.js` (deep-link branch)

### API / event flow
```
Home focus ──> GET /livestreams/following ──> live rail
socket 'hostWentLive' ──> rail updates without a refresh

Card tap ──> /live/<id>
Push tap ──> deep link boostra://live/<id> ──> /live/<id>
Go Live tap ──> /live/setup   (hidden when ineligible)
```

### Error and edge-case handling
- **Stale feed entry** → tapping an ended stream returns `409`; handled in Iteration 4. Also refresh the rail on focus so stale cards are short-lived.
- **Ineligible host** → hide the Go Live entry entirely rather than disabling it.
- **Deep link while logged out** → route to login, then continue to the stream after authentication. The existing deep-link handling should already do this; verify rather than duplicate.
- **Deep link to an ended stream** → the "stream ended" state, not a crash.
- **Empty feed** → proper empty state.
- **Livestreaming disabled server-side** → hide all entry points; the rail should not render at all.
- **Rail performance** → the live rail sits on the home feed, which is performance-sensitive. Memoise it; it must not cause the video feed to re-render.

### Testing procedure
1. Host goes live → appears in a follower's rail within seconds via the socket.
2. Tap a card → the viewer screen opens and plays.
3. `GET /livestreams/following` shows only followed hosts; "All" shows everything.
4. Go Live is visible to eligible users and absent for ineligible ones.
5. Receive a go-live push, tap it → deep-links to the correct stream.
6. Deep link while logged out → login, then the stream.
7. Deep link to an ended stream → graceful message.
8. No live streams → empty state on both surfaces.
9. `LIVESTREAM_ENABLED=false` → no rail, no Go Live entry, no crash.
10. Profile the home feed with the rail present → no scroll-performance regression.

### Expected result
Streams are discoverable and easy to start for those allowed to.

### Completion criteria
- [ ] Live rail on home, updating via socket
- [ ] Following feed default; "All" secondary
- [ ] Go Live hidden for ineligible users
- [ ] Push deep-linking works, including from logged-out
- [ ] Empty and disabled states handled
- [ ] No home-feed performance regression

---

# Iteration 9 — Resilience

### Goal
Make streams survive the network and lifecycle conditions that actually occur, with particular attention to the ways a stream differs from a call.

### Prerequisites
- Iterations 1–8.

### Implementation steps
1. **Host network transitions** — WiFi → cellular must not end the broadcast. Show "Reconnecting…" with the grace-period countdown from the backend (60 seconds), so the host knows how long they have.
2. **Host backgrounding** — the defining difference from calling. Video *will* stop; the `audio` background mode does not cover camera capture.
   - Warn the host before it happens where possible.
   - Broadcast a "host stepped away" state to viewers rather than a frozen frame.
   - On return, resume cleanly.
3. **Host app kill** → the backend's webhook plus grace period ends the stream. On relaunch, `activeLivestream` is empty (Iteration 1) and the host sees the ended summary rather than a phantom live state.
4. **Viewer resilience** — reconnect automatically on network loss; the SDK handles quality adaptation. Show buffering honestly.
5. **Stream-ended handling everywhere** — feed, viewer screen, deep link, and push all converge on the same ended state. One component, one behaviour.
6. **Crash recovery for hosts** — on app start, if the backend reports a stream still `live` for this user, offer to resume or end it. A host invisibly "live" with no broadcast is the worst possible state.
7. **Error boundary** around the `live` route group — on a render crash, end or leave the stream and navigate home, reporting the error. A frozen live screen with an open camera is both a bug and a privacy problem.
8. **Memory and thermal** — profile a 30-minute broadcast and a 30-minute watch separately. Audit every socket and SDK subscription for teardown.

### Files / modules affected
- `src/app/live/host.jsx`, `src/app/live/[id].jsx`
- `src/context/StreamProvider.jsx`
- `src/hooks/useLivestreamSocket.js`
- `src/components/live/*`

### API / event flow
```
Host network change ──> SDK reconnect ──> "Reconnecting… (Ns)" with grace countdown
                            ├── recovered ──> stream continues
                            └── expired   ──> ended, summary shown

Host background ──> camera stops ──> viewers see "host stepped away"
Host foreground ──> camera resumes ──> viewers see video return

App start ──> GET host's live stream ──> found? offer resume or end

Render crash ──> error boundary ──> leave/end ──> home, error reported
```

### Error and edge-case handling
- **WiFi → cellular as host** → must survive. The single most valuable test here.
- **Host backgrounds and never returns** → grace period expires, stream ends, viewers informed.
- **Viewer stays on an ended stream** → converge on the ended state; never leave a frozen last frame indefinitely.
- **Host resumes after a crash** → only offer it if the backend still reports the stream live; otherwise show the summary.
- **Subscription leaks** → the likeliest source of memory growth. Audit every `useEffect` for teardown, including socket listeners and SDK observers.
- **Error boundary hiding real bugs** → report before recovering.
- **Camera left active after a crash** → the error boundary must explicitly release it. Verify the camera indicator turns off.

### Testing procedure
1. Host on WiFi, disable WiFi mid-broadcast → recovers on cellular; viewers see a brief reconnect, not an end.
2. Host backgrounds for 30s → viewers see "host stepped away"; return resumes video.
3. Host backgrounds past the grace period → stream ends; viewers informed.
4. Force-kill the host app → stream ends within the grace period; relaunch shows no phantom live state.
5. Force-kill the host, relaunch within the grace period → resume is offered and works.
6. Viewer loses network for 15s → reconnects and resumes.
7. Force a render crash on the host screen → boundary catches, stream ends, **camera indicator turns off**, error reported.
8. 30-minute broadcast → profile memory and thermal; no unbounded growth.
9. 30-minute watch → same.
10. Leave and rejoin ten times → no listener accumulation.

### Expected result
Streams behave predictably under real conditions, and never leave a host silently broadcasting or silently dead.

### Completion criteria
- [ ] Host survives WiFi ↔ cellular
- [ ] Backgrounding surfaced honestly to viewers, resumes cleanly
- [ ] App kill leaves no phantom live state; resume offered where valid
- [ ] Error boundary ends the stream and releases the camera
- [ ] No memory growth over 30 minutes, host or viewer
- [ ] No listener leaks over repeated join/leave

---

# Iteration 10 — QA and release readiness

### Goal
Verify across the device and role matrix and prepare a staged rollout.

### Prerequisites
- Iterations 1–9 complete.
- **All backend iterations complete**, especially Iteration 9 (moderation).

### Implementation steps
1. **Test matrix** — every cell needs a pass:

   | | iOS host | iOS viewer | Android host | Android viewer |
   |---|---|---|---|---|
   | Go live / join | | | | |
   | Chat send + receive | | | | |
   | Hearts | | | | |
   | Gifting | | | | |
   | Background / resume | | | | |
   | Network transition | | | | |
   | End / ended state | | | | |

2. **Cross-platform**: iOS host with Android viewers and vice versa. Codec and orientation differences surface here.
3. **Multi-viewer**: at least 5 concurrent viewers on one stream, ideally 10. Verify chat, counts, hearts, and gifts all stay consistent across every client.
4. **Two backend instances** for the whole matrix — this is how the Redis adapter gets validated under realistic conditions.
5. **Moderation dry run**: report a stream, find it in the admin queue, terminate it, confirm every viewer drops and the host cannot immediately restart.
6. **Accessibility**: labels on every control; VoiceOver and TalkBack over both screens. Check contrast of white overlay text against arbitrary video — the mockup's translucent dark pills are the mitigation; confirm they are implemented and sufficient.
7. **Staging builds via TestFlight and Play internal testing**, not sideloaded. Repeat the core matrix.
8. **Regression gate**: calling (including native ringing), chat, push, video playback, Google Sign-In, and IAP all verified unbroken.
9. **Staged rollout** with the backend's `LIVESTREAM_ENABLED` flag plus the host eligibility allow-list. Enable for internal accounts, then a small creator group, then widen. Live video is the one feature where a slow rollout is worth the delay.
10. **Known limitations** document: no replay, no multi-host, no desktop/RTMP streaming, portrait only, host cannot background, WebRTC viewer ceiling.

### Files / modules affected
- Test documentation
- Store listings (camera/microphone disclosures, live content policy)

### API / event flow
Full end-to-end across all roles and platforms. No new flows.

### Error and edge-case handling
- **A matrix cell fails** → a blocker.
- **Store review** — live user-generated video attracts scrutiny on both stores. You will likely need to demonstrate reporting, blocking, and moderation. Iteration 9 of the backend exists partly for this; have the moderation flow ready to show, and give reviewers a demo account plus instructions for reaching a live stream (which requires a second party — say how).
- **Age rating** — live UGC typically raises the rating on both stores. Check before submitting, not after a rejection.
- **Privacy policy** — must cover live video, chat, and any recording policy decided in backend Iteration 9. This is a legal requirement.
- **Cost spike during testing** → 10 concurrent viewers for an hour is 600 participant-minutes; a week of heavy QA is still inside the allowance, but watch the combined calling + livestreaming figure.

### Testing procedure
1. Execute all 28 matrix cells; record pass/fail with device and OS version.
2. Cross-platform host/viewer in both directions.
3. 10 concurrent viewers → chat, counts, hearts, and gifts consistent everywhere.
4. Entire matrix against two backend instances.
5. Moderation dry run end to end.
6. VoiceOver and TalkBack over host and viewer screens.
7. TestFlight and Play internal builds → repeat the core matrix.
8. Full regression: calling, ringing on a killed device, chat, push, playback, sign-in, IAP.
9. `LIVESTREAM_ENABLED=false` → the app behaves as though the feature does not exist.
10. Ten consecutive streams per platform → record the success rate; investigate below 95%.

### Expected result
A verified feature ready for a deliberately slow rollout.

### Completion criteria
- [ ] All matrix cells passed or documented as accepted limitations
- [ ] Cross-platform verified in both directions
- [ ] 10 concurrent viewers verified consistent
- [ ] Matrix run against two backend instances
- [ ] Moderation flow demonstrated end to end
- [ ] Accessibility verified with VoiceOver and TalkBack
- [ ] No regression in calling, chat, push, playback, sign-in, or IAP
- [ ] Store materials, age rating, and privacy policy updated
- [ ] ≥95% success over ten consecutive streams per platform

---

## Dependency graph

```
[Video Calling frontend 1-4 — native stack + Stream client, already done]
        │
        1 (generalise service + provider)
        └── 2 (backstage setup)
             └── 3 (host broadcast screen)     <- mockup: Live Stream Own
                  └── 4 (viewer watch screen)  <- mockup: Live Stream Others
                       └── 5 (chat overlay)    <- needs backend Redis adapter
                            ├── 6 (hearts)
                            ├── 7 (gifting)
                            └── 8 (discovery + entry points)
                                 └── 9 (resilience)
                                      └── 10 (QA + release)
```

**Watchable stream:** Iterations 1 → 4.
**Recognisable as the mockups:** add 5.
**Shippable:** all ten.

## Backend coupling

| Frontend iteration | Requires backend |
|---|---|
| 1 | Iteration 1 (`/stream/token`) |
| 2 | Iteration 3 (host lifecycle) |
| 4 | Iteration 4 (viewer join) |
| 5 | Iteration 6 (**gateway + Redis adapter**) |
| 6 | Iteration 7 (aggregated reactions) |
| 7 | Iteration 8 (gift service) |
| 8 | Iteration 5 (feeds + notifications) |
| 10 | All, especially 9 (moderation) |

## Deliberate non-goals

- **No replay / VOD playback.** Backend decision; a natural follow-up.
- **No multi-host or guest invites.**
- **No desktop / RTMP streaming.** Mobile-first.
- **No landscape.** Portrait-locked, like calling.
- **No HLS viewer path.** WebRTC only. HLS is the scale lever at roughly 1,000+ concurrent viewers; it is a backend per-call flag plus an alternative viewer component, not a rearchitecture. Revisit when a single stream approaches four figures.
- **No screen sharing.**
- **No direct Stream SDK imports outside `streamService.js`.** Same rule as calling; enforce it in review.

## Effort estimate

| Iterations | Work |
|---|---|
| 1 (generalise) | 1–2 days — mostly regression testing calling |
| 2–4 (three screens) | 6–8 days |
| 5 (chat overlay) | 3–4 days |
| 6 (hearts) | 2–3 days — animation performance is the work, not the logic |
| 7 (gifting) | 4–5 days — money paths deserve care |
| 8 (discovery) | 2–3 days |
| 9 (resilience) | 3–4 days |
| 10 (QA + release) | 3–4 days |
| **Total** | **~4–5 weeks** for one experienced React Native engineer |

Roughly 30% less than the calling roadmap, entirely because the native layer is already built and validated. There is no equivalent here of calling's high-variance CallKit iteration — the riskiest items are the chat overlay's performance under load and the gifting money path, both of which are ordinary application engineering rather than platform integration.
