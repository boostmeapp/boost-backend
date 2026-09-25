# Video calling — push setup and runbook

Incoming calls reach a **locked, backgrounded, or killed** phone only through push. Stream sends that push, using credentials configured in the Stream dashboard. The backend is not on the push path. It only tells the app which provider *names* to register its device tokens against, and checks that those providers exist.

If anything on this page is wrong, calls still ring when the app is open, but never on a locked phone, and **no error appears anywhere**. Check `GET /api/health/stream?check=true` first.

---

## What gets configured

| Stream provider name (default) | Type | Used by | Env var to override the name |
|---|---|---|---|
| `boostra-voip-sandbox` | APNs, VoIP, **development** | iOS **development** builds | `STREAM_APN_PROVIDER_SANDBOX` |
| `boostra-voip-production` | APNs, VoIP, **production** | iOS **staging, TestFlight, App Store** builds | `STREAM_APN_PROVIDER_PRODUCTION` |
| `boostra-android` | Firebase | all Android builds | `STREAM_FIREBASE_PROVIDER` |

**Why the APNs choice is per app build, not per backend:** `APNS_MODE` in `boostra-app/app.config.js` is `development` only for the development variant. Staging builds use **production** APNs but talk to the **dev** backend (`api-dev.boostra.me`). So the app sends `apnsEnvironment` in `POST /calls/token`, and the backend returns the matching provider name. `NODE_ENV` plays no part.

**Which Stream app needs what:**
- **Dev Stream app** (behind `api-dev`): all three. Development builds need the sandbox provider; staging and TestFlight builds need the production one.
- **Production Stream app** (behind `prodapi`, created in backend Iteration 13): `boostra-voip-production` and `boostra-android`. Store builds never use sandbox.

Identifiers: iOS bundle ID **`com.boostra.mobile`**, Android package **`com.boostra.app`**. They differ; don't swap them.

---

## Setup

### 1. Apple — APNs auth key (`.p8`)

1. [developer.apple.com](https://developer.apple.com/account/resources/authkeys/list) → Certificates, Identifiers & Profiles → **Keys**, signed in to team `MYJNL7NN38`.
2. If a key with **Apple Push Notifications service (APNs)** enabled already exists (Firebase iOS push likely uses one) and you still have its `.p8` file, reuse it. Otherwise **+** → name it, tick **APNs**, and download the `.p8`. **It can be downloaded only once.** Store it in the team password manager.
3. Note the **Key ID** (on the key page) and the **Team ID** (`MYJNL7NN38`).

A token-based `.p8` key can send VoIP pushes as well as normal ones, and it **does not expire**. The older certificate route (`.p12` "VoIP Services Certificate") also works, but expires yearly; avoid it.

Also confirm in **Identifiers → `com.boostra.mobile`** that **Push Notifications** is enabled.

### 2. Stream — the two APNs providers

In the [Stream dashboard](https://dashboard.getstream.io/) → your app → **Push Notifications** (under the Video or app settings; the menu label varies) → **New configuration** → **APN**:

| Field | Sandbox provider | Production provider |
|---|---|---|
| Name | `boostra-voip-sandbox` | `boostra-voip-production` |
| Auth type | Token (`.p8`) | Token (`.p8`) |
| `.p8` key, Key ID, Team ID | from step 1 | from step 1 |
| Topic / bundle ID | `com.boostra.mobile` | `com.boostra.mobile` |
| Development / sandbox | **on** | **off** |
| Supports VoIP notifications | **on** | **on** |

Names must match exactly (or set the env vars to your names).

### 3. Stream — the Firebase provider

1. Firebase console → the project behind `boostra-app`'s `google-services.json` → Project settings → **Service accounts** → **Generate new private key**. You get a JSON file.
2. Stream dashboard → Push Notifications → New configuration → **Firebase**. Name `boostra-android`, and upload the JSON.

### 4. Backend

Nothing to do if you used the default names. Otherwise set the three env vars and restart.

### 5. Verify the configuration

```
GET /api/health/stream?check=true
```
`details.push` must show `"state": "ok"` for all three providers on the dev app (production app: the two it needs).

| State | Meaning | Fix |
|---|---|---|
| `missing` | No provider of that name **and type** | Name typo, or created under the wrong type |
| `disabled` | Stream disabled it, usually after repeated delivery failures | Check the provider's error in the dashboard; re-upload credentials |
| `not_voip` | APNs provider without VoIP support | Enable VoIP on it |
| `unknown` | The backend couldn't list providers | Check Stream reachability and the API secret |

### 6. Verify on devices

This needs the app side (frontend Iterations 9 and 10). Physical devices only; simulators can't receive VoIP pushes.

1. Development build on an iPhone → the device token appears on the user in the Stream dashboard, against `boostra-voip-sandbox`.
2. Lock the phone and call it → it rings on the lock screen.
3. Force-kill the app and call again → it still rings. **This is the definitive test.**
4. Repeat on a physical Android device.
5. Install a **staging build from TestFlight** → it registers against `boostra-voip-production` and rings when killed. This is where an environment mismatch shows up.
6. Use the dashboard's push-test tool to test each provider in isolation before suspecting app code.

---

## "Calls don't ring on locked phones" — check in this order

1. `GET /api/health/stream?check=true` → every provider `ok`?
2. **Environment match.** Development build ↔ `boostra-voip-sandbox`; staging/TestFlight/App Store ↔ `boostra-voip-production`. The app must send the right `apnsEnvironment`. A mismatch drops every push **without error**.
3. **Device token registered?** Stream dashboard → the user → devices. None → the app isn't registering (frontend Iterations 9/10).
4. **Key still valid?** A revoked `.p8` key fails every push. Keys don't expire, but can be revoked in the Apple portal.
5. **Bundle ID / topic** is `com.boostra.mobile`, not `com.boostra.app`.
6. Android only: battery optimisation on aggressive OEMs (Xiaomi, Huawei, Oppo, Samsung) can block killed-app ringing. That's a device limitation, not config.

## Rotation

| Credential | Expires | Rotate by |
|---|---|---|
| APNs `.p8` key | never (only if revoked) | Create a new key → update both APNs providers in Stream → then revoke the old key |
| Firebase service account key | never by default (org policy may impose one) | Generate a new key → update the Firebase provider → delete the old key in Google Cloud IAM |
| (if used) `.p12` VoIP certificate | **yearly** | Renew before expiry; record the date here: `____` |

Always update Stream **before** revoking the old credential, then re-run step 5.

## Access

Record who holds these, so a rotation doesn't depend on one person:
- Apple Developer account (team `MYJNL7NN38`): `____`
- Stream dashboard: `____`
- Firebase project owner: `____`
- Where the `.p8` file and service-account JSON are stored: `____`

---

## Webhook (call records self-heal)

Stream reports call events (accepted, rejected, missed, ended, session ended) to `POST /api/calls/webhook`. This is what corrects a call record when a phone dies or loses signal without reporting.

**Setup**, per Stream app, in the Stream dashboard → your app → **Webhooks** (under the app or Video settings; the label varies):
- URL — dev app: `https://api-dev.boostra.me/api/calls/webhook`; production app: `https://prodapi.boostra.me/api/calls/webhook`.
- Enable it for call events. Unhandled event types are acknowledged and ignored, so sending all events is fine.
- No separate webhook secret: requests are signed with the app's API secret (`STREAM_API_SECRET`), and the backend rejects anything unsigned or tampered with a `401`.

**Local development** needs a public URL: run a tunnel (`ngrok http 5005` or `cloudflared tunnel --url http://localhost:5005`) and point a Stream app you're allowed to change at `<tunnel>/api/calls/webhook`. Don't repoint the shared dev app at your laptop.

**Staging on a shared Stream app:** set `STREAM_WEBHOOK_ENABLED=false` there. Webhooks are still verified and logged but change nothing.

**"Call records stuck `active`"** — check in this order:
1. Stream dashboard → Webhooks → delivery log: are deliveries to our URL failing?
2. Backend logs for `Rejected unverified Stream webhook`: the API secret differs between the backend and that Stream app.
3. Backend logs for `CallWebhookService`: events arriving but refused as illegal transitions.
4. The Iteration 9 sweeper closes anything still stuck.
