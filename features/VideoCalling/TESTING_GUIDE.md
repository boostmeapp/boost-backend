# Video Calling — End-to-End Testing Guide

How to test the whole calling feature from a clean start: what to set up, which accounts to create, and a test run that covers every flow, in the order the pieces depend on each other.

Other documents this guide relies on:
- [STREAM_DASHBOARD_SETUP.md](STREAM_DASHBOARD_SETUP.md): Stream dashboard steps. **Use the push provider names below**, not the `boostra-voip-dev` / `boostra-voip-prod` names that file mentions.
- [docs/video-calling-push-runbook.md](../../docs/video-calling-push-runbook.md): push providers and the webhook.
- [docs/video-calling-runbook.md](../../docs/video-calling-runbook.md): operations and troubleshooting.

---

## 1. What you need

### Devices
| Device | Why |
|---|---|
| **iPhone** (physical) | CallKit, VoIP push, iOS picture-in-picture. Simulators **cannot** receive VoIP pushes or ring. |
| **Android phone** (physical, Android 10+) | Telecom ringing, full-screen incoming call, Android picture-in-picture. |
| A third device (optional, either platform) | Busy tests ("already on a call"), and the third account. |
| Mac with Xcode, and Android Studio / adb | Building and installing development builds. |

Two phones on **different networks** (one on Wi-Fi, one on cellular) give the most realistic results. Only use the same Wi-Fi for the first smoke test.

### Service accounts (one-time)
| Service | Used for |
|---|---|
| Stream (dashboard.getstream.io) | A **dev** Stream app, separate from production |
| Apple Developer account (team `MYJNL7NN38`) | The `.p8` APNs key for iOS ringing |
| Firebase project `boostra-dev` | The service-account JSON for Android ringing |
| Expo / EAS account | Development builds (optional if you build locally) |
| Three email inboxes | The three test accounts (see section 4). Gmail `+` aliases are fine. |

---

## 2. Backend setup

### 2.1 Stream dev app
Follow [STREAM_DASHBOARD_SETUP.md](STREAM_DASHBOARD_SETUP.md) sections 1–5 in the **dev** Stream app:
1. Copy the API key, secret and app ID.
2. **Video → Call Types → `default`:**
   - Ringing **on**, and both timeouts set to 45000 ms.
   - Roles `user` and `call_member`: Join, Read, Send Audio, Send Video, End Call. **Not** Create Call.
3. Push providers. The names must match **exactly**:

   | Name | Type | Used by |
   |---|---|---|
   | `boostra-voip-dev` | APN, VoIP, **Development / Sandbox ON** | iOS **development** builds |
   | `boostra-voip-prod` | APN, VoIP, sandbox OFF | iOS staging / TestFlight / App Store builds |
   | `boostra-android` | Firebase (service-account JSON) | All Android builds |

4. **Webhook.** A local backend needs a public URL:
   - Run `ngrok http <PORT>` (or `cloudflared tunnel --url http://localhost:<PORT>`).
   - In **your own** Stream app (not the shared dev app), set the webhook URL to `<tunnel-url>/api/calls/webhook`.
   - Without the webhook, calls still work, but records only get corrected by the 5-minute sweeper. Crash, kill and "lost connection" tests then look wrong for a few minutes.

### 2.2 `boost-backend/.env`
Add or check these values (never commit them):
```
STREAM_API_KEY=<dev app key>
STREAM_API_SECRET=<dev app secret>
STREAM_APP_ID=<dev app id>
STREAM_PRODUCTION_APP_ID=<the PRODUCTION app's id>   # boot refuses to run a dev backend on the prod app
STREAM_APN_PROVIDER_SANDBOX=boostra-voip-dev
STREAM_APN_PROVIDER_PRODUCTION=boostra-voip-prod
STREAM_FIREBASE_PROVIDER=boostra-android
STREAM_WEBHOOK_ENABLED=true
CALL_RING_TIMEOUT_SECONDS=45
CALL_MAX_PER_HOUR=200          # the default of 30 is easy to hit during a test session
# CALLING_ENABLED              # leave unset: calling is ON outside production
```
The backend also needs MongoDB, Redis (calls use it for timeouts, busy checks and rate limits), and working email so sign-up codes arrive.

### 2.3 Start and check
```
cd boost-backend
npm run start:dev
```
Then check:
- `GET <api>/health/stream?check=true` returns `"status": "up"` with your dev app ID.
- The boot log has **no** `Refusing to start:` line (that means the Stream keys belong to the wrong app).

---

## 3. App builds

Calling needs native code, so **Expo Go does not work**. Use development builds.

1. Point the app at a backend **both phones can reach**. In `boostra-app/.env`, set `EXPO_PUBLIC_API_URL` to either:
   - your laptop's LAN IP, e.g. `http://192.168.1.20:<PORT>/api` (phones on the same Wi-Fi), or
   - the tunnel URL from 2.1 plus `/api`. This is the only option once a phone is on cellular.
2. Install on each phone. Either build locally:
   ```
   cd boostra-app
   npm run ios        # iPhone connected by cable, select it in the prompt
   npm run android    # Android phone with USB debugging
   ```
   or with EAS: `npm run build:dev:ios` / `npm run build:dev:android`, then install from the build page.
3. Start Metro with `npm start` and open the app on both phones.

**About iOS builds:** development builds register with `boostra-voip-dev`. To test the production push path (section 5.12), use a **staging / TestFlight** build, which registers with `boostra-voip-prod`.

---

## 4. Test accounts

Create three accounts. Real inboxes are needed, because the sign-up code is only sent by email. Gmail aliases all land in one inbox, e.g. `you+caller@gmail.com`.

| Account | Name to use | Device | Role in tests |
|---|---|---|---|
| **A — Caller** | `Test Caller` | iPhone | Starts most calls |
| **B — Callee** | `Test Callee` | Android | Receives most calls; swap roles later to cover both platforms |
| **C — Outsider** | `Test Outsider` | third device, or log in on A's phone later | Not mutually followed: checks permission rules |

### Steps
1. On each phone: **Sign up** with email and password, then enter the 6-digit code from the email. Google sign-in also works, and those accounts are verified automatically. **Unverified accounts cannot call.**
2. Give each account a **profile photo**, so avatars and the ringing screen can be checked.
3. Make **A and B follow each other**: open each other's profile → **Follow**, on both sides. By default, calls are only allowed between mutual follows.
4. Make **C follow B**, but B must **not** follow C.
5. Have A and B exchange **one chat message**, so there is a chat thread to call from.
6. **Admin account** (for checking reports and metrics): in MongoDB, set `role: "admin"` on account A's document in `users`. The in-app Admin Panel is then under Settings, and `GET <api>/admin/calls/metrics` works with A's token.
7. On first launch, **allow notifications** on both phones. On Android, also accept the calling prompt about notifications / battery optimisation when it appears (about 6 seconds after sign-in).

### Before you start: check both devices registered for ringing
In the Stream dashboard → **Video → Users**:
- A's user should list a device on `boostra-voip-dev`.
- B's user should list a device on `boostra-android`.

If a device is missing, ringing with the app closed will fail. Fix this before testing.

---

## 5. Test run

Work through the sections in order; later ones assume earlier ones pass. Tick each box, and write down the device, OS version and network for anything that fails.

> **Watch out while testing**
> - **Repeat missed-call notifications are held back.** Missed-call notifications from the same caller are collapsed for 15 minutes. The call still shows in history.
> - **The rating question only comes up sometimes.** The post-call sheet only asks for a rating on about 1 in 5 calls.

### 5.1 Smoke test (both apps open, same Wi-Fi)
- [ ] A opens the chat with B → the **phone** and **video** icons are in the header.
- [ ] A taps **phone**. The first time, a "why we ask" sheet appears → **Continue** → the OS microphone prompt → Allow.
- [ ] A sees "Calling…" with B's avatar; B's phone shows the incoming screen.
- [ ] B accepts. Both hear each other, and the timer starts at 0:00 on both.
- [ ] A hangs up with the red button → the call ends on both phones.

### 5.2 Outgoing call outcomes
- [ ] A calls B and B **declines** → A sees "Call declined" with **Call again** and **Message**.
- [ ] A calls B and B ignores it → after about 45 seconds, A sees "No answer".
- [ ] A calls B and **cancels** while it's ringing → B's ringing stops at once.
- [ ] B is already on a call with C (C must be mutually followed with B for this one; or use a third phone) → A calls B and gets "Test Callee is on another call".
- [ ] While ringing, the **speaker** and **camera** toggles on A's outgoing screen work.

### 5.3 Incoming call (app open)
- [ ] The ringing screen shows the caller's name and photo, with Accept and Decline.
- [ ] B answers on **another device** logged in as B → the ringing screen on the first device goes away.
- [ ] Permission denied: turn off the microphone for Boostra in system Settings → accept a call → a clear message with **Open Settings**.

### 5.4 Video call screen
- [ ] B's video is full screen on A's phone, and A's own video is in a small draggable tile (mirrored front camera).
- [ ] Drag the tile to every corner → it snaps to the corner and never goes off-screen.
- [ ] The controls fade after about 4 seconds; tapping brings them back.
- [ ] Flip camera, camera off/on, mute/unmute (B sees A's muted icon), end call.
- [ ] B turns their camera off → A sees B's avatar, not a black screen.

### 5.5 Audio call screen and switching
- [ ] A voice call shows the avatar layout, and audio comes from the **earpiece**; the proximity sensor blanks the screen at your ear.
- [ ] Speaker button → switches to the loudspeaker.
- [ ] With Bluetooth or wired headphones connected → the speaker button opens a picker (Phone / Speaker / Headphones).
- [ ] Mid-call, A turns on the camera → the screen switches to the video layout and audio moves to the speaker.

### 5.6 Ringing on a locked or closed phone (the most important section)
Test each direction: A to B (Android rings) **and** B to A (iPhone rings).
- [ ] Callee's phone **locked**, app open in the background → rings on the lock screen with the system call UI; answering opens the call.
- [ ] Callee **force-quits** the app → it still rings. Answer from the lock screen → the call connects and the app opens on the call screen.
- [ ] Decline from the lock screen → the caller sees "Call declined".
- [ ] Android: after declining on a locked phone, the app must **not** be usable over the lock screen once the screen turns off.
- [ ] iPhone: the call appears in the Phone app's **Recents**.
- [ ] Missed call (let it ring out) → a "Missed voice call from Test Caller" notification. Tapping it opens the chat thread.

### 5.7 Entry points, history and chat messages
- [ ] Profile: B's profile has phone and video buttons; **your own profile has none**.
- [ ] Log in as **C** → B's profile → call → "You can call Test Callee once you follow each other" (the button is greyed out, and tapping it explains why).
- [ ] After a call from the chat, a **call bubble** appears in the thread (e.g. "Outgoing voice call · 0:42" / "Missed video call" in red). Tapping it calls back.
- [ ] Messages → **phone icon** (top right) → call history lists direction, duration and time.
- [ ] Tapping a history row calls that person again with the same call type.
- [ ] Airplane mode, then open a chat → call buttons greyed out with "Calling unavailable — check your connection."
- [ ] B blocks A → A's chat with B shows **no** call buttons, with no explanation.

### 5.8 Resilience
- [ ] Mid-call, turn off Wi-Fi on one phone (falls to cellular) → "Reconnecting… Ns", then the call recovers.
- [ ] Airplane mode for **5s** and **15s** → recovers. For **60s** → both sides end with "Call lost".
- [ ] Background the app for 5 minutes on a voice call → audio continues; back in the app, the timer is correct.
- [ ] Force-quit A mid-call:
  - relaunch within about 30 seconds → "You're still in a call with Test Callee": **Rejoin** works;
  - wait longer → B's side ends with "Call lost", and on relaunch there's no stuck call.
- [ ] Phone call (GSM) arrives mid-call → choose **Hold & Accept** (iOS) → "On hold" → end the phone call → **Resume call** → audio is back.
- [ ] A bad network (e.g. a weak signal area) → the "Poor connection" badge; after about 10 seconds of it on video → an **Audio only** offer that works.

### 5.9 Minimise and picture-in-picture
- [ ] Call screen **back chevron** (and Android back) → back to the previous screen, and the call continues.
  - Video: a small draggable tile with B's video.
  - Voice: a pill with name, timer, mute and end.
- [ ] Tap the tile or pill → back on the full call screen with the correct timer.
- [ ] Open the chat keyboard while minimised → the tile or pill moves above the keyboard.
- [ ] Open a feed video while minimised → it does **not** play sound over the call.
- [ ] While minimised, call buttons are greyed out with "You're already in a call".
- [ ] B hangs up while A is minimised → "Call ended" on the pill for about 2 seconds, and A **stays on the same screen**.
- [ ] Video call → press Home → a **system picture-in-picture** window (Android and iOS). Return to the app → correct screen.

### 5.10 Settings, badge, post-call, report and block
- [ ] Settings → **Calls** → "No one" → from A, B's buttons are greyed out with "Test Callee isn't accepting calls". Change it back.
- [ ] Settings → Calls → "Everyone" → **C can now call B**. Change it back to "People who follow me back".
- [ ] Let 2 calls ring out on B → a **badge of 2** on the Inbox tab and the history icon; open history → the badge clears.
- [ ] iPhone: a missed-call notification has a **Call back** button → it starts a call of the same type. (Android: **Call back** appears on the in-app notifications list; tapping the system notification opens the chat.)
- [ ] Long-press a history row → **Delete** → gone for you, still in the other person's history. Trash icon → **Clear call history** → empty state.
- [ ] Hold an answered call for **more than 10 seconds**, then end it → a post-call sheet ("Call ended · m:ss", Call again / Message / Report). About 1 call in 5 also shows **star rating** chips.
- [ ] A call answered for less than 10 seconds, or missed, or declined → **no** sheet.
- [ ] In a call, **⋯ → Report** → pick a reason → the report shows in the Admin Panel → Reports.
- [ ] In a call, **⋯ → Block** → the call ends on both sides; A lands on Home; B's call buttons for A disappear.

### 5.11 Sign-out
- [ ] Sign out **during** a call → the call ends for the other person first.
- [ ] After signing out, call that account → it does **not** ring on the signed-out phone.

### 5.12 Production push path (before a release)
- [ ] Install a **staging / TestFlight** iOS build → in Stream, the device registers with `boostra-voip-prod` → it rings when the app is closed.

---

## 6. When something fails

| Check | Where |
|---|---|
| Did the call reach Stream? | Stream dashboard → **Video → Call Explorer**; look for `default:<uuid>` |
| Is the device registered for pushes? | Stream → **Video → Users → the user → devices** (provider name must match the build) |
| Is the webhook arriving? | Stream → **Webhooks → delivery log**; backend log `Rejected unverified Stream webhook` means the secrets differ |
| What happened to a call? | Backend logs: `grep "call.transition callId=<id>"` shows every status change |
| Totals and answer rate | `GET <api>/admin/calls/metrics?hours=24` with the admin account |
| One call's record | `GET <api>/admin/calls/<callId>` |

Common symptoms:
- **iOS never rings when the app is closed, with no errors:** the build and push provider don't match. A development build must use `boostra-voip-dev`; a TestFlight build must use `boostra-voip-prod`.
- **Android never rings when closed:** wrong Firebase JSON in `boostra-android`, the notification permission is off, or battery optimisation is killing the app. Set Boostra's battery use to **Unrestricted**.
- **`503 CALLING_UNAVAILABLE`:** Stream keys missing, or Redis is down.
- **A call button vanished for someone you can normally call:** probably the 3-decline block; see the note at the top of section 5.

## 7. Resetting between runs
- Call history: use **Clear call history** on each account.
- The "why we ask" permission sheet, and the Android reliability prompt: uninstall and reinstall the app. Both are remembered on the device.
- Calling permissions: iOS Settings → Boostra; Android App info → Permissions.
