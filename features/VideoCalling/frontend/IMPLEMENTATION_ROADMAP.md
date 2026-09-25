# Video Calling — Frontend Implementation Roadmap

**Target repo:** `boostra-app` (Expo SDK 54, React Native 0.81.5, Expo Router, Zustand, dev-client + EAS)
**Provider:** Stream Video (`@stream-io/video-react-native-sdk`)
**Scope:** 1:1 audio + video calling with full native ringing — CallKit on iOS, Core-Telecom/full-screen intent on Android
**Companion document:** `../backend/IMPLEMENTATION_ROADMAP.md`

---

## How to use this document

Each iteration is **independently executable**. Implement one, test it, verify the completion criteria, commit, and only then start the next. Where an iteration needs something from an earlier one — or from the backend roadmap — it is named explicitly under *Prerequisites*.

Iterations 1–8 produce a working in-app call. Iterations 9–10 are the native ringing layer, and are the hardest and riskiest part of this project. Iterations 11–14 complete the flow around the call, and Iteration 15 makes it shippable.

---

## Two project-specific risks, read before starting

These are properties of *your* app, not general advice. Both are addressed in Iteration 1 and both can invalidate the plan if they fail.

**1. New Architecture is enabled.** `app.json` sets `newArchEnabled: true`. The WebRTC native module and the CallKit bridge are the two most likely places for a New Arch incompatibility in this whole stack. Iteration 1 is a compatibility gate that exists specifically to discover this on day one rather than in week four.

**2. iOS links pods statically.** `app.config.js` sets `useFrameworks: "static"` — required by your Firebase setup (`disableSPM: true`). Static linkage is the standard source of duplicate-symbol and missing-header failures with the WebRTC pod. If it breaks, it breaks at `pod install`, loudly, which is the good case.

Neither is a reason to change provider. Both are reasons to build a dev client on real hardware before writing a single screen.

---

## Where things go

```
src/services/
  callService.js            # token fetch, client lifecycle, REST calls
  callkitService.js         # iOS CallKit + PushKit (Iteration 9)
  callNotificationService.js# Android full-screen intent (Iteration 10)

src/context/
  CallProvider.jsx          # StreamVideo provider + connection lifecycle

src/app/call/
  _layout.jsx
  [id].jsx                  # active call (video + audio modes)
  incoming.jsx              # incoming ring screen
  outgoing.jsx              # outgoing ring screen

src/components/call/
  CallControls.jsx
  ParticipantView.jsx
  CallAvatar.jsx
  CallTimer.jsx
  AudioRouteSheet.jsx       # speaker / earpiece / Bluetooth picker (Iteration 8)
  FloatingCallView.jsx      # minimised call over the app (Iteration 13)
  PostCallSheet.jsx         # rating + call again / message / report (Iteration 14)

src/app/settings/
  call-privacy.jsx          # "Who can call me" (Iteration 14)

src/hooks/
  useCallPermissions.js
  useIncomingCall.js

plugins/
  withCallingPlugin.js      # entitlements, background modes, manifest
```

The three mockup screens map to: `outgoing.jsx` (Incoming Call panel — "Calling…"), `[id].jsx` in video mode (Call Video panel), `[id].jsx` in audio mode (Call Audio panel). The *receiving* side ring UI is `incoming.jsx`, plus the native CallKit/Android UI from Iterations 9–10.

**Decided: the back chevron on the call screens minimises the call; it never ends it.** Only the red button ends a call. The minimised state (a floating call view in the app, plus system picture-in-picture when the app is backgrounded) is Iteration 13.

**Not in the mockups, but part of the complete flow** — and where each one is built:

| Gap | Iteration |
|---|---|
| Logging out during a call ends the call first | 4 |
| "Call again" / "Message" after declined, busy, or no answer | 5 |
| Incoming UI dismissed when answered or declined on the user's other device | 6, 9, 10 |
| Remote-muted indicator, auto-hiding controls, mirrored selfie preview, connect/end tones | 7 |
| Proximity sensor (screen off at the ear), audio route picker for Bluetooth | 8 |
| Minimise, floating call view, system picture-in-picture | 13 |
| "Who can call me" setting, update-required and not-accepting-calls states | 14 |
| Delete / clear call history, missed-call badge, "Call back" from the notification | 14 |
| Post-call rating, report and block from a call | 14 |

---

# Iteration 1 — Dependency install and native compatibility gate

### Goal
Install every native dependency and produce a **dev client that boots on physical iOS and Android hardware**. No feature code. The single purpose is to discover New Architecture and static-framework incompatibilities before anything is built on top of them.

### Prerequisites
- Physical iOS device and physical Android device. Simulators are insufficient for this feature and will mislead you.
- Apple Developer account with access to team `MYJNL7NN38` (already in `app.config.js`).
- EAS CLI authenticated.

### Implementation steps
1. Install the core SDK and its peer dependencies:
   ```
   npx expo install @stream-io/video-react-native-sdk @stream-io/react-native-webrtc \
     @react-native-community/netinfo react-native-incall-manager
   ```
   `react-native-svg` (15.12.1) and `react-native-reanimated` (~4.1.1) are already present and satisfy the peer requirements — verify versions rather than reinstalling.
2. Install the native ringing dependencies now, so a single build validates the whole stack:
   ```
   npx expo install @notifee/react-native react-native-callkeep react-native-voip-push-notification
   npx expo install @config-plugins/react-native-callkeep
   ```
3. Add the SDK's Expo config plugin and the callkeep plugin to the `plugins` array in `app.json`. Leave the `app.config.js` mapping logic untouched — it operates on `config.plugins` and must keep working.
4. `npx expo prebuild --clean`
5. Build and install a development build on **both** physical devices:
   ```
   npm run build:dev:ios
   npm run build:dev:android
   ```
6. Launch the app. Navigate through the existing tabs. **Nothing should have changed.**
7. Record the outcome in this iteration's notes: SDK versions installed, and whether anything required a patch.

### Files / modules affected
- `package.json`, `package-lock.json`
- `app.json` (plugins array)
- `ios/`, `android/` (regenerated by prebuild — not committed if they are gitignored; confirm your convention)

### API / event flow
None.

### Error and edge-case handling
- **Duplicate symbols / missing headers at `pod install`** → the static-framework problem. First remedy is `expo-build-properties` → `ios.extraPods` or a `modular_headers` override for the WebRTC pod via a config plugin. Do **not** remove `useFrameworks: "static"` — Firebase depends on it, and removing it will break push notifications you already ship.
- **App crashes on launch after install** → almost certainly a New Architecture incompatibility in a native module. Isolate by removing dependencies one at a time and rebuilding. If `react-native-callkeep` is the culprit, the fallback is **`expo-callkit-telecom`**, a modern Expo Modules API replacement built on CallKit and `androidx.core:core-telecom`. Switching costs roughly two days and only affects Iterations 9–10.
- **Android build fails on minSdk** → Notifee and the WebRTC module have floors (commonly 24+). Raise it via `expo-build-properties` in `app.json`.
- **Existing push notifications stop working** → the most dangerous regression in this iteration, because it affects shipped functionality. Test push explicitly in step 6 before declaring success.
- **`expo-doctor` warnings** → run `npm run doctor` and resolve version mismatches now. They compound.

### Testing procedure
1. App launches on physical iOS and stays up for 60 seconds of normal navigation.
2. Same on physical Android.
3. **Existing FCM push still arrives on both** — send one through the existing backend path. This is a regression gate, not a nice-to-have.
4. Google Sign-In still works (it shares native configuration surface).
5. Existing video playback (`expo-video`) still works.
6. `npm run doctor` → no new errors.
7. `import { StreamVideoClient } from '@stream-io/video-react-native-sdk'` in any file and log it → resolves, non-null, no red screen.

### Expected result
A dev client with the full calling stack linked, behaving identically to before.

### Completion criteria
- [ ] Dev build installs and runs on physical iOS **and** physical Android
- [ ] New Architecture verified compatible, or the callkeep fallback decision recorded
- [ ] Static-framework pod issues resolved without disabling `useFrameworks: "static"`
- [ ] Existing push, Google Sign-In, and video playback all verified unbroken
- [ ] SDK versions pinned and committed

---

# Iteration 2 — Native permissions, background modes, and entitlements

### Goal
Declare every native capability calling requires, so the OS permits microphone, camera, and background audio, and so VoIP pushes can be registered. Still no feature code.

### Prerequisites
- Iteration 1.

### Implementation steps
1. Create `plugins/withCallingPlugin.js`, modelled on the existing `plugins/withNotificationAndroidPlugin`. Keeping calling config in its own plugin means it can be removed cleanly.
2. **iOS — extend `UIBackgroundModes`.** `app.config.js` currently sets `['remote-notification']`. It must become:
   ```js
   UIBackgroundModes: ['remote-notification', 'voip', 'audio']
   ```
   - `voip` — lets PushKit wake the app for an incoming call.
   - `audio` — keeps audio alive when the user backgrounds an active call.
   Edit this in `app.config.js` where the array is already defined, rather than in the new plugin, so there is one source of truth.
3. **iOS — usage descriptions.** Add to `infoPlist`:
   - `NSMicrophoneUsageDescription` — "Boostra needs microphone access so you can talk during calls."
   - `NSCameraUsageDescription` — "Boostra needs camera access for video calls."
   Write real sentences. App Review rejects generic placeholders.
4. **Android — permissions** via the plugin: `RECORD_AUDIO`, `CAMERA`, `MODIFY_AUDIO_SETTINGS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_CAMERA`, `USE_FULL_SCREEN_INTENT`, `POST_NOTIFICATIONS`, `BLUETOOTH_CONNECT`, `WAKE_LOCK`.
5. **Android — foreground service declaration** with `foregroundServiceType="camera|microphone"`. Android 14+ rejects a service that starts without a declared type.
6. Create `src/hooks/useCallPermissions.js` — requests microphone and camera at runtime, returns `{ granted, request, blocked }`. Handles the `blocked` case (permanently denied) by offering a deep link to system settings.
7. `npx expo prebuild --clean` and rebuild both dev clients.
8. Verify the generated native files directly: `ios/Boostra/Info.plist` and `android/app/src/main/AndroidManifest.xml`. Do not assume the plugin worked.

### Files / modules affected
- `plugins/withCallingPlugin.js` *(new)*
- `app.config.js` (background modes, usage descriptions)
- `app.json` (register the plugin)
- `src/hooks/useCallPermissions.js` *(new)*

### API / event flow
None.

### Error and edge-case handling
- **Plugin ordering** — `app.config.js` appends `withNotificationAndroidPlugin` last, deliberately, so it runs after the notification plugins and can add `tools:replace` markers. Add `withCallingPlugin` **before** it, and re-verify the merged manifest. Breaking this ordering breaks your existing notifications.
- **`voip` background mode without PushKit usage** → App Review rejects it. It is added here but must be genuinely used by Iteration 9. Do not ship a build with the entitlement and no implementation.
- **Android 13+ `POST_NOTIFICATIONS`** → runtime permission. Already handled by the existing push service; confirm rather than duplicate.
- **`USE_FULL_SCREEN_INTENT`** → since Android 14 this is restricted, but calling apps remain an approved use case. It must be justified in the Play Console listing.
- **Permission permanently denied** → the app must degrade to a clear explanation and a settings link, never a blank camera view.

### Testing procedure
1. Inspect generated `Info.plist` → all three background modes and both usage descriptions present.
2. Inspect generated `AndroidManifest.xml` → all permissions and the typed foreground service present; existing notification entries intact.
3. Build both dev clients → install and launch cleanly.
4. Call `useCallPermissions().request()` from a scratch screen → both OS prompts appear with your custom copy.
5. Deny permanently, call again → `blocked` is true and the settings link opens the right page.
6. **Send an existing push notification** → still arrives. Regression gate again.

### Expected result
All native capabilities are declared and runtime permission handling exists.

### Completion criteria
- [ ] `voip` and `audio` background modes present in the built app
- [ ] Usage descriptions are specific, human sentences
- [ ] Android manifest has all permissions and a typed foreground service
- [ ] Existing notification manifest entries unaffected, verified in the merged output
- [ ] `useCallPermissions` handles granted, denied, and permanently-blocked

---

# Iteration 3 — Call service and Stream client bootstrap

### Goal
Fetch a Stream token from the backend and construct an authenticated `StreamVideoClient`. Provable by logging a connected client; no UI.

### Prerequisites
- Iterations 1–2.
- **Backend Iteration 3** (`POST /calls/token`) deployed and reachable.

### Implementation steps
1. Add call endpoints to `src/config/api.config.js` under a `CALLS` key, matching the existing `CHAT` structure: `TOKEN`, `INITIATE`, `HISTORY`, `ACCEPT`, `REJECT`, `END`.
2. Create `src/services/callService.js`, following the established service pattern (`chatService.js` is the closest model — module object, `apiClient`, `handleApiError`):
   - `async fetchToken()` → `POST /calls/token` via `apiClient` with body `{ apnsEnvironment }`, returns `{ apiKey, token, userId, push }`. `apnsEnvironment` is `'development'` for the development variant and `'production'` for every other variant — the same rule as `APNS_MODE` in `app.config.js`. Expose it from the config (e.g. via `extra`) rather than re-deriving it, so the two can never disagree. Getting this wrong makes killed-app ringing fail silently on iOS.
   - `async connect(user)` → builds the client:
     ```js
     StreamVideoClient.getOrCreateInstance({
       apiKey,
       user: { id: userId, name: user.name, image: user.avatar },
       tokenProvider: async () => (await callService.fetchToken()).token,
     })
     ```
     **Use `tokenProvider`, not a static token.** The SDK then refetches automatically on expiry, which is what makes 24-hour tokens safe and what makes backend secret rotation survivable.
   - `async disconnect()` → disconnects and clears the module-level reference.
   - `getClient()` → current instance or null.
   - Thin REST wrappers: `initiateCall`, `acceptCall`, `rejectCall`, `endCall`, `getHistory`.
3. Hold the client in a module-level variable exactly as `chatService.js` holds its socket. One instance per app session.
4. **Wrap the Stream SDK behind this service.** No component or screen should import `StreamVideoClient` directly. This is the abstraction boundary that makes a future provider change a contained edit rather than a rewrite — it costs almost nothing now and is the highest-leverage decision in this roadmap.
5. Use the existing `log`/`warn` helpers from `@/utils/log`, prefixed `[CALL]`, matching the `[CHAT_SOCKET]` convention.

### Files / modules affected
- `src/config/api.config.js`
- `src/services/callService.js` *(new)*

### API / event flow
```
callService.connect(user)
      │
      ├──> POST /calls/token  (apiClient attaches the Boostra JWT)
      │         └──> { apiKey, token, userId, push }
      │
      └──> StreamVideoClient.getOrCreateInstance({ apiKey, user, tokenProvider })
                └──> WebSocket to Stream coordinator
                      └──> connected

Token expiry ──> SDK invokes tokenProvider ──> POST /calls/token ──> reconnects silently
```

### Error and edge-case handling
- **No Boostra JWT** (logged out) → return null, do not throw. Matches `chatService.connectSocket()` behaviour exactly.
- **Backend returns 503** (calling disabled or Stream misconfigured) → surface a typed `CALLING_UNAVAILABLE` so the UI can hide call buttons rather than showing them and failing.
- **Token fetch fails transiently** → let `tokenProvider` reject; the SDK retries. Do not build a competing retry loop on top.
- **`connect()` called twice** → `getOrCreateInstance` is idempotent, but guard anyway so concurrent callers do not race.
- **User logs out while connected** → `disconnect()` must be called, or the next user's session inherits a client authenticated as the previous user. This is a real account-leakage bug; Iteration 4 wires the lifecycle.
- **Offline at connect time** → fails; the SDK reconnects when NetInfo reports connectivity. Do not block the UI on it.

### Testing procedure
1. Logged in, call `callService.connect(user)` from a scratch screen → resolves, logs a connected client.
2. Check the Stream dashboard → the user appears online.
3. Log out and call `connect()` → returns null, no crash, no unhandled rejection.
4. Stop the backend → fails gracefully with a logged error, no red screen.
5. Set backend `CALLING_ENABLED=false` → `CALLING_UNAVAILABLE` surfaces.
6. Airplane mode → connect fails; re-enable network → the SDK reconnects without app restart.
7. Confirm by grep that no file outside `callService.js` imports `StreamVideoClient`.

### Expected result
An authenticated Stream client, with automatic token refresh, behind a clean service boundary.

### Completion criteria
- [ ] Client connects and the user shows online in the dashboard
- [ ] `tokenProvider` used — no static token anywhere
- [ ] Logged-out and offline paths return cleanly
- [ ] Single instance guaranteed
- [ ] Stream SDK types confined to `callService.js`

---

# Iteration 4 — Call provider and auth lifecycle

### Goal
Connect the Stream client automatically on login, disconnect on logout, and make it available throughout the app — without slowing app start or breaking the existing auth flow.

### Prerequisites
- Iterations 1–3.

### Implementation steps
1. Create `src/context/CallProvider.jsx`:
   - Reads `user` and `isAuthenticated` from the Zustand store (`useStore`).
   - On `isAuthenticated` → true, calls `callService.connect(user)` and stores the client in state.
   - On → false, calls `callService.disconnect()` and clears state.
   - Renders Stream's `<StreamVideo client={client}>` wrapper when a client exists; renders children unwrapped otherwise, so the app works fully when calling is unavailable.
2. Mount it in `src/app/_layout.jsx`, **inside** whatever already provides auth and **outside** the router stack, alongside the existing `VideoPlaybackContext` pattern.
3. **Connect lazily and non-blockingly.** Do not `await` the connection during layout render — app start must not regress. Fire it and let the UI update when ready.
4. Add call state to the Zustand store (`src/store/index.js`) as a new slice, following the existing `createAuthSlice` shape:
   - `activeCall` — current call metadata or null
   - `incomingCall` — pending incoming call or null
   - `callConnectionState` — `'idle' | 'connecting' | 'connected' | 'failed'`
   - Actions: `setActiveCall`, `setIncomingCall`, `clearCall`, `setCallConnectionState`
   **Exclude this slice from `persist`.** Call state must never survive an app restart; a persisted `activeCall` would resurrect a dead call on next launch.
5. Reconnect on app foreground using `AppState`, mirroring how the existing push service handles foregrounding.
6. Expose `useCallClient()` returning `{ client, connectionState }`.

### Files / modules affected
- `src/context/CallProvider.jsx` *(new)*
- `src/app/_layout.jsx`
- `src/store/index.js`

### API / event flow
```
Login ──> store.isAuthenticated = true
            └──> CallProvider effect ──> callService.connect()
                     └──> connectionState: connecting -> connected
                             └──> <StreamVideo client> wraps the tree

Logout ──> isAuthenticated = false
            └──> callService.disconnect() ──> client cleared ──> store call slice reset

App foregrounded ──> AppState 'active' ──> reconnect if stale
```

### Error and edge-case handling
- **Connection fails** → `connectionState: 'failed'`. App remains fully usable; call buttons disable. Never block or gate unrelated screens.
- **Token expired while backgrounded** → `tokenProvider` handles it on reconnect. No manual work.
- **Rapid login/logout** → guard against an in-flight connect resolving after logout and installing a client for the previous user. Use a generation counter or an abort flag.
- **Provider mounted above the auth store** → `user` is null and nothing ever connects. Verify mount order explicitly.
- **Persisted call state** → the specific bug is a stale `activeCall` rehydrating on launch and navigating the user into a dead call screen. Excluding the slice from `persist` is the fix; verify it by killing the app mid-call.
- **App-start regression** → measure cold start before and after. If it moved, the connect is not lazy enough.
- **Logout (or account deletion) during an active or ringing call** → end the call first — `call.leave()` plus `POST /calls/:id/end` (or `/cancel` / `/reject` while ringing) — and only then `disconnect()`. Otherwise the other party is left talking to a silent call until the backend sweeper closes it.

### Testing procedure
1. Log in → `connectionState` reaches `connected`; user online in the dashboard.
2. Log out → disconnects; dashboard shows offline; call slice is reset.
3. Log in as user B immediately after → dashboard shows B, never A. The account-leakage test.
4. Background for 10 minutes, foreground → reconnects without restart.
5. Backend unreachable at login → app fully usable, `connectionState: 'failed'`.
6. Set `activeCall` manually, force-kill, relaunch → `activeCall` is null.
7. Cold start timing measured before and after → no meaningful regression.
8. Log out during a live call (once Iteration 7 exists) → the other side sees the call end within seconds; the record is `ended`.

### Expected result
The Stream client follows the auth session automatically and invisibly.

### Completion criteria
- [ ] Connects on login, disconnects on logout
- [ ] Rapid account switching never leaks a client between users
- [ ] Call state excluded from persistence, verified by force-kill
- [ ] App fully usable when calling is unavailable
- [ ] No cold-start regression

---

# Iteration 5 — Outgoing call screen

### Goal
Build the "Calling…" screen from the first mockup panel and wire it to real call initiation. The callee will not ring yet unless backend Iteration 5 is deployed — that is fine; this iteration owns the caller's side.

### Prerequisites
- Iterations 1–4.
- **Backend Iteration 5** (`POST /calls`) for a real ring; the screen can be built and tested against a stub before then.

### Implementation steps
1. Create the route group `src/app/call/_layout.jsx` — a stack with headers hidden, `gestureEnabled: false` (swiping away a live call must be impossible), and `animation: 'fade'`.
2. Create `src/app/call/outgoing.jsx`, taking `calleeId`, `calleeName`, `calleeImage`, `callType` as route params so it renders instantly from cached data with no fetch-and-flash.
3. Layout, per the mockup:
   - Full-bleed blurred callee avatar as background (`expo-blur` is already a dependency).
   - Centred circular avatar with a soft accent ring.
   - Callee name beneath.
   - Status text above: "Calling…"
   - Three controls at the bottom: speaker toggle, **end call** (red, centre), and — in the mockup a green accept, which on the *outgoing* screen becomes camera toggle for video calls or is omitted for audio.
4. Extract reusable pieces into `src/components/call/`: `CallAvatar`, `CallControls`. They are used by three screens; build them once.
5. On mount: request permissions via `useCallPermissions` **before** initiating. Denied → show the explanation and return, never a half-started call.
6. Call `callService.initiateCall()`, then join the Stream call as the caller so media is ready the instant the callee answers.
7. Subscribe to call state. On accepted → `router.replace('/call/[id]')`. **`replace`, never `push`** — the outgoing screen must not remain in the back stack behind an active call.
8. Handle end-call: leave the Stream call, `POST /calls/:id/cancel`, `router.back()`.
9. Local ringback tone via `react-native-incall-manager` so the caller hears the call is live.
10. `expo-keep-awake` (already a dependency) to hold the screen on.
11. **Unsuccessful outcomes offer a next step instead of just disappearing.** On declined, busy, or no answer, keep the screen for ~5 seconds with the outcome text and two buttons — **Call again** and **Message** (opens the chat thread, creating it if needed) — then auto-dismiss. A screen that vanishes the instant a call fails leaves the user with nowhere to go.

### Files / modules affected
- `src/app/call/_layout.jsx` *(new)*
- `src/app/call/outgoing.jsx` *(new)*
- `src/components/call/CallAvatar.jsx`, `CallControls.jsx` *(new)*
- `src/services/callService.js`
- `src/theme/*` (call-specific tokens)

### API / event flow
```
User taps call ──> router.push('/call/outgoing', { calleeId, calleeName, callType })
                      │
              useCallPermissions.request() ──> denied? show rationale, back out
                      │
              callService.initiateCall({ calleeId, callType })
                      └──> POST /calls ──> { callId, streamCallId }
                      │
              client.call('default', id).join()   (caller joins, awaits callee)
              InCallManager ringback starts
                      │
              call.state 'accepted'  ──> router.replace('/call/<id>')
              call.state 'rejected'  ──> "Call declined", auto-dismiss after 2s
              ring timeout (backend) ──> "No answer", auto-dismiss
              user taps end          ──> leave + POST /calls/:id/cancel ──> back
```

### Error and edge-case handling
- **`409 CALLEE_BUSY`** → "User is on another call", dismiss after 2s. Distinct copy from "No answer".
- **`403`** (blocked / not connected) → a neutral "Can't call this user right now". Must not disclose block state; the backend deliberately makes blocked and unavailable identical, and the UI must not undo that.
- **Permission denied mid-flow** → back out cleanly; no orphaned backend call record.
- **Double-tap on the call button** → disable the button on first press *and* rely on the backend Redis lock. Both.
- **Network drop while ringing** → show "Connecting…", let the SDK retry, and let the backend ring timeout resolve it.
- **Hardware back button on Android** → must map to end-call, not navigation. Intercept it.
- **App backgrounded while ringing** → the call continues; returning shows the live state. Do not tear down on blur.
- **Calling yourself** → prevent at the entry point in Iteration 11; the backend also rejects it.

### Testing procedure
1. Tap call → the screen renders immediately with the correct avatar and name, no flash of empty state.
2. Verify against the mockup at several device sizes, in light and dark.
3. Backend running, callee valid → record appears in Mongo as `ringing`; call appears in the Stream dashboard.
4. Call a busy user → the busy message appears, not a generic error.
5. Call a blocked user → the neutral message; nothing reveals the block.
6. Deny microphone → rationale shown, no backend record created.
7. End call while ringing → record becomes `cancelled`; screen dismisses.
8. Android back button while ringing → ends the call.
9. Double-tap the call button rapidly → exactly one call is created.
10. Airplane mode mid-ring → "Connecting…", then resolves on the backend timeout.
11. Declined / busy / no answer → outcome text with **Call again** and **Message**; Call again starts a new call, Message opens the thread; untouched, the screen dismisses after ~5s.

### Expected result
A caller can start a call and sees accurate live status through every outcome.

### Completion criteria
- [ ] Matches the mockup across device sizes and both themes
- [ ] Permissions requested before initiation
- [ ] Busy, blocked, declined, and no-answer each have distinct, correct copy
- [ ] Transition to the active call uses `replace`
- [ ] Android back and double-tap both handled
- [ ] Every exit path leaves a correct backend record

---

# Iteration 6 — In-app incoming call

### Goal
When the app is **open**, an incoming call surfaces a full-screen ring UI with accept and decline. Native ringing for backgrounded and killed states is Iterations 9–10; this is the foundation both build on.

### Prerequisites
- Iterations 1–5.
- **Backend Iterations 5 and 7.**

### Implementation steps
1. Create `src/hooks/useIncomingCall.js`:
   - Subscribes to the Stream client's ring events (`client.state.calls` / the SDK's incoming-call observable).
   - On an incoming ringing call, writes to the store's `incomingCall` and navigates to `/call/incoming`.
   - Cleans up on unmount and on client change.
2. Mount the hook inside `CallProvider` so it is active app-wide, not per screen.
3. Create `src/app/call/incoming.jsx` — visually the outgoing screen with different controls:
   - Blurred caller avatar background, centred avatar, caller name.
   - Status "Incoming call" / "Incoming video call".
   - Three controls per the mockup: mute-ringtone (left), **decline** (red, centre), **accept** (green, right).
4. Accept → join the Stream call, `POST /calls/:id/accept`, `router.replace('/call/[id]')`.
5. Decline → reject on the SDK, `POST /calls/:id/reject`, dismiss.
6. Ringtone and vibration via `react-native-incall-manager`. Respect the device silent switch — a call that rings through silent mode is a bug report.
7. **Present above everything.** Use a modal route so an incoming call interrupts any screen, including the video player and chat.
8. Auto-dismiss when the caller cancels or the backend ring timeout fires — do not leave a stale ring UI on screen.
9. **Multi-device:** Stream rings every device the callee is signed in on. When the call is accepted or declined *by this same user on another device*, the SDK reports it — dismiss the ring UI immediately on this device, stop the ringtone, and show nothing else (no "missed call"). Without this, a user who answers on their iPad keeps ringing on their phone.

### Files / modules affected
- `src/hooks/useIncomingCall.js` *(new)*
- `src/app/call/incoming.jsx` *(new)*
- `src/context/CallProvider.jsx`
- `src/store/index.js`

### API / event flow
```
Stream ──ring event──> useIncomingCall (active app-wide via CallProvider)
                            │
                    store.setIncomingCall(...)
                    router.push('/call/incoming')   (modal, above everything)
                            │
         Accept ──> call.join() + POST /calls/:id/accept ──> replace('/call/<id>')
         Decline ──> call.reject() + POST /calls/:id/reject ──> dismiss
         Caller cancels ──> ring event ends ──> auto-dismiss
         Ring timeout ──> auto-dismiss, missed-call notification arrives separately
```

### Error and edge-case handling
- **Call already ended before the user taps accept** → the backend returns `409` because terminal statuses are terminal. Show "Call ended" and dismiss. Do not join a dead call.
- **Second call arrives while ringing** → the backend busy check should prevent it, but handle defensively: auto-reject the second as busy.
- **Incoming call during an active call** → same; auto-reject busy. Call waiting is explicitly out of scope.
- **Incoming call while recording or in another audio session** → `InCallManager` must take the audio session; verify against `expo-video` playback, which your app uses heavily. Pause playback on ring.
- **Accept without permissions** → request at accept time. If denied, reject the call with a clear message rather than joining medialess.
- **Ringtone through silent mode** → respect the hardware switch.
- **Navigation stack pollution** → after accept, the incoming screen must not sit behind the active call. Use `replace`.

### Testing procedure
1. Two devices, both logged in and foregrounded. Call from A → B shows the incoming screen within ~2 seconds.
2. Accept → both land in the active call with two-way audio.
3. Decline → A sees "Call declined"; the record is `rejected`.
4. A cancels while B is ringing → B's screen auto-dismisses.
5. Let it ring past the timeout → B's screen dismisses; B gets a missed-call notification.
6. Ring B while B is watching a video → playback pauses, ringtone plays, call takes the audio session.
7. Ring B with the silent switch on → vibration only.
8. Accept an already-cancelled call by tapping at the exact moment → "Call ended", no join, no crash.
9. Ring B while B is already in a call → auto-rejected as busy, existing call undisturbed.
10. B signed in on two devices, both foregrounded → both ring; accept on one → the other stops ringing within ~2s and shows nothing further. Repeat with decline.

### Expected result
An open app reliably surfaces and handles incoming calls.

### Completion criteria
- [ ] Incoming UI appears over any screen, including video playback
- [ ] Accept and decline produce correct backend records
- [ ] Auto-dismiss on cancel and on timeout
- [ ] Audio session coordinated with `expo-video`
- [ ] Silent switch respected
- [ ] Busy and already-ended races handled without crashing
- [ ] Answering or declining on one device stops the ring on the user's other devices

---

# Iteration 7 — Active video call screen

### Goal
Build the second mockup panel: full-screen remote video, local picture-in-picture, call timer, and the control bar.

### Prerequisites
- Iterations 1–6.

### Implementation steps
1. Create `src/app/call/[id].jsx` reading `callId` from route params, plus `mode` (`video` | `audio`).
2. Video layout:
   - Remote participant video filling the screen (`ParticipantView` from the SDK, wrapped in your own `src/components/call/ParticipantView.jsx`).
   - Local video as a draggable PiP, bottom-right per the mockup, rounded corners, drop shadow. `react-native-gesture-handler` and `react-native-reanimated` are already available for the drag; clamp it to the safe area so it cannot be lost off-screen.
   - Top bar: back chevron, participant name, and a red recording-style pill showing elapsed time (`CallTimer`).
   - Bottom control bar per the mockup: flip camera, speaker, camera on/off, mute, end call (red).
3. `CallTimer` starts from the *joined* timestamp, not screen mount — they differ after a reconnect. Format `M:SS`, rolling to `H:MM:SS`.
4. Wire each control to the SDK: `call.camera.flip()`, `call.microphone.toggle()`, `call.camera.toggle()`, speaker routing through `InCallManager`.
5. Reflect true device state, not local optimistic state — if the OS revokes the microphone, the button must show muted.
6. Handle remote participant state: video off → show their avatar centred; poor connection → a quality indicator.
7. End call → leave, `POST /calls/:id/end`, `router.replace('/')` back to the tab the user came from.
8. Keep the screen awake and lock to portrait for the first release. Landscape is a whole additional layout and is not worth it now.
9. Post call-quality stats to the backend on end (backend Iteration 11), read from the SDK's stats API.
10. **Own the call outside the screen.** Keep the joined Stream `call` object and its subscriptions in `CallProvider` / the store's `activeCall`, not in `[id].jsx` component state. The screen only *renders* the call. This costs nothing now and is what lets Iteration 13 minimise the call without dropping it when the screen unmounts.
11. **Back chevron:** hide it until Iteration 13 lands. It must never end the call, and until minimising exists there is nowhere for it to go.
12. **Remote-muted indicator** — when the other participant's microphone is off, show a mic-off badge next to their name in the top bar (and on the audio-mode card in Iteration 8). Without it, "can you hear me?" is unanswerable.
13. **Auto-hiding controls in video mode** — fade out the top bar and control bar after ~4 seconds without interaction; a tap anywhere brings them back. Keep them visible while a toast or "Reconnecting…" is showing. The mockup shows them visible, which is the state after a tap.
14. **Mirrored self-view** — mirror the local preview for the front camera only; the back camera and the video sent to the other person are never mirrored. Check the SDK's default before adding code.
15. **Audio cues** — a short tone on connect and on end, via `InCallManager`, so a user who is not looking at the screen knows the state changed.

### Files / modules affected
- `src/app/call/[id].jsx` *(new)*
- `src/components/call/ParticipantView.jsx`, `CallTimer.jsx`, `CallControls.jsx` *(new/extended)*
- `src/services/callService.js`

### API / event flow
```
Joined ──> subscribe to call.state.participants
             ├──> remote video track ──> <ParticipantView>
             └──> local track ──> PiP

Controls ──> call.microphone.toggle() / call.camera.toggle() / call.camera.flip()
          └──> UI re-renders from SDK state, never from local optimistic state

End ──> call.leave() ──> POST /calls/:id/end ──> POST /calls/:id/stats ──> replace('/')
```

### Error and edge-case handling
- **Remote participant leaves unexpectedly** → show "Call ended", auto-dismiss after 2s.
- **Network drop mid-call** → "Reconnecting…" overlay; the SDK retries. Only give up after its timeout. Do not tear down on the first blip.
- **Camera unavailable** (another app holds it) → fall back to audio-only with a toast rather than a black rectangle.
- **PiP dragged off-screen** → clamp to safe-area bounds.
- **Timer after reconnect** → must continue from the original join time, not reset. A reset timer is a visible bug.
- **Backgrounding** → video suspends, audio continues via the `audio` background mode. Returning restores video. Verify on both platforms.
- **Incoming phone call (GSM)** → iOS will interrupt the audio session. Pause and resume on `AVAudioSession` interruption; `InCallManager` surfaces this.
- **Rotation** → locked to portrait for v1.
- **Very long calls** → confirm the timer formats past an hour and that no memory growth appears over a 30-minute call.

### Testing procedure
1. Full video call between two physical devices → two-way video and audio.
2. Each control individually: mute (verify the other side hears nothing), camera off (verify avatar fallback), flip, speaker.
3. Compare against the mockup: PiP position, control bar spacing, timer pill.
4. Drag the PiP to each corner → stays fully visible.
5. Airplane mode for 10s, then restore → "Reconnecting…", then recovery; timer continues correctly.
6. Background for 30s → audio continues; foreground restores video.
7. Receive a real phone call mid-call → audio pauses and resumes correctly.
8. 30-minute call → timer correct, no leak, no thermal or battery anomaly.
9. End from each side in turn → correct record and duration both ways.
10. Remote mutes → the mic-off badge appears on this side within a second; unmute → it clears.
11. No touch for 4s → controls fade; tap → they return. During "Reconnecting…" they stay visible.
12. Front camera → self-view mirrored; the other side sees you unmirrored (hold up text to check). Back camera → not mirrored.

### Expected result
A production-quality video call screen matching the mockup.

### Completion criteria
- [ ] Two-way video and audio verified on physical devices
- [ ] Every control works and reflects true device state
- [ ] Reconnection handled without tearing down the call or resetting the timer
- [ ] Background audio continues on both platforms
- [ ] GSM interruption handled
- [ ] Matches the mockup
- [ ] Call object owned by `CallProvider`, not the screen
- [ ] Remote-muted indicator, auto-hiding controls, and correct mirroring verified

---

# Iteration 8 — Audio call screen and mode switching

### Goal
Build the third mockup panel — audio-only — and let a call move between audio and video mid-session.

### Prerequisites
- Iterations 1–7.

### Implementation steps
1. Extend `src/app/call/[id].jsx` for `mode === 'audio'` rather than creating a second screen. The call state, timer, controls, and lifecycle are identical; only the media presentation differs. Two screens would mean two places to fix every bug.
2. Audio layout per the mockup:
   - Dark background, no video.
   - Centred circular remote avatar.
   - Top bar with name and the elapsed-time pill.
   - A small card, bottom-right, showing the *other* participant's avatar and name — occupying the same position the PiP holds in video mode, which is what makes the two modes feel like one screen.
   - Same five-control bar, with camera controls present but off.
3. Start audio calls with the camera disabled but **not** the track removed, so enabling video mid-call is instant.
4. **Mode switching:** tapping the camera button in audio mode enables the local video track. The remote side receives a participant-updated event and transitions to the video layout automatically. Because both modes are the same screen, this is a render change, not navigation.
5. Default audio routing: earpiece for audio calls, speaker for video calls. That is the expected platform behaviour, and getting it wrong is immediately noticeable.
6. Handle asymmetry — one side on video, the other audio-only is legitimate and must render correctly on both ends.
7. Animate the transition between layouts so it does not appear as a glitch.
8. **Proximity sensor** — in audio mode on the earpiece, turn the screen off when the phone is at the ear (`InCallManager` exposes this). Disable it when the speaker, Bluetooth, or video is on. Without it, cheeks press mute and end mid-call.
9. **Audio route picker** — when a Bluetooth or wired headset is connected, the speaker button opens `AudioRouteSheet` (e.g. iPhone / Speaker / AirPods) instead of toggling; with no headset it stays a simple speaker toggle, as in the mockup. The icon shows the current route.

### Files / modules affected
- `src/app/call/[id].jsx`
- `src/components/call/*`
- `src/components/call/AudioRouteSheet.jsx` *(new)*

### API / event flow
```
Audio call joined ──> camera track created but disabled
                      earpiece routing

Camera toggled on ──> call.camera.enable()
                       └──> Stream ──> remote 'participant updated'
                              └──> remote screen re-renders in video layout
                       └──> local routing switches to speaker

Camera toggled off ──> reverts both sides to audio layout
```

### Error and edge-case handling
- **Camera permission never granted** (audio call started without it) → request on first enable; denied → stay audio-only with a clear message.
- **Remote enables video, local is audio-only** → show their video, keep your camera off. Perfectly valid state.
- **Both toggle simultaneously** → both transition; no special handling, but verify there is no render thrash.
- **Routing on toggle** → moving to speaker when video enables is expected. Moving *back* to earpiece when video disables is debatable; pick one and be consistent.
- **Bluetooth headset connected** → routing must prefer it in both modes and must survive the toggle.
- **Rapid toggling** → debounce; repeated track renegotiation is expensive and can destabilise the session.

### Testing procedure
1. Audio call between two devices → audio layout on both, matching the mockup.
2. Verify earpiece routing by default; speaker toggle works.
3. Enable video from audio → both sides transition smoothly; routing moves to speaker.
4. Disable video → both return to audio layout.
5. One side video, the other audio → both render correctly.
6. Connect a Bluetooth headset → audio routes to it and survives the toggle.
7. Toggle the camera ten times rapidly → no crash, no stuck state.
8. Audio call with camera permission denied → enabling shows the rationale, call continues.
9. Audio call on earpiece, phone to the ear → screen turns off; away → back on. Speaker on → the screen stays on at the ear.
10. Bluetooth headset connected → the speaker button opens the route sheet; each route works; disconnect the headset mid-call → audio falls back to the earpiece and the button returns to a toggle.

### Expected result
Audio calls work natively and upgrade to video without interrupting the session.

### Completion criteria
- [ ] Audio layout matches the mockup
- [ ] Earpiece default for audio, speaker for video
- [ ] Mid-call mode switching works in both directions, both sides
- [ ] Asymmetric video state renders correctly
- [ ] Bluetooth routing correct and stable across toggles
- [ ] One screen serves both modes
- [ ] Proximity sensor active on earpiece only
- [ ] Route picker appears only when a headset is connected

---

# Iteration 9 — iOS CallKit and PushKit

### Goal
Make calls ring on a **locked or killed iPhone** with the native iOS call UI. This is the highest-risk iteration in the project; budget accordingly.

### Prerequisites
- Iterations 1–8.
- **Backend Iteration 6** — APNs VoIP provider configured in Stream.
- Physical iPhone. Simulators cannot receive VoIP pushes, full stop.

### Implementation steps
1. Create `src/services/callkitService.js` wrapping `react-native-callkeep` and `react-native-voip-push-notification`.
2. **Register the VoIP token.** On app start when authenticated, register for PushKit, obtain the VoIP token, and pass it to the Stream client along with the `apnProviderName` from the token response (backend Iteration 6). The backend picks that name from the `apnsEnvironment` the app sent (Iteration 3), so it always matches the build's APNs entitlement, whichever backend the build talks to.
3. **Set up CallKeep** with the display name, a ringtone, and `supportsVideo: true`.
4. **The critical constraint:** iOS *requires* that every PushKit VoIP push results in a `reportNewIncomingCall` — synchronously, in the same execution. Miss it and iOS terminates the app and eventually revokes VoIP privileges entirely. Report to CallKit **first**, then do any other work. The Stream SDK provides a helper for this path; use it rather than hand-rolling, and do not add any `await` before the report.
5. Wire CallKeep events:
   - `answerCall` → join the Stream call, navigate to `/call/[id]`.
   - `endCall` → reject or end, and report back to CallKit.
   - `didPerformSetMutedCallAction` → mirror into the SDK, so muting from the native UI actually mutes.
   - `didActivateAudioSession` → start `InCallManager`. Starting it before CallKit activates the session produces silent calls.
6. **Register the handler at module scope**, imported from `index.js` — not inside a React component. A killed app has no React tree when the push arrives.
7. Report call termination to CallKit whenever the call ends remotely, or iOS shows a phantom ongoing call in the status bar indefinitely.
8. Handle the cold-start case: the push launches the app, CallKit shows the UI, the user answers before the Stream client has connected. Queue the answer and process it once connected.

### Files / modules affected
- `src/services/callkitService.js` *(new)*
- `index.js` (module-scope registration)
- `src/context/CallProvider.jsx` (token registration)
- `src/services/callService.js`

### API / event flow
```
Backend initiates ──> Stream ──> APNs VoIP ──> locked iPhone
                                      │
                          PushKit wakes the app (even if killed)
                                      │
                    reportNewIncomingCall()  <- MUST be immediate, no await before it
                                      │
                          Native iOS call UI on the lock screen
                                      │
              Answer ──> callkeep 'answerCall'
                          └──> client connected? join now : queue until connected
                          └──> didActivateAudioSession ──> InCallManager.start()
                          └──> navigate to /call/<id>
              Decline ──> callkeep 'endCall' ──> POST /calls/:id/reject

Remote ends ──> callkeep.endCall(uuid)  <- or iOS shows a phantom call forever
```

### Error and edge-case handling
- **Failing to report a VoIP push** → app termination, then permanent VoIP revocation for that install. The most severe failure mode available; treat the immediate-report rule as inviolable.
- **`await` before `reportNewIncomingCall`** → the single most common way teams hit the above. Audit the code path for it.
- **Phantom ongoing call** → always report termination, including on error paths and on remote hang-up.
- **Wrong APNs environment** → silent failure, no error anywhere. Cross-check against `APNS_MODE` in `app.config.js` and the Stream provider config. Suspect this first whenever "nothing rings."
- **Push arrives while the app is foregrounded and already showing the in-app ring** → deduplicate by call ID; never show both.
- **Answered or declined on the user's other device** → end the CallKit call with the "answered elsewhere" / "declined elsewhere" reason, so iOS dismisses the ring without logging a missed call in Recents.
- **Cold start answer race** → queue the action; do not drop it.
- **VoIP token changes** → re-register on every app start, not once at install.
- **App Review** → VoIP background mode with a real CallKit implementation is compliant. Provide a demo account and clear testing instructions in the review notes, because reviewers must be able to receive a call.

### Testing procedure
All on a **physical iPhone**:
1. App foregrounded → call arrives; in-app UI shows, no duplicate CallKit UI.
2. App backgrounded → native iOS call UI appears.
3. **App force-killed, phone locked** → the call rings on the lock screen. The definitive test.
4. Answer from the lock screen → the app launches directly into the active call with working two-way audio.
5. Decline from the lock screen → the caller sees "declined"; the record is `rejected`.
6. Answer, then end from the native UI → the call ends correctly on both sides.
7. Mute from the native UI → verify the other side hears nothing.
8. Caller cancels while ringing → the iOS UI dismisses; no phantom call.
9. Answer, then end from the *caller* side → the callee's CallKit UI dismisses.
10. Ten consecutive killed-app calls → all ten ring. Any miss indicates the report rule is being violated intermittently.
11. Verify the call appears in the iOS Recents list.

### Expected result
Calls ring on a locked, killed iPhone with the native UI and are fully controllable from it.

### Completion criteria
- [ ] Ringing verified on a **locked, force-killed** physical iPhone
- [ ] `reportNewIncomingCall` is immediate, with no preceding `await` anywhere on the path
- [ ] Answer, decline, mute, and end all work from the native UI
- [ ] No phantom calls after any termination path, including error paths
- [ ] Ten consecutive killed-app calls all ring
- [ ] No duplicate UI when foregrounded
- [ ] App Review notes drafted with a demo account

---

# Iteration 10 — Android incoming call

### Goal
The Android equivalent: a full-screen incoming call over the lock screen, plus a foreground service that keeps an active call alive.

### Prerequisites
- Iterations 1–9 (9 is not strictly required, but doing iOS first surfaces the shared design).
- **Backend Iteration 6** — Firebase provider configured in Stream.
- Physical Android device.

### Implementation steps
1. Create `src/services/callNotificationService.js` using `@notifee/react-native`.
2. **Register a background message handler at module scope** in `index.js`, alongside the existing `setBackgroundMessageHandler` from your push service. **Do not replace the existing handler** — branch on message type so call pushes and your current notifications coexist. Breaking existing notifications here is a real risk.
3. On a call push, display a Notifee notification with:
   - `category: 'call'`, `fullScreenAction` — produces the full-screen UI over the lock screen.
   - `ongoing: true`, `autoCancel: false`.
   - Accept and Decline action buttons.
   - A dedicated high-importance `calls` channel with a ringtone and vibration, created at app start. Android silently drops notifications with no channel.
4. Wire the action buttons to the same accept/decline handlers as Iteration 6, so there is one code path regardless of entry point.
5. **Foreground service** for active calls, with `foregroundServiceType="camera|microphone"` (declared in Iteration 2). Without it Android kills the call when the app backgrounds. Start on join, stop on end.
6. Full-screen intent must show over the lock screen — `setShowWhenLocked` and `setTurnScreenOn` on the activity, via the Iteration 2 config plugin.
7. Cancel the notification on every termination path, including remote cancel and timeout.
8. Request `POST_NOTIFICATIONS` on Android 13+ (the existing push service likely already does — extend, do not duplicate).
9. **Optional but recommended:** register with the Telecom stack (`androidx.core:core-telecom`) so calls integrate with the system dialer. This is polish, not a requirement; defer it if Iteration 15 is close.

### Files / modules affected
- `src/services/callNotificationService.js` *(new)*
- `index.js` (extend the existing background handler)
- `plugins/withCallingPlugin.js` (activity flags)
- `src/services/pushNotificationService.js` (branching)

### API / event flow
```
Backend initiates ──> Stream ──> FCM high-priority ──> Android device
                                      │
                    Module-scope background handler (branches by type)
                                      │
                    Notifee full-screen intent + 'calls' channel
                                      │
                          Full-screen UI over the lock screen
                                      │
              Accept ──> same handler as Iteration 6 ──> join ──> /call/<id>
                          └──> start foreground service (camera|microphone)
              Decline ──> POST /calls/:id/reject ──> cancel notification

Call ends (any path) ──> cancel notification + stop foreground service
```

### Error and edge-case handling
- **Existing notifications break** → the highest-probability regression in this iteration. The background handler must branch, not replace. Test existing pushes explicitly.
- **No notification channel** → Android drops the notification silently. Create the `calls` channel at app start.
- **Battery optimisation / OEM restrictions** — Xiaomi, Huawei, Oppo, and Samsung aggressively kill background apps. Some devices will not ring reliably when killed, and **this cannot be fully solved**. Detect aggressive OEMs and offer a one-time prompt to exempt the app from battery optimisation.
- **Foreground service not started** → Android kills the call on background. Start it on join, always.
- **Android 14 foreground service type** → must match the declared type or the service throws on start.
- **Full-screen intent restrictions (Android 14+)** → calling is an approved use case, but it must be justified in the Play Console.
- **Doze mode** → high-priority FCM messages pierce Doze. Verify the priority is actually set on Stream's side.
- **Notification not cancelled** → a stuck ongoing call notification the user cannot dismiss. Cancel on every path.
- **Answered or declined on the user's other device** → one more termination path: cancel the full-screen notification and stop the ringtone, with no missed-call follow-up.

### Testing procedure
All on **physical Android hardware**, ideally two vendors (one Samsung or Xiaomi):
1. App foregrounded → in-app UI, no duplicate notification.
2. App backgrounded → full-screen incoming call appears.
3. **App force-killed, screen locked** → full-screen UI over the lock screen.
4. Accept from the lock screen → launches into the active call with two-way audio.
5. Decline from the notification → correct backend record.
6. Accept, then background the app → the call continues; the foreground service notification is visible.
7. Caller cancels → the notification is dismissed automatically.
8. **Existing push notifications still work** — regression gate.
9. Test on an aggressive-OEM device with battery optimisation on, then off → document the difference honestly.
10. Ten consecutive killed-app calls → record the hit rate per device.

### Expected result
Android rings over the lock screen and sustains active calls in the background, with OEM limitations documented rather than hidden.

### Completion criteria
- [ ] Full-screen incoming call verified on a locked, killed physical Android device
- [ ] Existing FCM notifications verified unbroken
- [ ] Foreground service keeps backgrounded calls alive
- [ ] Notification cancelled on every termination path
- [ ] Battery-optimisation prompt implemented for aggressive OEMs
- [ ] Per-device reliability recorded for at least two vendors

---

# Iteration 11 — Entry points and pre-flight UX

### Goal
Put call buttons where users expect them, and make the pre-call experience clear — including when calling is not possible.

### Prerequisites
- Iterations 1–8 (9–10 recommended).
- **Backend Iterations 4 and 10.**

### Implementation steps
1. **Chat thread header** (`src/app/chat/[id].jsx`) → audio and video call icons, passing the existing `conversationId` so the backend can attach the call to the thread.
2. **Profile screen** (`src/app/profile/[id].jsx`) → a call action, subject to the same authorization rules.
3. **Call history** — a list view backed by `GET /calls`, showing direction, status, duration, and relative time. Place it in the chat tab or under settings; tapping a row re-initiates.
4. **Call events in chat** — render the `call`-type message the backend writes (backend Iteration 10) as a distinct bubble: an icon, "Missed call" / "Outgoing call · 4:12", and a tap-to-call-back action. Extend the existing `react-native-gifted-chat` custom message rendering.
   - Shape: `{ type: 'call', sender: <initiator>, recipient: <callee>, text, call: { callId, callType, status, durationSeconds } }`. Messages without `type` are text.
   - `text` is a neutral fallback ("Missed video call", "Voice call · 4:12") that older app versions show as a normal bubble. Build the bubble's own copy from `call` and whether the viewer is the sender (e.g. "Outgoing call" vs "Incoming call"), not from `text`.
   - They arrive live through the existing `newMessage` / `conversationUpdated` socket events.
   - **Missed-call notifications** arrive as type `MissedCall` with `metadata: { callId, callerId, callType, conversationId? }`. Add a case to `handleRowPress` in `NotificationsScreen.jsx` and to the push tap handler: open the conversation when `conversationId` is present, otherwise the caller's profile. Current app versions ignore unknown types, so nothing breaks before this ships.
5. **Disable rather than fail.** When `connectionState !== 'connected'`, or the user is blocked, or calling is disabled server-side, the call button is visibly disabled with a reason on tap. A button that always fails is worse than no button.
6. **Permission pre-flight** — on first-ever call, show a short explanatory sheet before the OS prompt. Permission grant rates are materially higher with context, and a permanent denial is expensive to recover from.
7. Hide call entry points entirely for blocked users, consistent with how the existing chat handles blocks.

### Files / modules affected
- `src/app/chat/[id].jsx`
- `src/app/profile/[id].jsx`
- `src/app/(tabs)/chat/index.jsx` (history entry)
- `src/components/call/*`, `src/components/` (chat bubble)
- `src/services/callService.js`

### API / event flow
```
Chat header tap ──> router.push('/call/outgoing', { calleeId, conversationId, callType })
Profile tap     ──> same, without conversationId
History row tap ──> same, from the record

Screen mount ──> GET /calls?conversationId=  ──> render call bubbles inline
Connection state / block state ──> enable or disable the button with a reason
```

### Error and edge-case handling
- **Client not connected** → disabled button, "Calling unavailable — check your connection."
- **Calling disabled server-side** (`503`) → hide entry points entirely rather than disabling them; a permanently disabled control invites support tickets.
- **Blocked user** → no call button at all, matching existing chat behaviour.
- **Self-profile** → no call button.
- **Deleted user in history** → render a placeholder row; tapping shows "This user is no longer available."
- **Empty history** → a proper empty state, not a blank screen.
- **Rapid navigation** during initiation → guard against double navigation to the call route.

### Testing procedure
1. Chat header shows both buttons; each starts the right call type with the conversation attached.
2. Profile call button works and omits `conversationId`.
3. Call history lists correctly with accurate direction, duration, and relative time; pagination works past one page.
4. Complete a call from a chat thread → a call bubble appears in that thread live; the conversation list preview updates.
5. Tap the bubble → re-initiates.
6. Airplane mode → buttons disabled with the correct reason.
7. Backend `CALLING_ENABLED=false` → entry points hidden.
8. Blocked user's chat → no call buttons.
9. First-ever call → the pre-flight sheet appears before the OS prompt; not shown on subsequent calls.
10. Own profile → no call button.

### Expected result
Calling is discoverable where users expect it and honest about when it is unavailable.

### Completion criteria
- [ ] Entry points in chat header, profile, and history
- [ ] Call events render in chat and are tappable
- [ ] Buttons disabled or hidden correctly for every unavailable state
- [ ] Pre-flight permission sheet on first use only
- [ ] History paginates and handles empty and deleted-user states

---

# Iteration 12 — Resilience and edge-case hardening

### Goal
Make calls survive the conditions real users actually experience — bad networks, app switching, interruptions, and crashes.

### Prerequisites
- Iterations 1–11.

### Implementation steps
1. **Network transition handling** via `@react-native-community/netinfo`:
   - WiFi → cellular mid-call must recover, not drop. This is the most common real-world disruption and the most common thing teams fail to test.
   - Show "Reconnecting…" during recovery, with elapsed seconds so the state does not look frozen.
   - Give up only after the SDK's timeout, then show "Call lost" and end cleanly.
2. **App lifecycle:**
   - Background during a call → audio continues, video suspends, timer keeps accurate time.
   - Return → video resumes, UI reflects true state.
   - Force-kill during a call → on relaunch, `activeCall` is empty (Iteration 4) and the backend webhook (backend Iteration 8) has already closed the record. Verify both halves.
3. **Interruptions:**
   - Incoming GSM call → the OS takes priority; handle the audio-session interruption and resume after.
   - Alarm, Siri, another VoIP app → same path.
4. **Crash recovery** — on app start, if the backend reports a call still `active` for this user, offer to rejoin or end it. Prevents the user being invisibly "in a call."
5. **Degraded quality:**
   - Subscribe to the SDK's connection-quality events; show an indicator.
   - Offer to drop to audio-only on sustained poor quality rather than letting video stutter.
6. **Memory and battery** — profile a 30-minute call. Watch for listener leaks on the call object; unsubscribe on unmount, rigorously.
7. **Error boundary** around the call route so a render crash does not leave the user stuck on a frozen screen with live audio. On catch, end the call and navigate home.

### Files / modules affected
- `src/app/call/[id].jsx`
- `src/context/CallProvider.jsx`
- `src/services/callService.js`
- `src/components/call/*`

### API / event flow
```
NetInfo change ──> SDK reconnect ──> "Reconnecting… (Ns)" ──> recovered | "Call lost"

AppState background ──> video suspends, audio continues (voip/audio background modes)
AppState active     ──> video resumes, UI reconciles with SDK state

App start ──> GET /calls?status=active ──> found? offer rejoin or end

Quality degraded ──> indicator ──> sustained? offer audio-only fallback

Render crash ──> error boundary ──> call.leave() + POST /calls/:id/end ──> home
```

### Error and edge-case handling
- **WiFi → cellular** → must survive. The single most valuable test in this iteration.
- **Both sides lose network simultaneously** → the backend sweeper (backend Iteration 9) closes the record; clients show "Call lost."
- **Backgrounded past the OS limit** → iOS may suspend eventually even with the `audio` mode. Detect the drop and surface it rather than showing a live-looking screen.
- **Rejoin after crash** → only offer it if the other party is still present; rejoining an empty call is worse than ending it.
- **Listener leaks** → the most likely source of memory growth. Audit every `useEffect` subscription for a matching teardown.
- **Error boundary swallowing real bugs** → log to your error reporter before recovering. Recovering silently means never finding out.
- **Timer drift** → compute from the join timestamp on every render rather than incrementing a counter.

### Testing procedure
1. Start on WiFi, disable WiFi mid-call → recovers on cellular within a few seconds.
2. Airplane mode for 5s, 15s, 60s → recovers on the first two, clean "Call lost" on the third.
3. Background for 5 minutes → audio continues throughout; foreground shows the correct elapsed time.
4. Force-kill mid-call → relaunch shows no active call; the backend record is `ended`.
5. Kill only one side → the other detects it within the timeout and ends cleanly.
6. GSM call mid-call → pauses and resumes correctly.
7. Throttle to a poor network → the quality indicator appears; the audio-only offer follows on sustained degradation.
8. 30-minute call → profile memory; no unbounded growth.
9. Force a render error in the call screen → the boundary catches it, the call ends, the user lands home, and the error is reported.
10. Rejoin flow: crash mid-call while the other party stays → relaunch offers rejoin, and it works.

### Expected result
Calls behave predictably under the conditions that actually occur in production.

### Completion criteria
- [ ] WiFi ↔ cellular transition survives
- [ ] Background audio verified over 5 minutes on both platforms
- [ ] Force-kill leaves no stuck state on client or server
- [ ] GSM interruption handled
- [ ] No memory growth over 30 minutes
- [ ] Error boundary ends the call, reports, and recovers
- [ ] Crash-rejoin flow works

---

# Iteration 13 — Minimise, floating call view, and system picture-in-picture

### Goal
Give the mockup's back chevron a real behaviour: leave the call screen **without leaving the call**. The user can reply to a chat or check a profile mid-call, and return with one tap. When the app is backgrounded during a video call, the call continues in a system picture-in-picture window.

### Prerequisites
- Iterations 1–12. In particular Iteration 7 step 10: the call object lives in `CallProvider`, not in the screen.

### Implementation steps
1. **Back chevron and Android back on `/call/[id]` → minimise.** `router.back()` (or to the tab the user came from) while the call stays joined. Show the chevron now (Iteration 7 hid it). The red button remains the only way to end the call.
2. **`FloatingCallView`** — mount once in `src/app/_layout.jsx` above the router stack. Render it only when `activeCall` is set *and* the current route is not `/call/[id]`:
   - **Video mode:** a small draggable tile (~100×150) showing the remote video, snapping to the nearest corner and clamped to safe areas and above the tab bar. Reuse the Iteration 7 PiP drag code.
   - **Audio mode:** a compact pill with the avatar, name, running `CallTimer`, a mute button, and a red end button.
   - Tap → `router.push('/call/[id]')`. The timer keeps counting from the join timestamp.
3. **System picture-in-picture when the app is backgrounded in a video call.**
   - **Android:** enable `supportsPictureInPicture` on the main activity via `plugins/withCallingPlugin.js`, and use the Stream SDK's Android PiP support to enter PiP on background.
   - **iOS:** enable the Stream SDK's iOS PiP support on the call content (it relies on the `audio` background mode from Iteration 2).
   - The SDK's PiP API names have changed between versions; confirm them against the version pinned in Iteration 1 rather than copying examples.
   - Audio calls do not need PiP; audio already continues in the background.
4. **Silence the rest of the app while minimised.** Feed and profile videos (`expo-video`, `VideoPlaybackContext`) must stay paused or muted while `activeCall` is set, otherwise the user hears both. Resume normal behaviour when the call ends.
5. **Block conflicting actions while minimised.** Every call button (chat header, profile, history, call bubbles) is disabled with "You're already in a call" while `activeCall` is set. The backend returns `409 ALREADY_IN_CALL` anyway; this keeps the user from hitting it.
6. **Call ends while minimised** (remote hang-up, network loss, block) → the floating view shows "Call ended" for ~2 seconds, then disappears. Do not navigate the user away from what they are doing.

### Files / modules affected
- `src/components/call/FloatingCallView.jsx` *(new)*
- `src/app/_layout.jsx` (mount)
- `src/app/call/[id].jsx` (chevron, back handler)
- `src/context/CallProvider.jsx`
- `plugins/withCallingPlugin.js` (Android PiP flag)
- `src/context/VideoPlaybackContext*` (pause while in a call)

### API / event flow
```
Call screen ──chevron / Android back──> router.back()
                    └──> activeCall still joined ──> FloatingCallView renders
                              tap ──> router.push('/call/<id>')

App backgrounded (video mode) ──> system PiP window (SDK)
App foregrounded              ──> PiP closes, previous screen or call screen restored

Call ends while minimised ──> "Call ended" on the floating view ──> hidden after 2s
```
No new backend calls.

### Error and edge-case handling
- **Call owned by the screen instead of the provider** → minimising unmounts the screen and drops the call. This is why Iteration 7 moved ownership; verify it before building anything here.
- **Floating view covers important UI** (chat input, keyboard, tab bar) → keep it above the keyboard and tab bar, and draggable to any corner.
- **Deep link or notification tap while minimised** → navigate normally; the floating view stays on top.
- **Incoming second call while minimised** → auto-rejected as busy, same as Iteration 6.
- **iOS camera while backgrounded** → iOS stops camera capture in the background, so the other side sees your avatar (Iteration 7 fallback) until you return. Expected; do not treat it as a bug.
- **Android PiP refused** (user disabled it for the app in system settings) → the call continues as audio in the background; nothing breaks.
- **Logout while minimised** → Iteration 4's end-then-disconnect path still applies.

### Testing procedure
1. Video call → tap the chevron → land on the previous screen with the floating tile showing live remote video; audio uninterrupted on both sides.
2. Drag the tile to every corner → it stays visible, clear of the tab bar and keyboard.
3. Tap the tile → back in the full call screen; the timer shows the correct elapsed time.
4. Audio call → minimise → the pill shows the timer; mute and end on the pill both work.
5. Android hardware back on the call screen → minimises; it does not end the call.
6. Open a feed video while minimised → it does not play audio over the call.
7. Try to start another call while minimised → the button is disabled with "You're already in a call".
8. Remote hangs up while minimised → "Call ended" on the floating view, gone after 2s, no navigation.
9. Video call → home button → system PiP on Android and iOS; return → PiP closes and the call screen is correct.
10. Force-kill while minimised → Iteration 12's force-kill behaviour holds (no stuck state).

### Expected result
Users can leave the call screen and come back without ever dropping the call, on both platforms.

### Completion criteria
- [ ] Chevron and Android back minimise, never end
- [ ] Floating view for video and audio, draggable and tappable to return
- [ ] System PiP working on both platforms for video calls
- [ ] Other media silenced while a call is active
- [ ] New calls blocked while one is active
- [ ] Remote end while minimised handled without hijacking navigation

---

# Iteration 14 — Call settings, history management, and post-call actions

### Goal
Build the user-facing controls around calling that the mockups do not show: who can call me, managing call history, the missed-call badge, calling back from a notification, rating a call, and reporting or blocking from a call.

### Prerequisites
- Iterations 1–13 (11 for history and entry points).
- **Backend Iteration 12** (settings, `can-call`, history hide, unseen count, call reports, feedback).

### Implementation steps
1. **"Who can call me"** — `src/app/settings/call-privacy.jsx`, linked from the existing privacy/settings screen: *Everyone* / *People who follow me back* (default) / *No one*. `GET` / `PATCH /calls/settings`. Update optimistically and roll back on failure.
2. **Upgrade the Iteration 11 button states to the server's pre-flight.** Chat header and profile call buttons call `GET /calls/can-call/:userId` on screen focus (cache ~60s per user) and map the result:
   | Code | Button | Copy on tap |
   |---|---|---|
   | allowed | enabled | — |
   | `CALLS_NOT_ACCEPTED` | disabled | "{name} isn't accepting calls" |
   | `NOT_CONNECTED` | disabled | "You can call {name} once you follow each other" |
   | `CALLEE_UNSUPPORTED` | disabled | "{name} needs to update Boostra to receive calls" |
   | `CALLEE_BUSY` | enabled | handled by the outgoing screen at call time |
   | `USER_UNAVAILABLE` | hidden | — (never reveals a block) |
   The outgoing screen (Iteration 5) must also handle `CALLS_NOT_ACCEPTED`, `NOT_CONNECTED` and `CALLEE_UNSUPPORTED` from `POST /calls`, because the pre-flight can go stale.
3. **History management** in the Iteration 11 history list:
   - Swipe (or long-press) a row → **Delete** → `DELETE /calls/:id`. Remove the row optimistically.
   - **Clear call history** in the list's menu, behind a confirmation → `DELETE /calls`.
   - Copy makes clear this only affects the user's own list.
4. **Missed-call badge** — fetch `GET /calls/unseen-count` on app foreground and whenever a missed-call push arrives; show it on the history entry point (and on the chat tab if history lives there). Call `POST /calls/seen` when the history screen opens.
5. **"Call back" from the missed-call notification** — add a **Call back** action button (iOS notification category, Android action) through the existing push service. It opens `/call/outgoing` with `callerId` and `callType` from the notification metadata (backend Iteration 12). Tapping the notification body still opens the conversation.
6. **Post-call sheet** — `PostCallSheet`, shown after an answered call ends (not after missed, declined, or calls under ~10 seconds):
   - "Call ended · 4:12", then **Call again**, **Message**, and **Report**.
   - An optional 1–5 rating with quick issue chips (audio, video, dropped, echo). Ask on roughly 1 in 5 calls, not every call, to avoid fatigue; send with the Iteration 7 stats via `POST /calls/:id/stats`.
   - Dismissible with one tap or swipe; it never blocks the app.
7. **Report and block from a call** — a "⋯" menu in the call screen's top bar (and **Report** in the post-call sheet):
   - **Report** → reason picker (existing `ReportReason` values) → `POST /moderation/reports` with `contentType: 'call'`, `contentId: callId`.
   - **Block** → confirmation → `POST /moderation/block/:userId`. The backend ends the live call (backend Iteration 7); show "Call ended" and return home.
   - Reuse the existing report UI for videos and users if there is one, rather than building a second one.

### Files / modules affected
- `src/app/settings/call-privacy.jsx` *(new)*, settings entry link
- `src/components/call/PostCallSheet.jsx` *(new)*
- `src/app/call/[id].jsx` (overflow menu), `src/app/call/outgoing.jsx` (new error codes)
- Call history screen and entry points from Iteration 11
- `src/services/callService.js` (settings, `canCall`, `hideCall`, `clearHistory`, `getUnseenCount`, `markSeen`)
- `src/services/pushNotificationService.js` (Call back action)

### API / event flow
```
Settings ──GET/PATCH /calls/settings──> { callPrivacy }

Chat / profile focus ──GET /calls/can-call/:userId──> { allowed, code } ──> button state + copy

History ──swipe──> DELETE /calls/:id      ──> row removed
        ──menu───> DELETE /calls          ──> list emptied
        ──open───> POST /calls/seen       ──> badge cleared
Foreground / missed push ──> GET /calls/unseen-count ──> badge

Missed-call notification ──"Call back"──> /call/outgoing { callerId, callType }

Answered call ends ──> PostCallSheet ──rating──> POST /calls/:id/stats
                                     ──Report──> POST /moderation/reports { contentType: 'call' }
In-call ⋯ ──Block──> POST /moderation/block/:userId ──> backend ends the call
```

### Error and edge-case handling
- **Privacy save fails** → roll back the selection and show a toast; never display a setting that is not in effect.
- **`can-call` fails or times out** → leave the button enabled and let `POST /calls` decide. The pre-flight must never make calling *less* available than the backend allows.
- **Block leakage** → `USER_UNAVAILABLE` hides the button with no explanation, matching existing chat behaviour.
- **"Call back" on a notification for a user who has since blocked you, or whose privacy changed** → the outgoing screen shows the normal error copy.
- **Post-call sheet over an incoming call** → an incoming call always wins; dismiss the sheet.
- **Report submitted twice** → disable the button after the first submit.
- **Offline deletes** → roll back the optimistic removal and show a toast.

### Testing procedure
1. Set *No one* → another user's call button for you is disabled with "isn't accepting calls"; set *Everyone* → a non-connected user can call you.
2. Callee on an old build (never fetched a token) → caller sees "needs to update Boostra".
3. Blocked user → no call button, no explanation.
4. Change privacy while the caller's screen is open → tapping call shows the correct error from `POST /calls`.
5. Delete one history row → gone after refresh; still in the other user's history. Clear all → empty state.
6. Two missed calls → badge 2; open history → badge clears; another missed call → badge 1.
7. Missed-call notification → **Call back** starts a call of the same type; tapping the body opens the chat.
8. Answered call over 10s → post-call sheet; missed or declined → no sheet; rating reaches the backend.
9. Report from the sheet and from the in-call menu → report visible in the admin queue with call details.
10. Block mid-call → the call ends on both sides; the blocked user's buttons disappear.

### Expected result
Users control who can reach them, manage their own call history, and can act on a call afterwards — rate it, call back, report or block.

### Completion criteria
- [ ] "Who can call me" setting works and survives app restart
- [ ] Call buttons reflect `can-call`, with correct copy for every code and no block leakage
- [ ] Delete and clear history work and are per user
- [ ] Missed-call badge accurate and cleared on view
- [ ] Call back from the notification works on both platforms
- [ ] Post-call sheet shown only after answered calls, rating sampled
- [ ] Report and block reachable from the call

---

# Iteration 15 — QA matrix and release readiness

### Goal
Systematically verify the feature across the device and state matrix, and prepare the release.

### Prerequisites
- Iterations 1–14 complete and individually verified.
- **All backend iterations complete.**

### Implementation steps
1. **Build the test matrix.** Every cell needs a pass:

   | | App open | Backgrounded | Force-killed + locked |
   |---|---|---|---|
   | iOS — audio | | | |
   | iOS — video | | | |
   | Android (stock) — audio | | | |
   | Android (stock) — video | | | |
   | Android (aggressive OEM) — audio | | | |
   | Android (aggressive OEM) — video | | | |

   Each cell: ring → answer → 30s conversation → hang up → verify the record, history, and chat event.

2. **Cross-platform pairs** — iOS→Android and Android→iOS, in both directions, both call types. Codec and routing differences surface here and nowhere else.
3. **Outcome coverage** — for each platform pair: answered, declined, cancelled by caller, ring timeout, busy, network-lost, answered on another device, callee on an old build. Verify the backend record and the user-visible copy for each.
   Also on each platform: minimise and return, system PiP, and the post-call sheet.
4. **Accessibility** — every control needs an accessibility label; verify with VoiceOver and TalkBack, and check contrast on the control bar against the video background (white icons over arbitrary video is a real contrast problem — the mockup's translucent dark pill is the mitigation; confirm it is implemented).
5. **Build verification** — staging builds for both platforms via the existing EAS profiles, installed from TestFlight and Play internal testing, not sideloaded. **TestFlight uses production APNs**; this is where an APNs environment mismatch appears if one exists. It must be tested before release, not after.
6. **Store submission preparation:**
   - iOS: a demo account and explicit instructions for receiving a call in the App Review notes. Reviewers cannot test calling without a second party — provide a way, or expect rejection.
   - Android: justify `USE_FULL_SCREEN_INTENT` in the Play Console.
   - Both: updated privacy disclosures covering camera and microphone.
7. **Staged rollout** — coordinate with the backend's `CALLING_ENABLED` flag. Ship the client with entry points hidden, enable for internal accounts, then widen.
8. **Known-limitations document** — aggressive-OEM behaviour, no call waiting, no group calls, portrait only. Give support the honest list before users find it.

### Files / modules affected
- Test documentation
- `eas.json` (verify profiles; likely unchanged)
- Store listings and review notes

### API / event flow
Full end-to-end, all paths, all platforms. No new flows.

### Error and edge-case handling
- **A matrix cell fails** → it is a blocker, not a note. The exception is aggressive-OEM killed-app ringing, which may be genuinely unfixable; document it as a limitation rather than pretending it passes.
- **TestFlight ringing fails while development builds work** → APNs environment mismatch. Check `APNS_MODE` against the Stream provider configuration first.
- **App Review rejection for VoIP background mode** → normally caused by reviewers being unable to test. Better notes usually resolve it.
- **Play Console full-screen-intent rejection** → provide the calling justification.
- **Accessibility gaps** → fix before release; retrofitting is harder.

### Testing procedure
1. Execute all 18 matrix cells; record pass/fail per cell with device and OS version.
2. Cross-platform pairs, both directions, both call types.
3. All eight outcomes per platform pair.
4. VoiceOver and TalkBack navigation of all three call screens, the floating call view, and the post-call sheet.
5. Install staging builds from TestFlight and Play internal testing → repeat the killed-app ring test on both. Non-negotiable gate.
6. Verify existing features are unbroken: chat, push, video playback, Google Sign-In, in-app purchases.
7. Toggle `CALLING_ENABLED` off → the client hides calling cleanly with no crash.
8. Ten calls in a row on each platform → record the success rate. Below 95% on stock devices means something is wrong; investigate rather than ship.

### Expected result
A verified, documented feature ready for staged rollout.

### Completion criteria
- [ ] All matrix cells passed, or failures documented as accepted limitations
- [ ] Cross-platform calling verified in both directions
- [ ] All eight outcomes verified per platform
- [ ] Minimise, system PiP, and post-call sheet verified on both platforms
- [ ] Accessibility verified with VoiceOver and TalkBack
- [ ] **Killed-app ringing verified from a TestFlight build**, not just a dev build
- [ ] No regression in chat, push, playback, sign-in, or purchases
- [ ] Store review materials prepared
- [ ] Known limitations documented for support
- [ ] ≥95% success over ten consecutive calls per platform

---

## Dependency graph

```
1 (deps + compat gate)
└── 2 (permissions + entitlements)
    └── 3 (callService)
        └── 4 (provider + lifecycle)
            ├── 5 (outgoing screen)
            │    └── 6 (in-app incoming)
            │         └── 7 (video call screen)
            │              └── 8 (audio + mode switching)
            │                   ├── 9  (iOS CallKit/PushKit)   <- highest risk
            │                   ├── 10 (Android full-screen)
            │                   ├── 11 (entry points)
            │                   └── 12 (resilience)
            │                        ├── 13 (minimise + PiP)
            │                        └── 14 (settings, history mgmt, post-call)
            │                             └── 15 (QA + release)
```

**Demoable in-app call:** Iterations 1 → 8.
**Real calling product:** add 9 and 10.
**Complete flow:** add 11 → 14.
**Shippable:** all fifteen.

## Backend coupling

| Frontend iteration | Requires backend |
|---|---|
| 3 | Iteration 3 (token endpoint) |
| 5 | Iteration 5 (initiate) |
| 6 | Iterations 5, 7 (lifecycle) |
| 9 | Iteration 6 (APNs VoIP provider) |
| 10 | Iteration 6 (Firebase provider) |
| 11 | Iterations 4, 10 (authorization, history) |
| 12 | Iteration 10 (`GET /calls?status=active` for crash-rejoin) |
| 14 | Iteration 12 (settings, `can-call`, history hide, unseen count, call reports) |
| 15 | All |

Backend Iterations 1–7 should be complete before frontend Iteration 6. The two roadmaps can otherwise proceed in parallel.

## Deliberate non-goals

- **No group calls.** 1:1 only.
- **No call waiting.** A second incoming call is auto-rejected as busy.
- **No screen sharing or recording.**
- **No landscape.** Portrait-locked for v1.
- **No web support.** Mobile only, despite `expo start --web` existing.
- **No direct Stream SDK imports outside `callService.js`.** This is the constraint that keeps a provider change contained; it is worth enforcing in review.

## Effort estimate

| Iterations | Work |
|---|---|
| 1–2 (native setup) | 3–5 days — wide variance, driven entirely by the New Arch / static-frameworks gate |
| 3–4 (service + lifecycle) | 2–3 days |
| 5–8 (screens) | 6–8 days |
| 9 (iOS CallKit) | 4–7 days — **the highest-variance item in the project** |
| 10 (Android) | 3–5 days |
| 11–12 (entry points + resilience) | 4–6 days |
| 13 (minimise + PiP) | 3–4 days — PiP varies by SDK version and platform |
| 14 (settings, history mgmt, post-call) | 3–4 days |
| 15 (QA + release) | 3–4 days |
| **Total** | **~6–8 weeks** for one experienced React Native engineer |

Iteration 1 is where the estimate is won or lost. If New Architecture or static frameworks force patches or a fallback to `expo-callkit-telecom`, add a week. Doing that iteration first, on real hardware, is the entire reason it is sequenced first.
