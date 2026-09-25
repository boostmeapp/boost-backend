# Video Calling — Backend Implementation Roadmap

**Target repo:** `boost-backend` (NestJS 11, Mongoose 8, Redis/ioredis, Bull, Socket.IO, firebase-admin)
**Provider:** Stream Video (`@stream-io/node-sdk`)
**Scope:** 1:1 audio + video calling with native ringing (CallKit / Android Core-Telecom)
**Companion document:** `../frontend/IMPLEMENTATION_ROADMAP.md`

---

## How to use this document

Each iteration is **independently executable**. Implement one, test it, verify the completion criteria, commit, and only then start the next. No iteration depends on work from a later one. Where an iteration needs something from an earlier one, it is named explicitly under *Prerequisites*.

Iterations 1–6 produce a working ringing call. Iterations 7–12 make it correct, observable, and safe to launch.

---

## Architectural context

Stream Video is a **hosted SFU with built-in call signaling and ringing**. This is the single most important fact for scoping the backend: you are **not** building a WebRTC signaling server. Stream's client SDKs talk directly to Stream's coordinator over their own WebSocket, and Stream delivers the incoming-call push (APNs VoIP / FCM) itself.

The backend's responsibilities are therefore narrower than a from-scratch WebRTC build:

| Responsibility | Owner |
|---|---|
| SDP/ICE negotiation, media relay | Stream |
| Ring delivery, accept/reject propagation | Stream |
| VoIP push fan-out to devices | Stream (using credentials **we** configure) |
| **Who is allowed to call whom** | **Us** |
| **User token minting (auth bridge)** | **Us** |
| **Durable call records / history** | **Us** |
| **Missed-call notifications in our own feed** | **Us** |
| **Abuse controls, rate limits, moderation** | **Us** |

`chat.gateway.ts` is **not** used for call signaling. It stays exactly as it is. Calls get their own module.

### Module layout to be created

```
src/modules/call/
  call.module.ts
  call.controller.ts          # REST: token, initiate, history
  call.service.ts             # orchestration
  call-authorization.service.ts
  call-webhook.controller.ts  # Stream -> us
  stream-video.service.ts     # thin wrapper over @stream-io/node-sdk
  call.constants.ts
  dto/
  processors/
    call-timeout.processor.ts

src/database/schemas/call/
  call.schema.ts
```

### Environment variables introduced

| Variable | Introduced in | Purpose |
|---|---|---|
| `STREAM_API_KEY` | Iteration 1 | Public app key, also shipped to client |
| `STREAM_API_SECRET` | Iteration 1 | Server-only; signs user tokens, verifies webhooks |
| `STREAM_APP_ID` | Iteration 1 | Dashboard reference / logging |
| `STREAM_APN_PROVIDER_SANDBOX` | Iteration 6 | Stream APNs provider name for development builds (default `boostra-voip-sandbox`) |
| `STREAM_APN_PROVIDER_PRODUCTION` | Iteration 6 | Stream APNs provider name for staging/TestFlight/store builds (default `boostra-voip-production`) |
| `STREAM_FIREBASE_PROVIDER` | Iteration 6 | Stream Firebase provider name (default `boostra-android`) |
| `STREAM_WEBHOOK_ENABLED` | Iteration 8 | Kill switch for webhook ingestion |
| `CALL_RING_TIMEOUT_SECONDS` | Iteration 9 | Default `45` |
| `CALL_MAX_PER_HOUR` | Iteration 11 | Per-caller abuse cap, default `30` |

---

# Iteration 1 — Stream SDK foundation and configuration

### Goal
Install the Stream server SDK, wire credentials through the existing `ENV` config layer, and expose a health check proving the backend can authenticate against Stream. Nothing user-facing.

### Prerequisites
- A Stream account with a Video-enabled app created (Dashboard → Create App).
- **Maker Account application submitted.** You can build immediately while it processes; the trial credit covers development regardless.
- API Key, Secret, and App ID copied from the dashboard.

### Implementation steps
1. `npm i @stream-io/node-sdk`
2. Add the three variables to `.env` and to `.env.example`. Never commit the secret.
3. Extend `src/config` (the `ENV` object initialised in `app.module.ts`) with `STREAM_API_KEY`, `STREAM_API_SECRET`, `STREAM_APP_ID`. Follow the existing accessor pattern used for the Stripe and Redis values.
4. Create `src/modules/call/stream-video.service.ts`:
   - `@Injectable()`, constructs a single `StreamClient` in `onModuleInit` from `ConfigService`.
   - Throws on boot if key or secret is missing **and** `NODE_ENV === 'production'`; logs a warning and disables the feature otherwise, so local dev without credentials still boots.
   - Exposes `getClient()` and `isEnabled()`.
5. Create `src/modules/call/call.module.ts` importing `ConfigModule`, providing and exporting `StreamVideoService`.
6. Register `CallModule` in `app.module.ts` imports, after `ChatModule`.
7. Add a `GET /calls/health` route on a minimal `CallController` marked `@Public()` **only in non-production** — or simpler and safer: extend the existing `HealthModule` with a `stream` indicator. Prefer the latter.

### Files / modules affected
- `package.json`
- `.env`, `.env.example`
- `src/config/*`
- `src/modules/call/stream-video.service.ts` *(new)*
- `src/modules/call/call.module.ts` *(new)*
- `src/app.module.ts`
- `src/modules/health/*`

### API / event flow
None yet. Outbound only: the SDK will make a lightweight authenticated call to Stream during the health check.

### Error and edge-case handling
- **Missing credentials in production** → fail fast at boot. A silently disabled calling feature in production is worse than a failed deploy.
- **Missing credentials in dev** → log once at warn level, `isEnabled()` returns `false`, all call endpoints later return `503`.
- **Stream unreachable** → health indicator reports degraded; must not crash the app or fail the whole `/health` response for unrelated consumers.

### Testing procedure
1. `npm run start:dev` with valid credentials → boots clean, no warnings.
2. Hit the health endpoint → Stream indicator reports up.
3. Remove `STREAM_API_SECRET`, restart with `NODE_ENV=development` → boots with a warning.
4. Same with `NODE_ENV=production` → refuses to boot with a clear message naming the missing variable.

### Expected result
The app boots, a single shared `StreamClient` exists in the DI container, and health reports Stream connectivity.

### Completion criteria
- [ ] `StreamVideoService` is injectable from any module importing `CallModule`
- [ ] Boot fails loudly in production when credentials are absent
- [ ] Secret is absent from all logs, health output, and git history
- [ ] Health endpoint reflects real Stream reachability, not just config presence

---

# Iteration 2 — Call persistence schema

### Goal
Define the durable record of every call attempt. Stream owns live call state; we own history, analytics, and anything that must survive Stream.

### Prerequisites
- Iteration 1.

### Implementation steps
1. Create `src/database/schemas/call/call.schema.ts` following the conventions in `chat/conversation.schema.ts` (`@Schema({ timestamps: true, collection: 'calls' })`, `mongoose-paginate-v2` plugin, explicit indexes).
2. Fields:
   - `streamCallId: string` — required, unique, indexed. The `<type>:<id>` identifier used with Stream.
   - `callType: 'audio' | 'video'` — what the caller *requested*. Media can be toggled mid-call; this records intent.
   - `initiator: ObjectId (ref User)` — required, indexed.
   - `participants: ObjectId[] (ref User)` — required, indexed. Two entries for 1:1, array for future group support.
   - `conversation?: ObjectId (ref Conversation)` — links a call to the chat thread it was started from.
   - `status: CallStatus` — enum, indexed. See below.
   - `ringStartedAt: Date`, `answeredAt?: Date`, `endedAt?: Date`
   - `durationSeconds?: number` — computed on end, denormalised so history queries need no arithmetic.
   - `endedReason?: CallEndReason` — enum.
   - `endedBy?: ObjectId (ref User)`
   - `rejectedBy?: ObjectId[]`
   - `metadata?: Record<string, any>` — reserved for quality stats in Iteration 11.
3. Create `src/modules/call/call.constants.ts`:
   ```ts
   export enum CallStatus {
     Ringing   = 'ringing',
     Active    = 'active',
     Ended     = 'ended',
     Missed    = 'missed',
     Rejected  = 'rejected',
     Cancelled = 'cancelled',
     Failed    = 'failed',
   }

   export enum CallEndReason {
     HungUp         = 'hung_up',
     Rejected       = 'rejected',
     CancelledByCaller = 'cancelled_by_caller',
     RingTimeout    = 'ring_timeout',
     NetworkFailure = 'network_failure',
     CalleeBusy     = 'callee_busy',
     Blocked        = 'blocked',
     AdminTerminated = 'admin_terminated',
   }
   ```
4. Indexes:
   - `{ participants: 1, createdAt: -1 }` — the history query.
   - `{ status: 1, ringStartedAt: 1 }` — the timeout sweeper in Iteration 9.
   - `{ streamCallId: 1 }` unique — webhook reconciliation in Iteration 8.
5. Export from `src/database/schemas/index.ts`.
6. Register via `MongooseModule.forFeature` in `CallModule`.

### Files / modules affected
- `src/database/schemas/call/call.schema.ts` *(new)*
- `src/database/schemas/index.ts`
- `src/modules/call/call.constants.ts` *(new)*
- `src/modules/call/call.module.ts`

### API / event flow
None. Data layer only.

### Error and edge-case handling
- **Duplicate `streamCallId`** → unique index rejects it. Treat as idempotency protection, not an error to surface; Iteration 5 upserts.
- **A call that never ends** (client crashed, no webhook) → left `ringing`/`active` forever. Iteration 9 sweeps these. The `{ status, ringStartedAt }` index exists for exactly that.
- **Deleted user** → `participants` refs can dangle. History queries must tolerate a null populate rather than throwing.

### Testing procedure
1. Write a unit/integration test creating a `Call` document with all required fields → succeeds.
2. Omit `streamCallId` → validation error.
3. Insert two documents with the same `streamCallId` → duplicate key error.
4. `db.calls.getIndexes()` → confirms all three compound indexes exist.

### Expected result
A `calls` collection with correct indexes, and enums importable across the module.

### Completion criteria
- [ ] Schema compiles and registers without Mongoose warnings
- [ ] All three indexes verified present in MongoDB
- [ ] Enums are the single source of truth — no string literals for status anywhere else
- [ ] Pagination plugin attached, matching the `Conversation` pattern

---

# Iteration 3 — User token endpoint

### Goal
Let an authenticated Boostra user obtain a Stream user token, so the mobile client can connect to Stream as that user. This is the auth bridge between your JWT and Stream's.

### Prerequisites
- Iterations 1, 2.

### Implementation steps
1. In `StreamVideoService`, add:
   - `async upsertUser(user)` — pushes `id`, `name`, `image` to Stream so the remote party sees a name and avatar on the incoming-call screen. Call this on token issuance so it self-heals after profile edits.
   - `generateUserToken(userId: string, validitySeconds: number)` — wraps `client.generateUserToken({ user_id, validity_in_seconds })`.
2. Create `call.controller.ts` with `POST /calls/token`, protected by the existing `JwtAuthGuard` and reading the user via the `@CurrentUser()` decorator.
3. Response shape — return the API key alongside the token so the client has no hardcoded key:
   ```json
   {
     "apiKey": "<STREAM_API_KEY>",
     "token": "<jwt>",
     "userId": "<mongo id as string>",
     "expiresAt": "2026-09-25T12:00:00.000Z"
   }
   ```
4. **Token validity: 24 hours.** Long enough to avoid mid-call expiry, short enough to bound a leaked token. The client refreshes on expiry (frontend Iteration 3).
5. Use the Mongo `_id` string as the Stream `user_id`. Never a username or email — it must be immutable.
6. Sanitise the name: fall back to a generic label if the display name is empty, so the callee screen is never blank.
7. Apply `@Throttle()` — token minting is cheap but should not be an unauthenticated-adjacent amplification vector.

### Files / modules affected
- `src/modules/call/stream-video.service.ts`
- `src/modules/call/call.controller.ts` *(new)*
- `src/modules/call/call.module.ts`

### API / event flow
```
Client ──POST /calls/token (Bearer <boostra jwt>)──> CallController
                                                      │
                                              JwtAuthGuard validates
                                                      │
                                    StreamVideoService.upsertUser()  ──> Stream
                                    StreamVideoService.generateUserToken()
                                                      │
Client <────────── { apiKey, token, userId, expiresAt } ──────────────┘
```

### Error and edge-case handling
- **No/expired Boostra JWT** → `401` from the existing guard. Unchanged behaviour.
- **Stream disabled** (`isEnabled() === false`) → `503` with an explicit message, not a 500.
- **Stream upsert fails but token generation would succeed** → token generation is local (HMAC signing, no network). Log the upsert failure and still return the token; a missing avatar must not block a call.
- **Deactivated / banned user** → reject at this endpoint. It is the narrowest choke point for revoking calling access.
- **Clock skew** → Stream tokens are time-sensitive. If tokens are rejected as expired immediately, check server NTP before suspecting the code.

### Testing procedure
1. `POST /calls/token` with a valid JWT → `200` with all four fields.
2. Decode the returned token at jwt.io → `user_id` matches the caller's Mongo `_id`, `exp` ≈ 24h out.
3. No auth header → `401`.
4. Banned user → `403`.
5. Unset `STREAM_API_SECRET` in dev → `503`, not a stack trace.
6. Confirm in the Stream dashboard that the user now exists with the right name and avatar.

### Expected result
Any logged-in user can obtain a valid, correctly scoped Stream token.

### Completion criteria
- [ ] Token verifies against the Stream secret and carries the correct `user_id`
- [ ] Stream dashboard shows the user with name and avatar populated
- [ ] Secret never leaves the server
- [ ] Endpoint is rate limited and rejects banned users

---

# Iteration 4 — Call authorization rules

### Goal
Decide, server-side, whether user A may call user B. This is the core piece of business logic Stream cannot do for you, and it must exist before any call can be initiated.

### Prerequisites
- Iterations 1–3.
- Familiarity with the existing `follows` and `moderation` modules (block lists).

### Implementation steps
1. Create `call-authorization.service.ts` exposing:
   ```ts
   async assertCanCall(callerId: string, calleeId: string): Promise<void>
   ```
   Throws a typed `ForbiddenException` with a machine-readable `code`, so the client can show the right copy.
2. Checks, in this order (cheapest and most absolute first):
   1. **Self-call** — caller `===` callee → reject `CANNOT_CALL_SELF`.
   2. **Callee exists and is active** — not deleted, not banned → `USER_UNAVAILABLE`.
   3. **Block in either direction** — query the moderation/block source used by `chat.service.ts`. Reject `BLOCKED`. Return the *same* generic message in both directions so a blocked user cannot detect that they are blocked.
   4. **Relationship requirement** — this is a product decision; implement it as a configurable policy so it can change without a rewrite. **Decided: mutual follow only** — both users follow each other. Message history does not count. Reject `NOT_CONNECTED`.
   5. **Caller not banned from calling specifically** — a moderation flag separate from a full ban, for call-specific abuse. Reject `CALLING_RESTRICTED`.
3. Put the policy behind a small, named strategy object rather than inline `if`s, so the rule is readable and testable:
   ```ts
   const CALL_POLICY = { requireMutualFollow: true };
   ```
4. Reuse the block-list lookup from `chat.service.ts` rather than reimplementing it — a divergence between "can message" and "can call" is a moderation hole.

### Files / modules affected
- `src/modules/call/call-authorization.service.ts` *(new)*
- `src/modules/call/call.module.ts` (import the moderation/follows/chat providers it needs)
- `src/modules/call/call.constants.ts` (error codes enum)

### API / event flow
Internal only. Consumed by Iteration 5.

### Error and edge-case handling
- **Block applied while ringing** → this service runs only at initiation. Iteration 7 must also terminate a live call if a block lands mid-call.
- **Callee deleted between check and ring** → tolerable race; the ring simply goes nowhere and times out via Iteration 9.
- **Information leakage** → never reveal *why* in a way that discloses block state. `BLOCKED` and `USER_UNAVAILABLE` should present identically to the client.
- **Policy too strict at launch** → keep the flag; you will want to relax it.
- **Per-user control** → this policy is the app-wide default. Iteration 12 layers a per-user `callPrivacy` setting on top of it; keep the check order here (self → exists → block → relationship → restricted) so that layer slots in after the block check.

### Testing procedure
Unit tests with mocked models, one per branch:
1. Self-call → throws `CANNOT_CALL_SELF`.
2. Non-existent callee → `USER_UNAVAILABLE`.
3. Caller blocked callee → `BLOCKED`.
4. Callee blocked caller → `BLOCKED`, identical response body to the above.
5. No relationship, policy on → `NOT_CONNECTED`.
6. No relationship, policy off → passes.
7. Mutual follow → passes.
8. One-way follow (either direction), or messages exchanged without a mutual follow → `NOT_CONNECTED`.

### Expected result
A single, fully unit-tested gate that every call initiation must pass.

### Completion criteria
- [ ] All eight branches covered by passing tests
- [ ] Block checks share their source of truth with `chat.service.ts`
- [ ] Blocked and unavailable are externally indistinguishable
- [ ] Policy is a named, flippable constant, not scattered conditionals

---

# Iteration 5 — Call initiation

### Goal
Create a ringing call: authorize it, create it on Stream with `ring: true`, and persist the `Call` record. After this iteration a real device will ring, provided push is configured (Iteration 6).

### Prerequisites
- Iterations 1–4.

### Implementation steps
1. Add `createRingingCall()` to `StreamVideoService`:
   - `const call = client.video.call('default', callId)`
   - `await call.getOrCreate({ ring: true, data: { created_by_id, members: [{user_id: caller},{user_id: callee}], custom: { callType, conversationId } } })`
   - The `default` call type has ringing enabled; verify this in the dashboard rather than assuming.
2. Generate `callId` as a **UUIDv4** server-side. Never derive it from user IDs — that would make call IDs guessable and let a third party join.
3. Create `call.service.ts` → `async initiate(callerId, dto)`:
   1. `callAuthorization.assertCanCall(...)`
   2. Busy check — is either party already in a `ringing`/`active` call? If the callee is, reject `CALLEE_BUSY`. If the caller is, reject `ALREADY_IN_CALL`.
   3. Rate-limit check (stubbed here, enforced in Iteration 11).
   4. Persist the `Call` document with `status: Ringing`, `ringStartedAt: now`.
   5. Create the call on Stream.
   6. **Order matters:** persist *before* calling Stream, then update. If Stream fails, mark the record `Failed` and throw — you keep a record of the attempt. If you called Stream first and the DB write failed, you would have a ringing phone with no record.
   7. Enqueue the ring-timeout job (Iteration 9; no-op until then).
4. Add `POST /calls` to `call.controller.ts` with a validated DTO:
   ```ts
   class InitiateCallDto {
     @IsMongoId() calleeId: string;
     @IsIn(['audio','video']) callType: 'audio'|'video';
     @IsOptional() @IsMongoId() conversationId?: string;
   }
   ```
5. Response: `{ callId, streamCallId, callType, callee: { id, name, image }, createdAt }`. The client needs the callee's display data to render the outgoing-call screen immediately.
6. Use a **Redis lock** keyed on both user IDs (`ioredis`, `SET NX PX 5000`) around the busy-check-and-create sequence, so two simultaneous initiations cannot both pass the busy check.

### Files / modules affected
- `src/modules/call/call.service.ts` *(new)*
- `src/modules/call/stream-video.service.ts`
- `src/modules/call/call.controller.ts`
- `src/modules/call/dto/initiate-call.dto.ts` *(new)*
- `src/modules/call/call.module.ts` (import `RedisModule`)

### API / event flow
```
Caller ──POST /calls { calleeId, callType }──> CallController
                                                 │
                                        assertCanCall()  ──> 403 on failure
                                                 │
                                        Redis lock acquired
                                        busy check (both parties)
                                                 │
                                        Call doc persisted (status: ringing)
                                                 │
                                        Stream call.getOrCreate({ ring: true })
                                                 │
                                                 ├──> Stream pushes ring to callee devices
                                                 │
                                        Redis lock released
                                                 │
Caller <────── { callId, streamCallId, callee } ─┘
```

### Error and edge-case handling
- **Callee already ringing/active** → `409 CALLEE_BUSY`. Client shows "User is on another call."
- **Caller already in a call** → `409 ALREADY_IN_CALL`. Usually a stale client; the sweeper in Iteration 9 clears orphans.
- **Stream `getOrCreate` fails** → update the record to `Failed` with `endedReason: NetworkFailure`, return `502`. Do not leave it `ringing`.
- **Double-tap on the call button** → the Redis lock plus the busy check makes the second request a clean `409`. Frontend must also debounce.
- **Callee has no registered devices** → the call still rings in-app if they are foregrounded. It will time out otherwise, which is correct behaviour, not an error.
- **Lock acquisition fails** → return `409`, do not proceed unguarded.

### Testing procedure
1. Two test accounts, valid tokens. `POST /calls` → `201`, record in Mongo with `status: ringing`, call visible in the Stream dashboard.
2. Immediately repeat → `409 CALLEE_BUSY`.
3. Blocked pair → `403`, no Mongo record, no Stream call.
4. Invalid `calleeId` → `400` from the DTO validator.
5. Point `STREAM_API_KEY` at garbage → `502`, record persisted as `failed`.
6. Fire two initiations concurrently (e.g. `ab -n 2 -c 2`) → exactly one `201`.
7. With the frontend from its Iteration 6 in the foreground → the callee device shows the incoming call.

### Expected result
A call can be initiated, is authorized, is recorded, and rings the callee in-app.

### Completion criteria
- [ ] Ringing call visible in both Mongo and the Stream dashboard
- [ ] `callId` is a server-generated UUIDv4
- [ ] Busy in both directions returns `409`, never a double-ring
- [ ] Concurrent initiation is race-free under the Redis lock
- [ ] Stream failure leaves a `failed` record, never a stuck `ringing` one

---

# Iteration 6 — Push credentials so calls ring on locked devices

### Goal
Configure the push providers in Stream so an incoming call reaches a device whose app is backgrounded or killed. Without this, calls only ring when the app is already open — which is not a calling feature.

### Prerequisites
- Iteration 5.
- **Apple:** an APNs **`.p8` auth key** for team `MYJNL7NN38` (bundle ID `com.boostra.mobile`). A token-based `.p8` key sends VoIP pushes too and never expires, so an existing APNs key can be reused. Only the older certificate route needs a *separate* `.p12` VoIP Services certificate, and it expires yearly; avoid it.
- **Android:** the Firebase service account JSON for the project already backing `google-services.json`.

### Implementation steps
1. **Stream Dashboard → Push Notifications:**
   - Add an **APN provider** in *VoIP* mode. Upload the VoIP key, set bundle ID `com.boostra.mobile`. Create **two** providers — sandbox for development builds, production for TestFlight/App Store — mirroring the `APNS_MODE` logic already in `app.config.js`.
   - Add a **Firebase provider** with the service account JSON, for package `com.boostra.app`.
   - Note the exact provider *names*; the client passes them when registering device tokens.
2. Expose the provider names to the client. Add them to the `POST /calls/token` response:
   ```json
   { "apiKey": "...", "token": "...", "push": { "apnsEnvironment": "production", "apnProviderName": "boostra-voip-production", "firebaseProviderName": "boostra-android" } }
   ```
   This keeps environment-specific names out of the app bundle — the same binary works against staging and production.
3. **Select the APNs provider by the app build's APNs environment, not by `NODE_ENV`.** The app sends `{ apnsEnvironment: 'development' | 'production' }` in the `POST /calls/token` body (default `production`). This matters because staging builds use **production** APNs (`APNS_MODE` in `app.config.js`) but talk to the **dev** backend, so selecting by `ENV.IS_PRODUCTION` would hand them the sandbox provider and every push would be silently dropped. Provider names come from `STREAM_APN_PROVIDER_SANDBOX`, `STREAM_APN_PROVIDER_PRODUCTION` and `STREAM_FIREBASE_PROVIDER`.
   - The Stream health probe also lists the app's push providers and reports each configured name as `ok` / `missing` / `disabled` / `not_voip` under `/health/stream` → `details.push`, so a misconfiguration is visible instead of silent.
4. **Do not build your own VoIP push dispatch.** Stream sends the ring push. Your existing `NotificationService` is used in Iteration 10 for *missed-call* notifications only — a different, non-urgent path.
5. Document the credential rotation procedure in `boost-backend/docs/` — VoIP certificates expire, and the failure mode (calls silently stop ringing on locked iPhones) is very hard to diagnose cold.

### Files / modules affected
- `src/modules/call/call.controller.ts` (extend the token response)
- `src/config/*` (provider name resolution)
- `boost-backend/docs/*` *(new runbook)*
- Stream Dashboard (external configuration)

### API / event flow
```
Device registers its VoIP token ──> Stream (direct, via client SDK)
                                     │
POST /calls (Iteration 5) ──────────>│
                                     ├──> APNs VoIP  ──> locked iPhone wakes, PushKit fires
                                     └──> FCM high-priority ──> Android wakes
```
The backend is not on the push path. It only supplies the provider configuration.

### Error and edge-case handling
- **Wrong APNs environment** — the single most common failure. A development build registered against the production provider gets a sandbox token, and every push is dropped **without error**. The `APNS_MODE` logic in `app.config.js` already handles the entitlement; the Stream provider choice must match it.
- **APNs provider without VoIP enabled** → pushes are accepted and never delivered. The health check reports it as `not_voip`.
- **Bundle ID mismatch** — note that iOS is `com.boostra.mobile` and Android is `com.boostra.app`. Easy to cross-wire.
- **Expired or revoked credential** → silent ring failure. `.p8` keys don't expire but can be revoked; `.p12` certificates expire yearly. The runbook covers rotation.
- **User revoked notification permission** → cannot be fixed server-side. In-app ringing still works; frontend Iteration 11 handles the prompt.

### Testing procedure
1. Register a physical iOS device via a development build; confirm the VoIP token appears against the user in the Stream dashboard.
2. **Lock the phone.** Initiate a call from the other account → the device rings on the lock screen.
3. **Force-kill the app.** Initiate again → it still rings. This is the definitive test.
4. Repeat both on a physical Android device.
5. Use Stream's dashboard push-test tool to verify each provider in isolation before blaming application code.
6. Verify a staging build (sending `apnsEnvironment: production` to the dev backend) resolves the production APNs provider.
7. `GET /health/stream?check=true` → every configured provider reports `ok`.

> Simulators cannot receive VoIP pushes. Physical devices only, for every test in this iteration.

### Expected result
An incoming call rings a locked, backgrounded, or killed device on both platforms.

### Completion criteria
- [ ] Both APN providers (sandbox + production) and the Firebase provider configured and verified
- [ ] Provider names served by the API, not hardcoded in the app
- [ ] Verified ringing on a **locked** physical iPhone with the app **killed**
- [ ] Same verified on physical Android
- [ ] Rotation runbook written (`docs/video-calling-push-runbook.md`) with credential holders recorded

---

# Iteration 7 — Call lifecycle state machine

### Goal
Own the server-side transitions: accept, reject, cancel, end. Stream propagates these between clients; we need a correct, idempotent record of them and a guard against illegal transitions.

### Prerequisites
- Iterations 1–5.

### Implementation steps
1. Define the legal transition table explicitly in `call.constants.ts` — an actual map, not scattered `if` statements:
   ```
   ringing   -> active | rejected | cancelled | missed | failed
   active    -> ended | failed
   ended     -> (terminal)
   rejected  -> (terminal)
   cancelled -> (terminal)
   missed    -> (terminal)
   failed    -> (terminal)
   ```
2. Add `applyTransition(callId, nextStatus, actorId, reason)` to `call.service.ts`:
   - Loads the call, checks the transition table, rejects illegal moves with `409`.
   - **Idempotent:** transitioning to the status it already holds returns success without a write. Webhooks and client calls will both report the same event.
   - Sets `answeredAt` on → `active`, `endedAt` and `durationSeconds` on any terminal status.
   - Uses `findOneAndUpdate` with the current status in the filter, so the transition is atomic under concurrency.
3. Endpoints, all `JwtAuthGuard`-protected and all authorizing that the caller is a participant:
   - `POST /calls/:id/accept`
   - `POST /calls/:id/reject`
   - `POST /calls/:id/cancel` — initiator only
   - `POST /calls/:id/end`
4. **These endpoints are record-keeping, not control.** The client accepts/rejects through the Stream SDK directly (that is what makes it instant); it then informs us. The webhook in Iteration 8 is the authoritative backstop for when the client fails to report.
5. Add `endCall(streamCallId)` to `StreamVideoService` for administrative termination — needed for the mid-call block case and for moderation.
6. **Mid-call block:** when the moderation module records a new block, terminate any live call between the two users. Emit a domain event or call `CallService.terminateBetween(a, b)` from the moderation service.

### Files / modules affected
- `src/modules/call/call.service.ts`
- `src/modules/call/call.controller.ts`
- `src/modules/call/call.constants.ts`
- `src/modules/call/stream-video.service.ts`
- `src/modules/moderation/*` (hook for mid-call block)

### API / event flow
```
Callee taps Accept
   ├──> Stream SDK call.join()      (media starts immediately)
   └──> POST /calls/:id/accept      (record: ringing -> active, answeredAt set)

Either party hangs up
   ├──> Stream SDK call.leave()
   └──> POST /calls/:id/end         (record: active -> ended, duration computed)

Moderation records a block during a live call
   └──> CallService.terminateBetween() ──> StreamVideoService.endCall() ──> both clients dropped
```

### Error and edge-case handling
- **Illegal transition** (ending an already-rejected call) → `409`, no write, no exception noise in logs.
- **Duplicate accept** → idempotent success. Retries are normal on mobile networks.
- **Both parties hang up simultaneously** → the atomic `findOneAndUpdate` means the first wins and the second is a no-op. `endedBy` reflects whoever the DB saw first, which is acceptable.
- **Non-participant calls an endpoint** → `403`. Must be checked; the call ID alone is not authorization.
- **Client dies without reporting** → handled by Iterations 8 and 9. Do not attempt to solve it here.
- **Accept arriving after ring timeout already marked it missed** → `missed` is terminal, so it returns `409`. The client must handle this and show "Call ended" rather than joining a dead call.

### Testing procedure
1. Full happy path: initiate → accept → end. Verify `status`, `answeredAt`, `endedAt`, and a sane `durationSeconds`.
2. Initiate → reject → status `rejected`, `rejectedBy` populated.
3. Initiate → cancel by initiator → `cancelled`.
4. Cancel attempted by the callee → `403`.
5. Accept twice → both `200`, exactly one state change.
6. End an already-ended call → `409`.
7. Third-party user hits `/end` → `403`.
8. Block a user mid-call → both clients are dropped within seconds; record is `ended` with reason `blocked`.

### Expected result
Every call reaches a correct terminal status with accurate timing, and illegal transitions are impossible.

### Completion criteria
- [ ] Transition table is data, enforced in one place
- [ ] All transitions idempotent and atomic
- [ ] Participant authorization enforced on all four endpoints
- [ ] `durationSeconds` accurate to within a second
- [ ] Mid-call block terminates the live call

---

# Iteration 8 — Stream webhook ingestion

### Goal
Receive Stream's authoritative call events so the record self-heals when a client dies, loses network, or never reports. This is what makes call history trustworthy.

### Prerequisites
- Iterations 1–7.
- A publicly reachable backend URL (production, or ngrok/Cloudflare Tunnel for local development).

### Implementation steps
1. Create `call-webhook.controller.ts` with `POST /calls/webhook`, marked `@Public()` — Stream cannot present a Boostra JWT.
2. **Verify every request.** Stream signs with an `X-Signature` header (HMAC-SHA256 over the raw body using the API secret). Use `client.verifyWebhook(rawBody, signature)`. Reject unverified requests with `401` and log them at warn level.
3. **You need the raw body.** NestJS's JSON parser consumes it. Register a `rawBody`-preserving configuration in `main.ts` scoped to this route only, or enable `NestFactory.create(AppModule, { rawBody: true })`. Verifying against a re-serialised body will fail intermittently and confusingly.
4. Handle these events:
   | Stream event | Effect |
   |---|---|
   | `call.accepted` | → `active` |
   | `call.rejected` | → `rejected` |
   | `call.ended` | → `ended` |
   | `call.session_participant_left` | if no participants remain → `ended` |
   | `call.missed` | → `missed` |
   | others | log at debug, ack, ignore |
5. Route every event through `applyTransition()` from Iteration 7. The idempotency built there is what makes duplicate webhook delivery harmless.
6. **Always return `200` quickly**, even for events you ignore or cannot map. A non-2xx triggers Stream's retry and can cascade. Do the work synchronously only if it is fast; otherwise enqueue to Bull and ack immediately.
7. Honour `STREAM_WEBHOOK_ENABLED` — if false, verify the signature, log, and ack without mutating. Useful for staging environments pointed at a shared Stream app.
8. Exempt the route from `ThrottlerGuard` — Stream can legitimately burst.
9. Configure the endpoint URL in the Stream dashboard.

### Files / modules affected
- `src/modules/call/call-webhook.controller.ts` *(new)*
- `src/main.ts` (raw body)
- `src/modules/call/call.service.ts`
- `src/modules/call/call.module.ts`
- Stream Dashboard (webhook URL)

### API / event flow
```
Stream ──POST /calls/webhook { type: "call.ended", call_cid, ... }──> backend
           X-Signature: <hmac-sha256>
                              │
                    verifyWebhook(rawBody, sig) ──> 401 if invalid
                              │
                    map event -> CallStatus
                              │
                    applyTransition()  (idempotent, atomic)
                              │
Stream <────────────────── 200 OK ────────────────────────────────────┘
```

### Error and edge-case handling
- **Invalid signature** → `401` and a warn log. Never process. A public endpoint that mutates call state on unverified input is a serious vulnerability.
- **Raw body unavailable** → signature verification fails 100% of the time. Verify this in step 3 before debugging anything else.
- **Unknown `call_cid`** (a call created outside this backend) → log and ack `200`. Do not create a record.
- **Out-of-order delivery** — `call.ended` may arrive before `call.accepted`. The transition table rejects the late `accepted` because `ended` is terminal. This is correct; ensure it logs as info, not error.
- **Duplicate delivery** → idempotent no-op.
- **Webhook handler throws** → the global `AllExceptionsFilter` would return `500` and trigger retries. Wrap the handler body in try/catch, log, and return `200`.
- **Local development** → the dashboard needs a public URL. A tunnel is required; note this in the runbook.

### Testing procedure
1. Craft a signed request with a script using the API secret → `200`, state updated.
2. Tamper with one byte of the body → `401`.
3. Send the same valid event three times → one state change, three `200`s.
4. Send `call.ended` then `call.accepted` → second is a logged no-op, both `200`.
5. Send an unknown `call_cid` → `200`, nothing written.
6. Real end-to-end: place a call from two devices, **force-kill the callee mid-call without hanging up** → within Stream's participant timeout the webhook arrives and the record becomes `ended`. This is the scenario the iteration exists for.
7. Set `STREAM_WEBHOOK_ENABLED=false` → `200`, no mutation.

### Expected result
Call records converge on the truth even when clients misbehave.

### Completion criteria
- [ ] Signature verification enforced and tested against a tampered payload
- [ ] Raw body correctly preserved
- [ ] All handled events map to correct transitions
- [ ] Handler never returns non-2xx, even on internal error
- [ ] Kill-the-app-mid-call test produces a correct `ended` record

---

# Iteration 9 — Ring timeout and orphan sweeper

### Goal
Guarantee no call stays `ringing` or `active` forever. Two mechanisms: a precise per-call timeout job, and a periodic sweeper as a safety net.

### Prerequisites
- Iterations 1–7 (8 recommended).
- Existing Bull/Redis setup in `app.module.ts`.

### Implementation steps
1. Register a `call` Bull queue in `CallModule`, following the pattern in `notification.module.ts`.
2. Create `processors/call-timeout.processor.ts` handling a `ring-timeout` job:
   - Reload the call. If it is no longer `ringing`, exit — it was answered or rejected.
   - Otherwise `applyTransition(..., Missed, null, RingTimeout)` and call `StreamVideoService.endCall()` to stop the remote device ringing.
   - Trigger the missed-call notification (Iteration 10).
3. In `CallService.initiate()`, enqueue this job with `delay: CALL_RING_TIMEOUT_SECONDS * 1000` (default **45s** — long enough to reach a phone in a pocket, short enough not to annoy). Use `jobId: callId` so it is deduplicated and cancellable.
4. On accept/reject/cancel, remove the pending job by ID. If removal fails, the processor's status re-check makes it harmless — belt and braces.
5. Add a `@Cron` sweeper (`ScheduleModule` is already global) running every 5 minutes:
   - `ringing` older than `ringTimeout + 60s` → `missed`.
   - `active` with no `endedAt` and `answeredAt` older than **6 hours** → `ended`, reason `network_failure`. Cap duration at the threshold so one stuck record cannot corrupt analytics.
   - Log a warning with counts whenever the sweeper catches anything. A non-zero count means a delivery path is broken; it should be visible, not silent.
6. **Guard against multiple instances.** If the API runs more than one replica, the cron fires on each. Wrap the sweeper in a Redis lock (`SET NX PX 60000`) so only one instance sweeps.

### Files / modules affected
- `src/modules/call/processors/call-timeout.processor.ts` *(new)*
- `src/modules/call/call.service.ts`
- `src/modules/call/call.module.ts`
- `src/config/*` (`CALL_RING_TIMEOUT_SECONDS`)

### API / event flow
```
initiate() ──> Bull job 'ring-timeout' { jobId: callId, delay: 45s }
                        │
        answered? ──yes──> job removed, nothing happens
                  ──no───> processor: status still 'ringing'?
                                 └──> transition to 'missed'
                                 └──> StreamVideoService.endCall()  (stops the ringing)
                                 └──> missed-call notification (Iteration 10)

@Cron every 5m (Redis-locked) ──> sweep stuck 'ringing' and 'active' records
```

### Error and edge-case handling
- **Race: answered exactly at timeout** → the processor re-reads status and the transition is atomic, so the answered state wins. Never rely on job cancellation alone.
- **Redis down** → jobs are not enqueued. The cron sweeper is the fallback, which is precisely why both exist. Log enqueue failures loudly.
- **Job removal fails** → harmless, per the status re-check.
- **Multiple API replicas** → the Redis lock prevents duplicate sweeps.
- **Clock skew between instances** → all timestamps come from MongoDB/Node on the same infrastructure; avoid mixing in client-supplied times.
- **Timeout too short** → 45s is a starting point. Make it configurable and tune it against real missed-call data.

### Testing procedure
1. Set `CALL_RING_TIMEOUT_SECONDS=10`. Initiate and do not answer → after ~10s the record is `missed` and the callee device **stops ringing**.
2. Initiate and answer at ~8s → stays `active`, no missed transition, job removed from Bull.
3. Manually insert a `ringing` record with `ringStartedAt` two hours ago → the next sweep marks it `missed`.
4. Insert an `active` record with `answeredAt` eight hours ago → swept to `ended`, duration capped.
5. Run two API instances → the sweep log appears once per interval, not twice.
6. Stop Redis, initiate a call → enqueue failure is logged; the sweeper still resolves the call.

### Expected result
No call remains in a non-terminal status for longer than the sweep interval.

### Completion criteria
- [ ] Unanswered calls become `missed` at the configured timeout and stop ringing the device
- [ ] Answering at the boundary never produces a false `missed`
- [ ] Sweeper resolves orphaned `ringing` and `active` records
- [ ] Sweeper is single-flight across replicas
- [ ] Sweeper catch counts are logged as warnings

---

# Iteration 10 — Call history, chat integration, and missed-call notifications

### Goal
Surface calls in the product: a history list, call events inside the chat thread, and a missed-call notification in the existing notification feed.

### Prerequisites
- Iterations 1–9.
- Familiarity with `chat.service.ts`, `chat.gateway.ts`, and `notification.service.ts`.

### Implementation steps
1. **History endpoint** — `GET /calls?page=&limit=&conversationId=`:
   - Uses the existing `PaginationDto` from `src/common/dto`.
   - Filters on `{ participants: userId }`, sorted `createdAt: -1`.
   - Populates the *other* participant's `id`, `name`, `image` only. Never return the full user document.
   - Adds a computed `direction: 'incoming' | 'outgoing'` per row, relative to the requester — the client should not have to derive this.
   - Uses the `{ participants: 1, createdAt: -1 }` index from Iteration 2. Verify with `.explain()`.
   - Accepts an optional `status` filter (`GET /calls?status=active`), which frontend Iteration 12's crash-rejoin check relies on.
2. **Chat thread integration** — a call in a conversation should appear in the message list:
   - Add a `callEvent` message type to the message schema (`type: 'call'`, plus `callId`, `callStatus`, `durationSeconds` in metadata). Extend the existing enum; do not create a parallel collection.
   - On any terminal transition where `conversationId` is set, write this system message via `ChatService` and emit it over the **existing** `chat.gateway.ts` `user_${id}` rooms, so open threads update live with no new socket work.
   - Update `conversation.lastMessage` so the conversation list shows "Missed call" / "Call · 4:12".
3. **Missed-call notification:**
   - On transition to `missed` or `rejected`-by-timeout, call `NotificationService.notify()` with a new `NotificationType.MissedCall`.
   - Deep link via the existing `metadata` mechanism to the conversation, matching the `scheme: 'boostra'` convention.
   - **Only notify the callee.** The caller already knows.
   - Suppress if the callee rejected deliberately — a rejection is not a missed call.
4. Add `NotificationType.MissedCall` to `notification.constants.ts`.

### Files / modules affected
- `src/modules/call/call.controller.ts`, `call.service.ts`
- `src/modules/chat/chat.service.ts`
- `src/database/schemas/chat/message.schema.ts`
- `src/modules/notification/notification.constants.ts`
- `src/modules/notification/notification.service.ts` (consumer only)

### API / event flow
```
Call reaches terminal status
        │
        ├──> if conversationId: ChatService writes a 'call' system message
        │         └──> chat.gateway emits to user_<a> and user_<b>  (existing rooms)
        │         └──> conversation.lastMessage updated
        │
        └──> if missed: NotificationService.notify(callee, MissedCall)
                  └──> Bull queue ──> FCM  (existing path, unchanged)

Client ──GET /calls?page=1──> paginated history with direction + other participant
```

### Error and edge-case handling
- **Call with no `conversationId`** (started from a profile) → skip the chat message, still notify. Optionally create the conversation; treat that as a product decision, not a default.
- **Chat message write fails** → log and continue. A failed system message must never roll back a correct call record.
- **Deleted participant** → history must render with a placeholder, not `500`. Guard the populate.
- **Notification spam** — repeated missed calls from the same caller → collapse within a short window (e.g. one notification per caller per 15 minutes). The existing notification module should be checked for a dedup mechanism before adding one.
- **Rejected ≠ missed** → do not notify on deliberate rejection.
- **History leaking other users' calls** → always filter by `participants: userId` server-side. Never accept a user ID from the query string.

### Testing procedure
1. Complete several calls of each status, then `GET /calls` → correct order, correct `direction`, correct duration, other participant populated.
2. Request page 2 with `limit=2` → pagination metadata correct, no overlap.
3. User C requests history → sees none of A and B's calls.
4. Call started from a chat thread → a call message appears in that thread, live, without a refresh; conversation list preview updates.
5. Unanswered call → callee receives a push and an in-app notification; caller receives neither.
6. Deliberately rejected call → no missed-call notification.
7. `.explain()` the history query → `IXSCAN`, not `COLLSCAN`.

### Expected result
Calls are visible in history and in chat, and missed calls notify the right person exactly once.

### Completion criteria
- [ ] History paginated, index-backed, and scoped to the requester
- [ ] `direction` computed server-side
- [ ] Call events appear live in the chat thread over the existing gateway
- [ ] Missed-call notifications fire for the callee only, and not on rejection
- [ ] No cross-user data leakage

---

# Iteration 11 — Abuse controls, rate limiting, and observability

### Goal
Make the feature safe to expose to real users and debuggable when it misbehaves.

### Prerequisites
- Iterations 1–10.

### Implementation steps
1. **Per-caller rate limit** beyond the global `ThrottlerGuard`:
   - Redis counter keyed `call:rate:<userId>` with a one-hour sliding window, capped at `CALL_MAX_PER_HOUR` (default 30).
   - Exceeded → `429 CALL_RATE_LIMITED`.
   - Enforce inside `CallService.initiate()`, not just as a controller decorator, so every initiation path is covered.
2. **Repeat-rejection backoff** — a caller rejected 3 times by the same callee within an hour is blocked from calling that user for an hour. This is the highest-signal harassment pattern in 1:1 calling. Redis key `call:reject:<callerId>:<calleeId>`.
3. **Moderation surface** — extend the admin module:
   - `GET /admin/calls` — filter by user, status, date range.
   - `POST /admin/calls/:id/terminate` — force-end a live call via `StreamVideoService.endCall()`.
   - A `callingRestricted` flag on the user, honoured by `CallAuthorizationService` (Iteration 4 reserved the `CALLING_RESTRICTED` code for this).
4. **Call-quality telemetry** — accept an optional client-reported stats payload at call end (`mos`, `packetLoss`, `jitter`, `reconnectCount`) into `Call.metadata`. Validate and clamp the values; it is untrusted client input. This is what lets you answer "was the call actually bad, or is the user mistaken?"
5. **Structured logging** — one log line per lifecycle transition with a consistent shape: `callId`, `from`, `to`, `actor`, `reason`, `durationMs`. Use the existing `Logger`, not `console`.
6. **Metrics** worth exposing on the health/metrics surface:
   - Calls initiated / answered / missed / failed per hour
   - **Answer rate** — the single best indicator that push delivery has broken
   - p50/p95 ring-to-answer latency
   - Sweeper catch count (should hover near zero)
7. **Alert** if the hourly answer rate drops below a floor (e.g. 40%). A dead VoIP certificate looks exactly like this and is otherwise invisible.

### Files / modules affected
- `src/modules/call/call.service.ts`, `call-authorization.service.ts`
- `src/modules/admin/*`
- `src/database/schemas/user/user.schema.ts` (`callingRestricted`)
- `src/modules/health/*`

### API / event flow
```
initiate() ──> rate window check   ──> 429 if exceeded
          ──> reject-backoff check ──> 403 if backed off
          ──> [existing Iteration 5 flow]

call end ──> POST /calls/:id/stats { mos, packetLoss, jitter } ──> validated, clamped, stored

@Cron hourly ──> compute answer rate ──> alert if below floor
```

### Error and edge-case handling
- **Redis unavailable** → **fail open** on rate limiting. A Redis outage must not take calling down entirely; log loudly instead. This is the opposite of the choice made for the initiation lock in Iteration 5, and deliberately so: there, failing open risks duplicate calls; here, failing closed risks a full outage.
- **Legitimate high-volume caller** → 30/hour is generous for 1:1; revisit with real data.
- **Malicious stats payload** → validate and clamp every field. Never store raw client numbers unbounded.
- **Admin terminate on an already-ended call** → idempotent no-op via the Iteration 7 transition table.
- **Metrics query cost** → aggregate over an indexed `createdAt` range; do not scan the collection.

### Testing procedure
1. Initiate 31 calls in an hour → the 31st returns `429`.
2. Have B reject A three times → A's fourth attempt returns `403`; verify it expires after an hour.
3. Set `callingRestricted` on a user → all their initiations return `403 CALLING_RESTRICTED`.
4. Admin terminate on a live call → both clients drop within seconds.
5. Post malformed stats (negative loss, `mos: 9999`) → clamped or rejected, never stored raw.
6. Stop Redis, initiate a call → succeeds, with a warning logged.
7. Inspect logs after a full call → one line per transition, all fields present.

### Expected result
Calling is rate limited, moderatable, and instrumented well enough to diagnose problems from logs alone.

### Completion criteria
- [ ] Rate limit and reject-backoff enforced and tested
- [ ] Admin can list and terminate calls, and restrict a user's calling
- [ ] Rate limiting fails open on Redis outage; the lock in Iteration 5 still fails closed
- [ ] Every transition produces one structured log line
- [ ] Answer-rate metric exposed and alerting configured

---

# Iteration 12 — Callee capability, call privacy, and user-owned call data

### Goal
Close the gaps between "calls work" and "a complete calling product" that the mockups do not show but users will hit on day one: do not ring people whose app cannot answer, let users decide who can call them, let them manage their own history and missed-call badge, and let them report a call.

### Prerequisites
- Iterations 1–11.
- Familiarity with `moderation.controller.ts` (`POST /moderation/reports`, `POST /moderation/block/:userId`) and `report.schema.ts`.

### Implementation steps
1. **Calling capability — do not ring old app builds.** Boostra is live, so when calling launches most users will be on a build with no Stream client. A call to them rings nowhere and silently becomes `missed`, which the caller reads as being ignored.
   - Add `callingCapableAt?: Date` to `user.schema.ts`.
   - Set it in `POST /calls/token` (only a calling-capable build ever calls that endpoint). Write at most once per 24h per user — compare before updating, so token refreshes do not become a write per request.
   - In `CallService.initiate()`, **after** `assertCanCall()` and **before** the busy check: callee without `callingCapableAt` → `409 CALLEE_UNSUPPORTED`. No record, no Stream call. Running it after authorization means a blocked caller still gets the generic response and learns nothing.
2. **"Who can call me" — a per-user setting.** Iteration 4's `CALL_POLICY` is an app-wide rule; users need their own control.
   - Add `callPrivacy: 'everyone' | 'mutual_follows' | 'nobody'` to `user.schema.ts`, default `'mutual_follows'` (identical to the Iteration 4 policy, so existing behaviour does not change for anyone who never opens the setting).
   - `GET /calls/settings` → `{ callPrivacy }`; `PATCH /calls/settings` with a validated DTO. Keep these in the call module rather than widening `users.controller.ts`.
   - In `CallAuthorizationService`, after the block check: `nobody` → `CALLS_NOT_ACCEPTED`; `mutual_follows` → the existing mutual-follow check (`NOT_CONNECTED`); `everyone` → skip the relationship check. Self-call, block, ban and `callingRestricted` checks still apply to everyone.
3. **Pre-flight check — `GET /calls/can-call/:userId`.** Returns `{ allowed: boolean, code?: string }` by running the same `assertCanCall()` + capability + busy logic *without* creating anything. This lets the client disable or hide the call button with the right reason instead of letting the user tap and fail (frontend Iteration 14). Blocked and unavailable must still return the identical `USER_UNAVAILABLE`. Throttle it; it is called on every chat and profile view.
4. **User-owned history — hide, never delete.**
   - Add `hiddenFor: ObjectId[]` to `call.schema.ts` (additive; no migration needed).
   - `DELETE /calls/:id` → `$addToSet: { hiddenFor: userId }`, participant only, idempotent.
   - `DELETE /calls` → the same via `updateMany` over every call the user participates in ("Clear call history").
   - Add `hiddenFor: { $ne: userId }` to the Iteration 10 history query. The other participant's history and all analytics are untouched, which is why this is a flag and not a delete.
5. **Missed-call badge.**
   - Add `callsSeenAt?: Date` to `user.schema.ts`.
   - `GET /calls/unseen-count` → count of calls where the user is a participant but not the initiator, `status: missed`, `createdAt > callsSeenAt`, and not hidden. Served by the existing `{ participants: 1, createdAt: -1 }` index.
   - `POST /calls/seen` → sets `callsSeenAt = now`.
6. **Report a call.**
   - Add `CALL = 'call'` to `ReportContentType` in `report.schema.ts`. The existing `POST /moderation/reports` then accepts `{ contentType: 'call', contentId: <call _id>, reason }`.
   - In `ModerationService.createReport()`, for `call` reports verify the reporter was a participant (`403` otherwise), and store the *other* participant as the reported user so the admin queue groups it with that user's other reports.
   - The admin report view shows call metadata — participants, type, start, duration, end reason. There is no media to show (no recording, by design).
   - "Report and block" is the existing `POST /moderation/block/:userId`, which already terminates a live call via Iteration 7.
7. **Post-call feedback.** Extend the Iteration 11 `POST /calls/:id/stats` payload with optional `rating: 1–5` and `issues: ('audio' | 'video' | 'dropped' | 'echo' | 'other')[]`. Store per-user under `metadata.feedback.<userId>`. Add "share of rated calls ≤ 2" to the Iteration 11 metrics — it catches quality regressions that packet stats miss.
8. **Call-back data on missed-call notifications.** Include `callerId`, `callType`, and `conversationId` in the Iteration 10 `MissedCall` notification metadata, so the app can offer a "Call back" action straight from the notification (frontend Iteration 14).

### Files / modules affected
- `src/database/schemas/user/user.schema.ts` (`callingCapableAt`, `callPrivacy`, `callsSeenAt`)
- `src/database/schemas/call/call.schema.ts` (`hiddenFor`)
- `src/database/schemas/report/report.schema.ts` (`ReportContentType.CALL`)
- `src/modules/call/call.controller.ts`, `call.service.ts`, `call-authorization.service.ts`, `call.constants.ts`
- `src/modules/call/dto/update-call-settings.dto.ts` *(new)*
- `src/modules/moderation/moderation.service.ts`
- `src/modules/notification/*` (metadata only)

### API / event flow
```
POST /calls/token ──> callingCapableAt = now   (at most once per 24h)

GET /calls/can-call/:userId ──> assertCanCall + capability + busy ──> { allowed, code }
POST /calls ──> assertCanCall (incl. callPrivacy) ──> capability ──> 409 CALLEE_UNSUPPORTED
                                                               └──> [Iteration 5 flow]

GET|PATCH /calls/settings          { callPrivacy }
DELETE /calls/:id | DELETE /calls  ──> hiddenFor += me
GET /calls/unseen-count            ──> missed since callsSeenAt
POST /calls/seen                   ──> callsSeenAt = now

POST /moderation/reports { contentType: 'call', contentId } ──> participant check ──> report
POST /calls/:id/stats { ..., rating, issues }               ──> metadata.feedback.<me>
```

### Error and edge-case handling
- **Callee reinstalled an old build after using calling** → `callingCapableAt` is already set, so they ring and time out as `missed`. Rare and self-correcting. If it matters later, have the client send an `X-App-Version` header and compare against a minimum version.
- **Callee switches to `nobody` mid-call** → does not end the live call; it applies to new calls only.
- **`CALLS_NOT_ACCEPTED` versus block leakage** → a blocked caller must always get `USER_UNAVAILABLE`, even when the callee's privacy is `nobody`. Keep the block check *before* the privacy check.
- **`can-call` result goes stale** → it is advisory only. `POST /calls` re-runs every check, and the client must handle its codes too.
- **Report on a call the reporter was not in** → `403`. The call ID alone is not authorization.
- **Hiding a live call** → allowed. It only affects that user's list.
- **Unseen count after "Clear call history"** → hidden calls are excluded from the count, so the badge clears as well.

### Testing procedure
1. User who has never fetched a token → calling them returns `409 CALLEE_UNSUPPORTED`; nothing is written to Mongo or Stream.
2. Fetch a token as that user → the next call rings normally. Fetch 10 tokens in a row → `callingCapableAt` is written once.
3. `callPrivacy: nobody` → `403 CALLS_NOT_ACCEPTED`. `everyone` + no relationship → allowed. `mutual_follows` → the Iteration 4 behaviour.
4. Callee has blocked caller *and* set `nobody` → the caller gets `USER_UNAVAILABLE`, not `CALLS_NOT_ACCEPTED`.
5. `can-call` matches the `POST /calls` outcome for every case above.
6. `DELETE /calls/:id` → gone from my history, still in the other user's history.
7. Two missed calls → `unseen-count` = 2; `POST /calls/seen` → 0; one more missed call → 1.
8. Report a call as a participant → report created; as a third party → `403`.
9. Stats with `rating: 9` → rejected or clamped, never stored raw.
10. Missed-call notification payload includes `callerId`, `callType`, `conversationId`.

### Expected result
Calls only ring people who can answer, users control who can reach them, and history, badges and reporting behave the way users expect from a calling app.

### Completion criteria
- [ ] Old-build callees return `CALLEE_UNSUPPORTED` instead of timing out
- [ ] `callPrivacy` enforced, defaulting to today's policy
- [ ] Block state never leaks through the privacy or capability responses
- [ ] `can-call` agrees with `POST /calls` in every tested case
- [ ] History hide/clear is per user and non-destructive
- [ ] Missed-call unseen count correct and index-backed
- [ ] Calls reportable by participants only
- [ ] Missed-call notification carries call-back data

---

# Iteration 13 — Production hardening and launch readiness

### Goal
Close the gap between "works on my machine with two test accounts" and "safe to put in front of users."

### Prerequisites
- Iterations 1–12 complete and verified.

### Implementation steps
1. **Environment separation** — a **separate Stream app** for staging and production. A shared app means staging test calls ring real users' phones. Non-negotiable.
2. **Secret handling** — `STREAM_API_SECRET` into the deployment platform's secret store. Audit git history (`git log -p --all -S 'STREAM_API_SECRET'`); if it was ever committed, rotate it in the dashboard, do not merely delete the line.
3. **Feature flag** — `CALLING_ENABLED`. Every call endpoint returns `503` when off. Ship the code dark, enable for internal accounts, then roll out. This is the cheapest insurance available.
4. **Load sanity check** — at 50–100 users you will not stress Stream. Do verify that your *own* endpoints hold: 50 concurrent `POST /calls/token` should not saturate the instance. Token generation is local HMAC and should be sub-millisecond; if it is not, something is wrong.
5. **Cost monitoring** — a weekly job summing `durationSeconds × 2` (participant-minutes) against the Maker allowance. Alert at 70%. The Maker Account has hard limits rather than overage billing, so hitting the ceiling means **calls stop working**, not a surprise invoice. That failure mode must be caught early.
6. **Runbook** in `boost-backend/docs/video-calling-runbook.md`:
   - "Calls do not ring on iOS" → already covered in `docs/video-calling-push-runbook.md`; link it rather than duplicating.
   - "Calls ring but do not connect" → Stream status page, client network, TURN reachability.
   - "Call records stuck active" → check webhook delivery in the dashboard, then the sweeper logs.
   - Certificate rotation procedure and expiry dates.
   - Stream dashboard access and who holds it.
7. **Data retention** — decide how long call records live. Recommendation: indefinite for metadata (it is small and analytically useful), with a documented GDPR deletion path that removes the user's calls when the account is deleted. Wire this into the existing account-deletion flow.
8. **Account deletion** — ensure deleting a Boostra user also deletes them from Stream (`client.deleteUsers`). Currently nothing does this; it is a real compliance gap.
9. **Final security review** — run the existing `/security-review` over the diff. Pay particular attention to the webhook controller, the only `@Public()` mutating endpoint in the feature.

### Files / modules affected
- Deployment configuration / secret store
- `src/config/*` (`CALLING_ENABLED`)
- `src/modules/call/*` (flag enforcement)
- `src/modules/users/*` (deletion → Stream)
- `boost-backend/docs/video-calling-runbook.md` *(new)*

### API / event flow
```
Any /calls/* request ──> CALLING_ENABLED false? ──> 503 CALLING_DISABLED
                                            true  ──> normal flow

Weekly @Cron ──> sum(durationSeconds) * 2 ──> participant-minutes
                          └──> >70% of allowance? ──> alert

User deletion ──> existing cascade
                     └──> StreamVideoService.deleteUser()
```

### Error and edge-case handling
- **Flag flipped off mid-call** → in-flight calls continue (Stream holds the session); only new initiations are blocked. Confirm this is the intended behaviour and document it.
- **Staging pointed at the production Stream app** → assert at boot that the app ID matches the expected value for `NODE_ENV`, and refuse to start on mismatch. Do not rely on discipline.
- **Maker allowance exhausted** → calls fail. The 70% alert plus a documented upgrade path is the mitigation.
- **Secret rotation** → tokens signed with the old secret become invalid immediately. Clients must refetch. Verify the frontend's 401-retry path (frontend Iteration 3) handles this before rotating in production.
- **Stream outage** → calling is unavailable and this is not recoverable in-app. Ensure the client degrades gracefully to chat rather than appearing broken.

### Testing procedure
1. Set `CALLING_ENABLED=false` → every call endpoint returns `503`; the rest of the app is unaffected.
2. Point staging at the production app ID → boot refuses with a clear message.
3. Delete a test user → they disappear from the Stream dashboard and their call records are handled per the retention policy.
4. Rotate the secret in the dashboard, restart → old client tokens are rejected, clients refetch and recover without a reinstall.
5. `git log -p --all -S 'STREAM_API_SECRET'` → no hits.
6. 50 concurrent token requests → all `200`, p95 well within normal response budget.
7. Run the cost job against seeded data → correct participant-minute total.
8. Full end-to-end on two physical devices against the **staging** Stream app: call, answer, talk 30s, hang up. Verify history, chat message, and record.

### Expected result
The feature can be enabled for real users with a rollback switch, a runbook, and cost visibility.

### Completion criteria
- [ ] Separate Stream apps for staging and production, enforced at boot
- [ ] Secret in a secret store, absent from git history
- [ ] `CALLING_ENABLED` flag verified in both positions
- [ ] Account deletion removes the Stream user
- [ ] Cost monitoring live with a 70% alert
- [ ] Runbook written and reviewed by someone who did not build the feature
- [ ] Security review passed, with the webhook endpoint specifically examined

---

## Dependency graph

```
1 (foundation)
├── 2 (schema)
│   ├── 3 (token) ──┐
│   └── 4 (authz) ──┤
│                   └── 5 (initiate)
│                        ├── 6 (push credentials)   <- calls ring on locked devices
│                        ├── 7 (lifecycle)
│                        │    ├── 8 (webhooks)
│                        │    └── 9 (timeouts)
│                        │         └── 10 (history, chat, notifications)
│                        │              └── 11 (abuse, observability)
│                        │                   └── 12 (capability, privacy, user-owned data)
│                        │                        └── 13 (hardening)
```

**Minimum viable ringing call:** Iterations 1 → 2 → 3 → 4 → 5 → 6.
**Minimum trustworthy call records:** add 7 → 8 → 9.
**Minimum shippable:** all thirteen.

## Deliberate non-goals

Recorded so they are not re-litigated mid-build:

- **No custom WebRTC signaling.** Stream owns it. `chat.gateway.ts` is untouched.
- **No group calls.** The schema's `participants` array leaves room, but no iteration implements it.
- **No call recording.** It carries consent and legal obligations that belong in their own project.
- **No self-hosted fallback.** If SDK cost ever justifies it, the migration target is self-hosted LiveKit, which would replace Iterations 1, 3, 5, and 6 while leaving 2, 4, 7, and 9–12 substantially intact. That is the reason those iterations are written against `CallService` rather than against Stream's API directly.
