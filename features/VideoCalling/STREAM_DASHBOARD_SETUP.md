# Stream Dashboard Setup — Video Calling

A step-by-step checklist for every credential and dashboard setting video calling needs, in the order you need them. It covers backend Iterations 1, 5 and 6.

Dashboard: https://dashboard.getstream.io. Stream renames menus now and then. If a label here doesn't match exactly, look for the nearest equivalent.

---

## 0. Values you'll need

| What | Value | Where it comes from |
|---|---|---|
| iOS bundle ID | `com.boostra.mobile` | `boostra-app/app.config.js` |
| Apple Team ID | `MYJNL7NN38` | `boostra-app/app.config.js` |
| Android package | `com.boostra.app` | `boostra-app/app.config.js` |
| Firebase project (dev) | `boostra-dev` | `boostra-app/google-services.json` |
| APNs mode | `development` build → **sandbox**; `preview` / `production` → **production** | `APNS_MODE` in `app.config.js` |

Use **two Stream apps**: one for dev (currently *Boostra - Shayan*, App ID `1729815`, tagged DEV) and one for production. Every step below has to be done in **each** app.

---

## 1. API keys → backend `.env` (Iteration 1)

### Get them
1. Open the Stream app, then click **API keys** in the top-right. The **Overview** page also shows them.
2. Copy:
   - **App ID** → `STREAM_APP_ID`
   - **API key** → `STREAM_API_KEY`
   - **Secret** (click the copy icon; it's masked) → `STREAM_API_SECRET`

### Put them in
- **Local:** `boost-backend/.env`
  ```
  STREAM_APP_ID=...
  STREAM_API_KEY=...
  STREAM_API_SECRET=...
  ```
- **Production:** your host's environment variables, using the **production** Stream app's values. Never commit them.
- `STREAM_API_SECRET` stays on the server. Never put it in the mobile app.

### Verify
```
GET /health/stream?check=true
```
Expect `"status": "up"` and `"appId"` matching the dashboard.

---

## 2. `default` call type (Iteration 5)

Go to **Video** (top bar) → **Call Types** → **`default`**.

### Settings
| Setting | Value | Why |
|---|---|---|
| Ringing | **On** | Backend creates calls with `ring: true` |
| Auto cancel timeout (caller side) | `45000` ms | How long the caller hears ringing |
| Incoming call timeout (callee side) | `45000` ms | How long the callee's phone rings. Keep it equal to the caller side. |
| Video enabled by default | On (fine) | Backend sends `video: false` for audio calls |
| Recording / Transcription / Broadcasting / Backstage | **Off** | Not used; some cost extra |
| Ring / call notifications (if a separate toggle exists) | **On** | Needed for push ringing in section 5 |

### Roles & permissions (same call type, **Roles & Permissions** tab)
Give the **`user`** and **`call_member`** roles these permissions:
- Join Call
- Read Call
- Send Audio
- Send Video
- End Call

Users **don't** need *Create Call*. The backend creates every call, so leaving it off stops clients from starting calls behind the backend's back.

### Verify
1. `POST /calls/token` as user A and as user B. They must follow each other.
2. `POST /calls` as A with `{ "calleeId": "<B>", "callType": "video" }` → `201`.
3. Go to **Video → Call Explorer** (or **Calls**). A call `default:<uuid>` should be listed with both users as members, and its `custom.callId` should match the Mongo `calls._id`.

---

## 3. Apple credential for iOS ringing (Iteration 6)

This is done in the Apple Developer portal, not Stream: https://developer.apple.com/account

### Option A — `.p8` APNs Auth Key (recommended)
1. **Certificates, IDs & Profiles → Keys → "+"**.
2. Name it, e.g. `Boostra APNs`, and tick **Apple Push Notifications service (APNs)**.
3. Click **Continue → Register → Download**. You can only download the `.p8` **once**, so store it in your password manager.
4. Write down the **Key ID** (10 characters) shown on the key page.

One `.p8` key works for **VoIP and regular** pushes in **both sandbox and production**, and it **never expires**. If you already have an APNs key for Expo notifications, you can reuse it.

### Option B — `.p12` VoIP Services certificate (only if you can't use a `.p8`)
1. **Certificates → "+" → VoIP Services Certificate**, then choose App ID `com.boostra.mobile`.
2. Upload a CSR from Keychain Access, download the `.cer`, and double-click it to add it to Keychain.
3. In Keychain, right-click the certificate → **Export** as `.p12` with a password.
4. It **expires after 1 year**. Put the expiry date in your calendar.

### Also check
**Identifiers → `com.boostra.mobile`**: the **Push Notifications** capability must be enabled.

---

## 4. Firebase credential for Android ringing (Iteration 6)

1. Go to https://console.firebase.google.com → project **`boostra-dev`**.
2. Click **⚙ Project settings → Service accounts**.
3. Click **Generate new private key → Generate key** to download a `.json` file.
4. Keep it secret. It gives full access to the Firebase project.

If production uses a different Firebase project, repeat this there and use that JSON in the **production** Stream app.

Stream needs this **service account JSON**, not the legacy "Server key".

---

## 5. Push providers in Stream (Iteration 6)

Go to **Video → Push Notifications**. In some dashboard versions it's under **App settings → Push**. Click **New configuration / Add provider** three times:

### Provider 1 — iOS sandbox
| Field | Value |
|---|---|
| Name | `boostra-voip-dev` |
| Provider | APN |
| Auth type | `.p8` (Token) |
| Key file | the `.p8` from section 3 |
| Key ID | from section 3 |
| Team ID | `MYJNL7NN38` |
| Bundle ID / Topic | `com.boostra.mobile` |
| Development / Sandbox | **ON** |
| Push type (if asked) | **VoIP** |

### Provider 2 — iOS production
Same as Provider 1 except:
| Field | Value |
|---|---|
| Name | `boostra-voip-prod` |
| Development / Sandbox | **OFF** |

### Provider 3 — Android
| Field | Value |
|---|---|
| Name | `boostra-android` |
| Provider | Firebase |
| Credentials | upload / paste the service account JSON from section 4 |

### Notes
- Type the **names exactly** as above. The backend sends them to the app in the `POST /calls/token` response, and a typo means pushes silently go nowhere.
- Enter the bare bundle ID. Stream adds the `.voip` suffix for VoIP pushes itself, unless the form explicitly asks for the full topic.
- If you used a `.p12` instead, choose the certificate auth type, upload the `.p12`, and enter its password.
- Repeat all three providers in the **production** Stream app.

---

## 6. Verify ringing on real devices

Simulators and emulators **cannot** receive VoIP pushes. Use physical devices.

1. Install a **development** build on an iPhone and sign in. The app registers its VoIP token with Stream.
2. Go to **Video → Users →** that user. A device should be listed with provider **`boostra-voip-dev`**.
3. If your dashboard has a **push test** button next to the provider or device, send a test first.
4. **Lock** the iPhone, then call it from the other account. It should ring on the lock screen.
5. **Force-quit** the app and call again. It should still ring. This is the test that matters.
6. Repeat on an Android phone. The device should show provider **`boostra-android`**.

---

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| iOS rings only when the app is open | Push provider missing, or the device isn't registered (check **Users →** device list) |
| iOS never rings, and Stream shows no errors | **Sandbox/production mismatch**. A dev build must use `boostra-voip-dev`; a TestFlight/preview/App Store build must use `boostra-voip-prod`. |
| iOS stopped ringing after months | `.p12` certificate expired (a `.p8` doesn't expire) |
| Android never rings | Wrong Firebase project JSON, or the package isn't `com.boostra.app` |
| `POST /calls` → `503 CALLING_UNAVAILABLE` | Stream keys missing in `.env`, or Redis is down |
| `POST /calls` → `502 CALL_FAILED` | Wrong `STREAM_API_SECRET`, or Stream is unreachable |
| `/health/stream` shows `down` | Wrong keys, or the keys belong to a different Stream app |

**The APNs environment follows the app build, not the backend.** A TestFlight build pointed at the dev backend still needs `boostra-voip-prod`.

---

## Not needed yet
- **Webhooks** (**Video → Webhooks**): Iteration 8, `STREAM_WEBHOOK_ENABLED`
- `CALL_RING_TIMEOUT_SECONDS`: Iteration 9
- `CALL_MAX_PER_HOUR`: Iteration 11
- The **Moderation → "Enable AI"** banner is chat moderation and unrelated to calling.
