# Live Streaming — Backend Implementation Roadmap

**Target repo:** `boost-backend` (NestJS 11, Mongoose 8, Redis/ioredis, Bull, Socket.IO, firebase-admin)
**Provider:** Stream Video (`@stream-io/node-sdk`) — **the same app, key, and client as Video Calling**
**Scope:** 1-to-many live video broadcast with live chat, reactions, and coin gifting
**Companion document:** `../frontend/IMPLEMENTATION_ROADMAP.md`
**Assumes:** `../../VideoCalling/backend/IMPLEMENTATION_ROADMAP.md` Iterations 1–3 are complete

---

## How to use this document

Each iteration is **independently executable**. Implement one, test it, verify the completion criteria, commit, and only then start the next.

Iterations 1–5 produce a watchable live stream. Iterations 6–8 add the interaction layer from the mockups (chat, hearts, gifts). Iterations 9–10 make it safe to launch.

---

## What is reused, and what is new

Livestreaming is **not** a second integration. It reuses the Stream app, API key, secret, token endpoint, and client that Video Calling already established. If you have not built Video Calling yet, you must still complete its Iterations 1–3 first — they are the shared foundation, not calling-specific work.

| Concern | Source |
|---|---|
| Stream credentials, `StreamVideoService` | Video Calling Iteration 1 — reused as-is |
| User token minting (`POST /calls/token`) | Video Calling Iteration 3 — **generalised** in Iteration 1 below |
| SFU, WebRTC transport, viewer distribution | Stream |
| **Stream lifecycle (backstage → live → ended)** | **Us** |
| **Who may broadcast, who may watch** | **Us** |
| **Live chat fan-out** | **Us** — existing `chat.gateway.ts`, extended |
| **Reactions / hearts** | **Us** |
| **Gifting economics** | **Us** — existing `coins`, `wallet`, `transaction` modules |
| **Live content moderation** | **Us** |

### Module layout to be created

```
src/modules/livestream/
  livestream.module.ts
  livestream.controller.ts
  livestream.service.ts
  livestream-authorization.service.ts
  livestream.gateway.ts          # chat/reactions, separate namespace
  livestream-gift.service.ts
  livestream.constants.ts
  dto/
  processors/
    livestream-cleanup.processor.ts

src/database/schemas/livestream/
  livestream.schema.ts
  livestream-gift.schema.ts
```

### Environment variables introduced

| Variable | Iteration | Purpose |
|---|---|---|
| `LIVESTREAM_ENABLED` | 1 | Feature flag |
| `LIVESTREAM_MAX_DURATION_MINUTES` | 10 | Hard cap, default `240` |
| `LIVESTREAM_CHAT_RATE_PER_MINUTE` | 6 | Per-viewer message cap, default `20` |
| `LIVESTREAM_MIN_GIFT_COINS` | 8 | Default `10` |
| `LIVESTREAM_GIFT_REVENUE_SHARE` | 8 | Creator share, default `0.7` |

---

# Iteration 1 — Generalise the Stream foundation

### Goal
Rename and widen the calling-specific Stream plumbing so livestreaming shares it rather than duplicating it. No new user-facing behaviour, and **no regression in calling**.

### Prerequisites
- **Video Calling backend Iterations 1–3** complete (`StreamVideoService`, token endpoint).

### Implementation steps
1. **Move `StreamVideoService`** out of `src/modules/call/` into `src/common/services/stream/stream.service.ts`, exported from a `StreamModule`. Both `CallModule` and `LivestreamModule` import it. One client instance serves both features.
2. **Generalise the token endpoint.** `POST /calls/token` becomes `POST /stream/token`, returning the same payload. Keep `POST /calls/token` as a thin alias for one release so a deployed client is not broken by a backend deploy — order-of-deploy safety matters more than tidiness here.
3. Add livestream methods to `StreamService`:
   - `createLivestreamCall(id, hostId, data)` — uses the **`livestream` call type**, not `default`. The `livestream` type has backstage enabled and the host/viewer permission split built in. Do not reuse `default`.
   - `goLive(id)`, `stopLive(id)`, `endCall(id)`
   - `getCallStats(id)` for viewer counts.
4. Verify in the Stream dashboard that the `livestream` call type exists and that its default permissions grant `send-video`/`send-audio` to the host role only.
5. Add `LIVESTREAM_ENABLED` to `src/config`, defaulting **off**.
6. Create `LivestreamModule` with only the service wired, and register it in `app.module.ts` after `CallModule`.

### Files / modules affected
- `src/common/services/stream/stream.service.ts` *(moved)*
- `src/common/services/stream/stream.module.ts` *(new)*
- `src/modules/call/*` (imports updated)
- `src/modules/livestream/livestream.module.ts` *(new)*
- `src/app.module.ts`, `src/config/*`

### API / event flow
```
POST /stream/token ──> same payload as before { apiKey, token, userId, push }
POST /calls/token  ──> alias, deprecated, removed one release later
```

### Error and edge-case handling
- **Calling regression** — this iteration touches working code. Every calling test from the Video Calling roadmap must still pass. Treat that as the primary acceptance criterion, not a side check.
- **Deploy ordering** — a backend that drops `/calls/token` before clients update breaks calling in production. The alias exists for exactly this; do not skip it.
- **Two client instances** — if `StreamModule` is not a singleton, calls and livestreams could each open a connection. Verify one instance in the DI container.
- **`livestream` call type missing** in the dashboard → create it before writing code against it.

### Testing procedure
1. Run the full existing calling test suite → all pass.
2. Place a real 1:1 call end to end → unaffected.
3. `POST /stream/token` → valid token.
4. `POST /calls/token` → identical payload.
5. Log the client instance identity from both modules → same object.
6. Confirm the `livestream` call type and its role permissions in the dashboard.

### Expected result
One Stream foundation serving both features, with calling untouched.

### Completion criteria
- [ ] `StreamService` shared, single instance, verified
- [ ] Both token routes work; the old one is marked deprecated in code
- [ ] All calling tests and a manual call still pass
- [ ] `livestream` call type verified in the dashboard
- [ ] `LIVESTREAM_ENABLED` defaults off

---

# Iteration 2 — Livestream persistence schema

### Goal
Define the durable record of a stream: its lifecycle, its metrics, and enough denormalised data to render a discovery feed without joins.

### Prerequisites
- Iteration 1.

### Implementation steps
1. Create `src/database/schemas/livestream/livestream.schema.ts`, following `chat/conversation.schema.ts` conventions (`timestamps: true`, `mongoose-paginate-v2`, explicit indexes).
2. Fields:
   - `streamCallId: string` — unique, indexed. `livestream:<uuid>`.
   - `host: ObjectId (ref User)` — required, indexed.
   - `title?: string`, `thumbnailUrl?: string`
   - `status: LivestreamStatus` — indexed.
   - `backstageAt: Date`, `startedAt?: Date`, `endedAt?: Date`
   - `durationSeconds?: number`
   - `peakViewerCount: number` (default 0), `currentViewerCount: number` (default 0)
   - `totalUniqueViewers: number` (default 0)
   - `totalMessages: number`, `totalReactions: number`, `totalGiftCoins: number` — all default 0
   - `endedReason?: LivestreamEndReason`
   - `hostSnapshot: { name, avatar }` — denormalised so the discovery feed needs no populate.
3. `livestream.constants.ts`:
   ```ts
   export enum LivestreamStatus {
     Backstage = 'backstage',  // created, host setting up, not visible
     Live      = 'live',       // broadcasting, discoverable
     Ended     = 'ended',
     Failed    = 'failed',
     Terminated = 'terminated', // ended by moderation
   }

   export enum LivestreamEndReason {
     HostEnded       = 'host_ended',
     HostDisconnected = 'host_disconnected',
     MaxDuration     = 'max_duration',
     ModeratorAction = 'moderator_action',
     Failed          = 'failed',
   }
   ```
4. Indexes:
   - `{ status: 1, startedAt: -1 }` — **the discovery query.** Most important index in the feature.
   - `{ host: 1, createdAt: -1 }` — a host's past streams.
   - `{ streamCallId: 1 }` unique.
   - `{ status: 1, backstageAt: 1 }` — the orphan sweeper in Iteration 10.
5. Export from `src/database/schemas/index.ts`, register in `LivestreamModule`.

### Files / modules affected
- `src/database/schemas/livestream/livestream.schema.ts` *(new)*
- `src/database/schemas/index.ts`
- `src/modules/livestream/livestream.constants.ts` *(new)*
- `src/modules/livestream/livestream.module.ts`

### API / event flow
None. Data layer only.

### Error and edge-case handling
- **Counters as source of truth** — `currentViewerCount` in Mongo will drift. Treat it as a *cached* value refreshed from Stream and Redis; never as authoritative. `peakViewerCount` is the durable, meaningful number.
- **Write amplification** — updating `currentViewerCount` on every join/leave writes to Mongo constantly. Iteration 4 keeps the live counter in **Redis** and flushes to Mongo periodically. The schema field exists for the final snapshot and the feed, not for real-time.
- **Stream that never ends** → swept in Iteration 10; the `{ status, backstageAt }` index exists for it.
- **Host deleted** → `hostSnapshot` means the feed still renders. That is its purpose.

### Testing procedure
1. Create a document with required fields → succeeds.
2. Omit `host` → validation error.
3. Duplicate `streamCallId` → duplicate key error.
4. `db.livestreams.getIndexes()` → all four present.
5. Seed 1,000 documents, run the discovery query, `.explain()` → `IXSCAN` on `{ status, startedAt }`.

### Expected result
A `livestreams` collection with correct indexes and a feed query that is index-backed from day one.

### Completion criteria
- [ ] Schema compiles, registers, no Mongoose warnings
- [ ] All four indexes verified in MongoDB
- [ ] Discovery query verified `IXSCAN` against seeded data
- [ ] `hostSnapshot` denormalised
- [ ] Enums are the single source of truth for status

---

# Iteration 3 — Host lifecycle: create, go live, end

### Goal
Let an authorised user create a stream, set up backstage, go live, and end. After this iteration a host can broadcast; nobody can watch yet.

### Prerequisites
- Iterations 1–2.

### Implementation steps
1. Create `livestream-authorization.service.ts` → `assertCanBroadcast(userId)`:
   - User exists, is active, email-verified.
   - Not banned, not `streamingRestricted` (a new user flag, mirroring `callingRestricted`).
   - **Eligibility policy** — a product decision; implement behind a named constant. Recommended default for launch: **allow-list or minimum follower count**, not open to all. Live video is the highest-risk content type you will ever ship; opening it to every new signup on day one is how platforms get into trouble.
   - Not already hosting a live stream.
2. `livestream.service.ts`:
   - `async create(hostId, dto)` — authorize, generate a UUIDv4, persist with `status: Backstage`, create the Stream call with the `livestream` type in backstage mode. Persist before calling Stream; mark `Failed` if Stream errors.
   - `async goLive(streamId, hostId)` — host only. `Backstage → Live`, sets `startedAt`, calls `StreamService.goLive()`. This is the moment the stream becomes discoverable.
   - `async end(streamId, actorId, reason)` — `Live|Backstage → Ended`, sets `endedAt` and `durationSeconds`, calls `StreamService.endCall()`.
3. Endpoints, all `JwtAuthGuard`-protected:
   - `POST /livestreams` — create (backstage)
   - `POST /livestreams/:id/go-live`
   - `POST /livestreams/:id/end`
   - `GET /livestreams/:id` — detail
4. Transition table in `livestream.constants.ts`, enforced in one place, atomic via `findOneAndUpdate` with the current status in the filter — the same pattern as the calling lifecycle.
5. Redis lock around create, so a double-tap cannot produce two streams for one host.

### Files / modules affected
- `src/modules/livestream/livestream.service.ts` *(new)*
- `src/modules/livestream/livestream-authorization.service.ts` *(new)*
- `src/modules/livestream/livestream.controller.ts` *(new)*
- `src/modules/livestream/dto/*` *(new)*
- `src/database/schemas/user/user.schema.ts` (`streamingRestricted`)

### API / event flow
```
Host ──POST /livestreams { title }──> assertCanBroadcast()
                                        │
                              Redis lock (host id)
                              persist (status: backstage)
                              StreamService.createLivestreamCall()  [backstage]
                                        │
Host <──── { streamId, streamCallId, status: 'backstage' } ─────────┘

Host sets up camera (frontend), then:
Host ──POST /livestreams/:id/go-live──> backstage -> live, startedAt set
                                         StreamService.goLive()
                                         └──> stream becomes discoverable

Host ──POST /livestreams/:id/end──> live -> ended, duration computed
                                      StreamService.endCall() ──> all viewers dropped
```

### Error and edge-case handling
- **Not eligible to broadcast** → `403` with a specific code so the client can explain *why* (follower threshold vs restricted vs unverified).
- **Already hosting** → `409`. One live stream per host; this is a hard invariant.
- **`go-live` by a non-host** → `403`. Check ownership, not just authentication.
- **`go-live` on an ended stream** → `409` via the transition table.
- **Stream creation fails at Stream** → record `Failed`, return `502`, never leave a phantom `backstage` record.
- **Host abandons backstage** → swept in Iteration 10. Backstage streams are invisible, so this is low-severity but must not accumulate.
- **`end` called twice** → idempotent success.

### Testing procedure
1. Eligible host `POST /livestreams` → `201`, `backstage` in Mongo, call visible in the Stream dashboard in backstage.
2. Ineligible user → `403` with the correct code.
3. `go-live` → status `live`, `startedAt` set.
4. `go-live` from another user's account → `403`.
5. Second `POST /livestreams` from the same host while live → `409`.
6. `end` → `ended`, `durationSeconds` accurate.
7. `end` twice → both `200`, one state change.
8. Two concurrent creates → exactly one `201`.
9. Break the Stream key → `502`, record `failed`.

### Expected result
A host can run the full backstage → live → ended lifecycle with correct records.

### Completion criteria
- [ ] Full lifecycle works and is recorded accurately
- [ ] One-live-stream-per-host enforced under concurrency
- [ ] Ownership checked on `go-live` and `end`
- [ ] Eligibility policy is a named, flippable constant
- [ ] Stream failure never leaves a phantom record

---

# Iteration 4 — Viewer join, leave, and live viewer counts

### Goal
Let viewers watch, and produce the viewer-count pill from the mockups (`153,123` / `2.5k`) accurately and cheaply.

### Prerequisites
- Iterations 1–3.

### Implementation steps
1. `assertCanWatch(viewerId, stream)` in the authorization service:
   - Stream is `live`.
   - Viewer is not blocked by the host, and has not blocked the host — reuse the same block source as `chat.service.ts` and the calling module. A third divergent block check would be a moderation hole.
   - Viewer is not banned.
2. `POST /livestreams/:id/join` → authorize, then return `{ streamCallId, hostSnapshot, viewerCount, isFollowingHost }`. The client already holds a Stream token from `POST /stream/token`; this endpoint grants *application* permission and returns render data, it does not mint a second token.
3. **Viewer counting in Redis, not Mongo:**
   - `SADD livestream:<id>:viewers <userId>` on join, `SREM` on leave.
   - `SCARD` for the current count.
   - **TTL on the set** (e.g. 6 hours) so an abandoned stream cannot leak keys forever.
   - Track `totalUniqueViewers` with a separate set that is not removed from.
4. **Flush to Mongo every 30 seconds** via a lightweight interval, updating `currentViewerCount` and raising `peakViewerCount`. Never write to Mongo per join/leave — a stream with 500 viewers churning would hammer the database for a number nobody needs to be exact.
5. `POST /livestreams/:id/leave` — best-effort; clients will not always call it.
6. **Reconcile against Stream.** Clients crash without leaving. Every 60 seconds, for each live stream, fetch the real participant count from `StreamService.getCallStats()` and correct Redis. Stream's count is authoritative; yours is a cache.
7. `GET /livestreams/:id/viewers` — paginated viewer list for the host, if the design calls for it.

### Files / modules affected
- `src/modules/livestream/livestream.service.ts`
- `src/modules/livestream/livestream-authorization.service.ts`
- `src/modules/livestream/livestream.controller.ts`
- `src/modules/redis/redis.service.ts` (set helpers if absent)

### API / event flow
```
Viewer ──POST /livestreams/:id/join──> assertCanWatch()
                                         SADD viewers:<id>
                                         SADD unique:<id>
                                         └──> { streamCallId, host, viewerCount }
                                                │
                                    Client joins the Stream call directly (WebRTC)

Every 30s ──> SCARD ──> flush currentViewerCount + peakViewerCount to Mongo
Every 60s ──> StreamService.getCallStats() ──> reconcile Redis against Stream
Stream ends ──> final flush ──> DEL redis keys
```

### Error and edge-case handling
- **Stream not live** → `409 STREAM_NOT_LIVE`. A viewer holding a stale feed entry hits this constantly; it must be a clean, cheap response, not an error path.
- **Blocked viewer** → `403`, with copy indistinguishable from "unavailable", consistent with the calling module.
- **Redis down** → **fail open on viewing.** Serve the stream, report the viewer count as unknown rather than zero, log loudly. A Redis blip must not black out every live stream. Contrast with Iteration 3's create lock, which fails closed.
- **Viewer never calls leave** → the 60-second reconciliation corrects it. This is the normal case, not the exception.
- **Count drift** → accept it. Display is rounded (`2.5k`) precisely because exactness is neither achievable nor valuable.
- **Multiple API replicas** → Redis is shared, so counting is already correct across replicas. The flush interval must be single-flight via a Redis lock, or replicas will fight over `peakViewerCount`.
- **Key leak** → TTL on every stream key. Verify with `redis-cli --scan` after a test stream ends.

### Testing procedure
1. Host goes live, viewer joins → `200`, count is 1.
2. Five viewers join → count 5; `peakViewerCount` reaches 5 in Mongo within 30s.
3. Two leave → count 3; peak stays 5.
4. Kill a viewer client without calling leave → count corrects within 60s.
5. Join a `backstage` stream → `409`.
6. Blocked viewer joins → `403`, neutral message.
7. Stop Redis, join → succeeds, count unknown, warning logged.
8. Run two API replicas → one flush per interval, peak not corrupted.
9. End the stream → Redis keys removed; verify with `--scan`.
10. Load test: 200 simulated joins → no Mongo write storm (verify with profiler).

### Expected result
Accurate-enough live viewer counts at negligible database cost.

### Completion criteria
- [ ] Viewers can join and watch a live stream
- [ ] Counting lives in Redis; Mongo writes are periodic, not per-event
- [ ] Reconciliation against Stream corrects crashed clients within 60s
- [ ] Redis outage degrades the count, never the stream
- [ ] All Redis keys TTL'd and cleaned on end
- [ ] Flush is single-flight across replicas

---

# Iteration 5 — Discovery and go-live notifications

### Goal
Let users find live streams, and tell followers when someone they follow goes live. Without this, streams have no audience.

### Prerequisites
- Iterations 1–4.
- Existing `follows` and `notification` modules.

### Implementation steps
1. `GET /livestreams?page=&limit=` — the live-now feed:
   - Filter `{ status: 'live' }`, sort `startedAt: -1`.
   - Return `hostSnapshot`, `title`, `thumbnailUrl`, `currentViewerCount`, `startedAt`, `isFollowingHost`.
   - Uses the `{ status: 1, startedAt: -1 }` index from Iteration 2. Verify with `.explain()`.
   - **Exclude streams hosted by users the requester has blocked, or who have blocked them.** Doing this in the query is far cheaper than filtering after pagination — and filtering after pagination silently returns short pages, which looks like a bug.
2. `GET /livestreams/following` — live streams from followed hosts only. This is the higher-value surface; most users care about who they follow, not a global firehose.
3. **Go-live notification**, on the `Backstage → Live` transition:
   - Fan out to the host's followers via the existing `NotificationService`.
   - New `NotificationType.HostWentLive`.
   - Deep link to the stream via the existing `metadata` + `boostra` scheme convention.
   - **Enqueue to Bull; never fan out synchronously.** A host with 10,000 followers would otherwise block the `go-live` request. Reuse the existing notification queue.
4. **Throttle the fan-out** — at most one go-live notification per host per **6 hours**, regardless of how many times they start and stop. A host toggling live repeatedly must not be able to notification-spam their followers. Redis key with TTL.
5. Chunk the follower fan-out (e.g. 500 per job) so one host cannot monopolise the queue.
6. Optional but cheap: emit a `hostWentLive` event over the existing `chat.gateway.ts` `user_<id>` rooms, so users with the app open see the feed update without polling.

### Files / modules affected
- `src/modules/livestream/livestream.service.ts`, `livestream.controller.ts`
- `src/modules/notification/notification.constants.ts`
- `src/modules/follows/*` (follower query, reused)

### API / event flow
```
GET /livestreams           ──> live now, blocked hosts excluded in-query
GET /livestreams/following ──> live now, restricted to followed hosts

go-live ──> throttle check (Redis, 6h per host)
              └──> enqueue fan-out job (chunks of 500)
                     └──> NotificationService ──> FCM  (existing path)
              └──> chat.gateway emits 'hostWentLive' to online followers
```

### Error and edge-case handling
- **Notification spam** — the single biggest risk in this iteration. The 6-hour throttle is not optional; a host who goes live, ends, and restarts five times must send one notification, not five.
- **Very large follower counts** → chunked jobs. At your scale this is theoretical, but the fix costs nothing now and is painful to retrofit.
- **Blocked hosts in the feed** → filter in-query, before pagination.
- **Stream ends between feed fetch and tap** → the join endpoint returns `409 STREAM_NOT_LIVE`; the client refreshes. Expected, not exceptional.
- **Empty feed** → return an empty array with correct pagination metadata, never `404`.
- **Notification fan-out fails mid-way** → Bull retries per the existing `defaultJobOptions`. Partial delivery is acceptable; duplicate delivery to the same user is not, so make the job idempotent per recipient.

### Testing procedure
1. Two live streams → both appear in `GET /livestreams`, newest first.
2. `.explain()` the feed query → `IXSCAN`.
3. Block a host → their stream is absent, and the page is still full-length.
4. `GET /livestreams/following` → only followed hosts.
5. Host with 3 followers goes live → all 3 receive a push; the host does not.
6. Host ends and goes live again immediately → **no second notification**.
7. Wait past the throttle window, go live → notification sends.
8. Seed a host with 2,000 followers → fan-out chunks, queue stays responsive.
9. End a stream, then fetch the feed → absent.

### Expected result
Streams are discoverable and followers are notified once, not repeatedly.

### Completion criteria
- [ ] Both feeds paginated and index-backed
- [ ] Blocked hosts excluded in-query
- [ ] Go-live notifications fan out asynchronously in chunks
- [ ] 6-hour per-host throttle verified
- [ ] Fan-out idempotent per recipient

---

# Iteration 6 — Live chat

### Goal
Deliver the chat overlay from both mockup panels. This iteration contains **a blocker that must be fixed first**.

### Prerequisites
- Iterations 1–5.

### ⚠️ Blocking prerequisite: Socket.IO Redis adapter

[`chat.gateway.ts`](../../../src/modules/chat/chat.gateway.ts) tracks connections in an **in-memory `Map`** (`private connectedUsers: Map<string, string>`), and the backend has **no `@socket.io/redis-adapter` dependency**. With more than one API replica, `server.to(room).emit()` only reaches sockets on the emitting instance.

For 1:1 chat this is an intermittent bug. For a livestream room with hundreds of viewers spread across replicas it is a guaranteed one: **most of the room silently misses every message.** Fix it before building on top of it.

1. `npm i @socket.io/redis-adapter` (ioredis is already present).
2. Wire the adapter in a custom `IoAdapter` in `main.ts`, using the existing Redis connection settings from `app.module.ts`.
3. Verify with two local instances that a message emitted on instance A reaches a socket on instance B.
4. This also fixes the latent cross-instance bug in existing 1:1 chat — verify that path still works.

### Implementation steps
1. Create `livestream.gateway.ts` on its **own namespace** (`/livestream`), not inside `/chat`. Separate namespaces mean livestream traffic volume cannot degrade 1:1 chat, and the two can be scaled or disabled independently.
2. Authenticate on connection using the exact JWT pattern from `chat.gateway.ts` — same token sources, same failure handling. Do not invent a second auth path.
3. Events:
   - `joinStream { streamId }` → authorize via `assertCanWatch`, `client.join('stream_' + streamId)`
   - `leaveStream { streamId }`
   - `sendStreamMessage { streamId, text }` → validate, rate limit, broadcast `streamMessage` to the room
   - Server → client: `streamMessage`, `viewerCount`, `streamEnded`
4. **Do not persist every message.** A busy stream generates thousands of messages with no lasting value. Keep the **last 50 in a Redis list** (`LPUSH` + `LTRIM`) so a late-joining viewer sees recent context — exactly what the mockup overlay shows — and let the rest be ephemeral. Increment the `totalMessages` counter on the stream record for analytics.
5. **Rate limit per viewer:** `LIVESTREAM_CHAT_RATE_PER_MINUTE` (default 20) via a Redis counter. Exceeded → emit `messageError` to that socket only, never to the room.
6. Validate message length (e.g. 200 chars) and reject empty or whitespace-only messages.
7. Run messages through the existing `moderation` module's text filter if one exists; if not, note it as a gap for Iteration 9.
8. Broadcast `viewerCount` to the room on a 5-second interval rather than on every join/leave — at 500 viewers, per-event broadcasting is a self-inflicted denial of service.

### Files / modules affected
- `src/modules/livestream/livestream.gateway.ts` *(new)*
- `src/main.ts` (Redis adapter)
- `package.json` (`@socket.io/redis-adapter`)
- `src/modules/livestream/livestream.module.ts`

### API / event flow
```
Viewer socket ──connect /livestream (JWT in handshake)──> authenticated
              ──joinStream { streamId }──> assertCanWatch ──> join room stream_<id>
                                             └──> last 50 messages replayed from Redis

sendStreamMessage ──> rate limit (Redis, per viewer per minute)
                  ──> validate length, non-empty
                  ──> moderation filter
                  ──> LPUSH + LTRIM (keep 50)
                  ──> broadcast 'streamMessage' to stream_<id>  [via Redis adapter, all replicas]

every 5s ──> broadcast 'viewerCount' to the room
stream ends ──> broadcast 'streamEnded' ──> disconnect room
```

### Error and edge-case handling
- **Missing Redis adapter** → the blocking prerequisite above. Verify with two instances before anything else.
- **Rate-limited viewer** → error to that socket only. Broadcasting a rate-limit error to the room would be both noisy and embarrassing.
- **Viewer socket connected but not authorised to watch** → reject the `joinStream`, do not disconnect the socket; they may legitimately be watching a different stream.
- **Blocked viewer** → cannot join the chat room, consistent with `assertCanWatch`.
- **Host ends the stream with viewers connected** → broadcast `streamEnded`, then clear the room. Do not leave sockets in a room for a dead stream.
- **Message flood from one viewer** → rate limit plus a hard per-socket cap; disconnect repeat offenders.
- **Redis down** → chat degrades. Decide explicitly: recommended is to **allow messages but skip history and rate limiting**, log loudly. A stream with no chat is better than no stream.
- **Very long message / unicode abuse** → validate by length and normalise before broadcast.

### Testing procedure
1. **Two backend instances.** Viewer on A, viewer on B, same stream → both receive every message. If this fails, stop; nothing else in this iteration works.
2. Existing 1:1 chat still works after the adapter change — regression gate.
3. Join a live stream → last 50 messages replay immediately.
4. Send 25 messages in a minute → the last 5 are rejected to that socket only.
5. Blocked viewer attempts `joinStream` → rejected, socket stays alive.
6. Host ends the stream → all viewers receive `streamEnded`.
7. 100 simulated viewers, 10 msg/sec → latency stays acceptable, no memory growth.
8. Stop Redis → messages still broadcast; history and rate limiting degrade with warnings.
9. Empty and 500-character messages → rejected.

### Expected result
Live chat works correctly across replicas, with bounded storage and cost.

### Completion criteria
- [ ] **Redis adapter installed and verified across two instances**
- [ ] Existing 1:1 chat verified unbroken
- [ ] Livestream chat on its own namespace
- [ ] Last-50 history in Redis; messages not persisted to Mongo
- [ ] Per-viewer rate limiting, errors scoped to the offending socket
- [ ] Viewer count broadcast on an interval, not per event

---

# Iteration 7 — Reactions (hearts)

### Goal
The heart button in both mockups. High-volume, ephemeral, and a genuine performance trap if built naively.

### Prerequisites
- Iterations 1–6.

### Implementation steps
1. Add `sendReaction { streamId, type }` to the livestream gateway. Start with a single type (`heart`); the enum leaves room for more.
2. **Do not broadcast one event per tap.** Users tap hearts continuously; at 200 viewers this is thousands of events per second and will melt the gateway.
   - **Aggregate in Redis:** `INCRBY livestream:<id>:reactions <n>`.
   - **Broadcast the delta on a 1-second interval:** `{ type: 'heart', count: N }`.
   - The client animates `N` hearts locally. Visually identical, three orders of magnitude cheaper.
3. Per-viewer rate limit (e.g. 10 reactions/second) to cap a single abusive client.
4. Flush the total to `Livestream.totalReactions` on the same 30-second cycle as viewer counts, and finally on stream end.
5. TTL the reaction key, and delete it on stream end.

### Files / modules affected
- `src/modules/livestream/livestream.gateway.ts`
- `src/modules/livestream/livestream.service.ts`
- `src/modules/livestream/livestream.constants.ts`

### API / event flow
```
Viewer taps heart (xN) ──> sendReaction ──> rate limit ──> INCRBY reactions:<id>

every 1s ──> read + reset delta ──> broadcast { type: 'heart', count: N } to the room
                                      └──> each client animates N hearts locally

every 30s ──> flush total to Livestream.totalReactions
stream end ──> final flush ──> DEL key
```

### Error and edge-case handling
- **Per-tap broadcast** → the trap this iteration exists to avoid. Aggregate, always.
- **Huge burst** (a viral moment) → cap the broadcast count per interval (e.g. 100) so the client is not asked to animate 5,000 hearts and drop frames. The true total still accrues in the counter.
- **Redis down** → drop reactions silently. They are decorative; degrading them must never surface an error to the user.
- **Reaction spam by one viewer** → rate limited per socket.
- **Reactions to a non-live stream** → ignore silently.
- **Counter overflow** → Redis integers are 64-bit; not a practical concern.

### Testing procedure
1. Tap the heart 20 times in a second → the room receives ~1 aggregated event, not 20.
2. 100 viewers tapping continuously → gateway CPU stays flat; broadcast rate stays at ~1/sec.
3. Verify `totalReactions` on the stream record after a test stream is approximately correct.
4. Exceed the per-viewer rate limit → excess is dropped, no error broadcast.
5. Stop Redis → reactions silently no-op, stream and chat unaffected.
6. Burst of 10,000 in one interval → the broadcast is capped; the stored total is accurate.
7. End the stream → reaction key removed.

### Expected result
Hearts feel instant and cost almost nothing.

### Completion criteria
- [ ] Reactions aggregated and broadcast on an interval, never per tap
- [ ] Burst cap on the broadcast count
- [ ] Totals flushed to the stream record
- [ ] Redis outage degrades silently
- [ ] Verified flat gateway CPU under 100 concurrent tappers

---

# Iteration 8 — Gifting

### Goal
Let viewers send coin gifts to a host, with correct, auditable, non-losable economics. This iteration handles real money and deserves the most care in this roadmap.

### Prerequisites
- Iterations 1–7.
- Existing `coins`, `wallet`, `transaction`, and `payout` modules.

### A design decision you must make first

Your existing model, from [`coin-transaction.schema.ts`](../../../src/database/schemas/coin/coin-transaction.schema.ts) and `MONETIZATION_SETUP.md`:

- **Coins** are a *spending* currency bought via IAP. `1 coin = £0.01` (`COINS_PER_GBP=100`). Types today: `PURCHASE`, `SPEND`, `REFUND`, `ADMIN_ADJUST`.
- **Creator earnings** are separate — watch rewards in £, withdrawn via Stripe Connect. Explicitly documented as unrelated to coins.

Gifting crosses that boundary, so decide explicitly:

| Option | Sender | Host receives | Notes |
|---|---|---|---|
| **A — Recommended** | spends coins | **£ creator earnings** (existing wallet, Stripe payout path) | Consistent with the current model; host cashes out through machinery that already exists |
| B | spends coins | **coins** | Simpler, but creates cashable-by-proxy coins and a currency-laundering path Apple may object to |

**Take option A.** It reuses your payout rails and keeps the currency boundary intact. Apply `LIVESTREAM_GIFT_REVENUE_SHARE` (default `0.7`) — the host's share after your platform cut, which must also absorb Apple/Google's 15–30% on the original coin purchase. Model this before picking the number: at a 30% store cut and a 70% creator share, your net is negative if you are not careful.

### Implementation steps
1. Create `livestream-gift.schema.ts`: `livestream`, `sender`, `host`, `giftType`, `coins`, `hostEarningsGbp`, `platformFeeGbp`, `createdAt`. Index `{ livestream: 1, createdAt: -1 }` and `{ host: 1, createdAt: -1 }`.
2. Add `GIFT_SENT` to `CoinTxnType` — extend the existing enum rather than creating a parallel ledger. The coin ledger must remain the single source of truth for coin balance.
3. Define a gift catalogue in `livestream.constants.ts` (name, coin cost, icon key). Server-side only; **never trust a client-supplied price**.
4. `livestream-gift.service.ts` → `sendGift(senderId, streamId, giftKey)`:
   1. Stream is `live`; sender is not the host (no self-gifting).
   2. Resolve the gift from the server-side catalogue.
   3. **Atomically** debit coins: conditional update on `coinBalance >= cost`. Insufficient → `402`.
   4. Write a `CoinTransaction` of type `GIFT_SENT` with `balanceAfter`.
   5. Credit host earnings via the existing wallet/transaction service.
   6. Persist the `LivestreamGift`.
   7. Increment `totalGiftCoins`.
   8. Broadcast a `giftReceived` event to the stream room for the on-screen animation.
5. **Transactional integrity is the whole point.** The debit and the credit must not diverge. Use a **MongoDB transaction** (your Mongoose 8 + replica-set setup supports it) around steps 3–7. If a transaction is unavailable, implement a compensating reversal and a reconciliation job — but prefer the transaction.
6. Idempotency key per gift send, so a retried request cannot double-charge.
7. `POST /livestreams/:id/gifts` and `GET /livestreams/:id/gifts` (host view, paginated).
8. Rate limit gift sends per viewer to bound accidental double-taps and abuse.

### Files / modules affected
- `src/database/schemas/livestream/livestream-gift.schema.ts` *(new)*
- `src/database/schemas/coin/coin-transaction.schema.ts` (`GIFT_SENT`)
- `src/modules/livestream/livestream-gift.service.ts` *(new)*
- `src/modules/coins/coins.service.ts`, `src/modules/wallet/wallet.service.ts`
- `src/modules/livestream/livestream.gateway.ts`

### API / event flow
```
Viewer ──POST /livestreams/:id/gifts { giftKey, idempotencyKey }
            │
     [MongoDB transaction]
       ├── conditional debit: coinBalance >= cost   ──> 402 if not
       ├── CoinTransaction { type: GIFT_SENT, balanceAfter }
       ├── credit host earnings (£, via wallet/transaction service)
       ├── LivestreamGift persisted
       └── Livestream.totalGiftCoins incremented
     [commit]
            │
     broadcast 'giftReceived' to stream_<id> ──> animation on every client
            │
Viewer <──── { newBalance, gift } ────────────────────────────────────┘
```

### Error and edge-case handling
- **Insufficient coins** → `402` with the current balance, so the client can open the purchase sheet immediately. This is the most common path; make it fast and clean.
- **Debit succeeds, credit fails** → **the failure that must never happen.** The transaction prevents it. Verify by forcing a mid-transaction failure in testing and confirming no coins are lost.
- **Double-tap / retry** → idempotency key. A duplicated charge in a gifting feature is a refund request and a trust problem.
- **Client-supplied price** → never trusted. The catalogue is server-side.
- **Self-gifting** → blocked. It is a money-laundering and reward-farming vector.
- **Stream ends mid-transaction** → allow the gift to complete; the host earned it. Do not roll back on stream state.
- **Coin balance race** (two concurrent gifts) → the conditional update makes over-spend impossible.
- **Apple/Google compliance** — coins must be bought through IAP on both platforms. Gifting *spends* already-purchased coins, so it stays compliant. Any path that lets a user buy gifting credit outside IAP on iOS risks removal from the App Store.
- **Refunded IAP** → a user refunds a coin purchase after gifting. Decide the policy and document it; the `storeTransactionId` unique index gives you the hook to detect it.

### Testing procedure
1. Viewer with sufficient coins sends a gift → balance decreases, host earnings increase, both ledger entries written, animation broadcast.
2. Ledger check: sum of all `CoinTransaction.coins` for the user equals their `coinBalance`. Must hold exactly.
3. Insufficient balance → `402`, no writes anywhere.
4. Send the same idempotency key twice → charged once.
5. Force a failure between debit and credit → transaction rolls back, balance unchanged. **The critical test.**
6. Two concurrent gifts that together exceed the balance → exactly one succeeds.
7. Self-gift → `403`.
8. Tampered price in the request body → ignored; the catalogue price is charged.
9. Gift during a stream that ends mid-request → completes correctly.
10. Verify the revenue-share arithmetic against hand calculations, including the store cut.

### Expected result
Gifting is atomic, auditable, and reconciles exactly.

### Completion criteria
- [ ] Debit and credit are atomic; verified by a forced mid-transaction failure
- [ ] Coin ledger reconciles exactly against balances
- [ ] Idempotency prevents double-charging
- [ ] Prices are server-side only
- [ ] Self-gifting blocked
- [ ] Revenue share verified arithmetically, store cut included
- [ ] Concurrent-spend race impossible

---

# Iteration 9 — Live moderation and safety

### Goal
Live video is the highest-risk content you will ship. Unlike a 1:1 call, it is broadcast, and unlike an upload, you cannot review it before it goes out. This iteration is a launch blocker, not a nice-to-have.

### Prerequisites
- Iterations 1–8.
- Existing `moderation` and `admin` modules.

### Implementation steps
1. **Viewer reporting** — `POST /livestreams/:id/report` with a reason. Reuse the existing `report` schema and moderation queue; do not build a parallel system.
2. **Live admin surface:**
   - `GET /admin/livestreams?status=live` — everything currently broadcasting, with viewer counts and report counts.
   - `POST /admin/livestreams/:id/terminate` — immediate kill. Transitions to `Terminated`, calls `StreamService.endCall()`, drops every viewer, notifies the host.
   - `POST /admin/users/:id/streaming-restrict` — sets the `streamingRestricted` flag from Iteration 3.
3. **Auto-escalation** — N unique reports within M minutes (e.g. 3 in 5) flags the stream at the top of the admin queue. At your scale, do **not** auto-terminate; false positives on a legitimate creator are worse than a few minutes of delay. Revisit when you have moderation staff.
4. **Host-side moderation** — the host can mute or kick a viewer from their chat. Store per-stream bans in Redis (keyed to the stream, expiring with it).
5. **Chat filtering** — run messages through the existing moderation text filter. If none exists, this is a gap: a basic blocklist plus a length and repetition check is the minimum. Document whichever you ship.
6. **Recording for incident review** — decide explicitly. Recording every stream costs money and carries privacy obligations; recording none leaves you unable to investigate a report after the fact. Recommended middle path: record only streams that receive a report, using Stream's recording API, retained briefly. Whatever you choose, document it in the privacy policy — this is a legal requirement, not a preference.
7. **Observability:** streams started/ended per hour, peak concurrent viewers, average duration, reports per stream, terminations, gift volume, chat messages per minute. Alert on a report-rate spike.

### Files / modules affected
- `src/modules/livestream/livestream.controller.ts`, `livestream.gateway.ts`
- `src/modules/admin/*`, `src/modules/moderation/*`
- `src/database/schemas/report/report.schema.ts` (livestream target type)
- `src/modules/health/*`

### API / event flow
```
Viewer ──POST /livestreams/:id/report──> existing moderation queue
              └──> 3 unique reports in 5 min ──> flagged, surfaced to admin (no auto-kill)

Admin ──GET /admin/livestreams?status=live──> live dashboard with report counts
Admin ──POST /admin/livestreams/:id/terminate
              └──> status: terminated
              └──> StreamService.endCall() ──> all viewers dropped immediately
              └──> host notified

Host ──kickViewer { userId }──> Redis per-stream ban ──> viewer removed from chat room
```

### Error and edge-case handling
- **Report brigading** → count **unique reporters**, not reports; rate limit reporting per user.
- **Auto-termination false positives** → why auto-terminate is deliberately not implemented.
- **Termination mid-gift** → let the in-flight gift transaction complete; do not corrupt the ledger to kill a stream a few hundred milliseconds sooner.
- **Terminated host restarts immediately** → termination must set `streamingRestricted` or a cooldown, or it achieves nothing.
- **Host kicks everyone** → their prerogative; log it.
- **No text filter exists** → a real gap. Ship at least a blocklist and document the limitation for the launch review.
- **Recording without disclosure** → a legal problem. Privacy policy first, feature second.

### Testing procedure
1. Report a stream → appears in the moderation queue with the correct target type.
2. Three unique reporters in five minutes → flagged in the admin dashboard.
3. Same user reports three times → counts once, then rate limited.
4. Admin terminates → every viewer is dropped within seconds; status `terminated`; host notified.
5. Terminated host tries to go live again → blocked by restriction or cooldown.
6. Host kicks a viewer → removed from chat, cannot rejoin that stream.
7. Send a blocklisted term in chat → filtered.
8. Verify all metrics are populated after a test stream.
9. Trigger the report-rate alert with seeded data.

### Expected result
A live stream can be found, reviewed, and stopped by a human within a minute or two of a report.

### Completion criteria
- [ ] Reporting reuses the existing moderation queue
- [ ] Admin can see all live streams and terminate any of them
- [ ] Termination drops viewers immediately and prevents an instant restart
- [ ] Host-side kick/mute works
- [ ] Chat filtering shipped, or its absence documented as a known gap
- [ ] Recording policy decided **and reflected in the privacy policy**
- [ ] Metrics and report-rate alerting live

---

# Iteration 10 — Lifecycle cleanup, cost control, and launch readiness

### Goal
Guarantee no stream runs forever, no Redis key leaks, cost is visible, and the feature can be switched off.

### Prerequisites
- Iterations 1–9.

### Implementation steps
1. **Stream webhooks** — extend the Video Calling webhook controller (its Iteration 8) to handle livestream events: `call.session_ended`, `call.session_participant_left` for the host. **Host disconnection is the important one:** if the host's client dies, the stream must end rather than persist as a live entry with a black screen. Route through the same signature verification and idempotent transition helper.
2. **Host-disconnect grace period** — do not end instantly on one dropped connection. Allow ~60 seconds for the host to reconnect (a tunnel, a lift, a network handover), then end with `HostDisconnected`. Ending a stream on a momentary blip is worse than a minute of frozen video.
3. **Max duration cap** — a Bull delayed job per stream at `LIVESTREAM_MAX_DURATION_MINUTES` (default 240). Prevents a forgotten stream broadcasting an empty room for days, which is pure cost.
4. **Orphan sweeper** (`@Cron`, every 5 minutes, Redis-locked for single-flight):
   - `backstage` older than 30 minutes → `ended`.
   - `live` with zero viewers **and** no host participant per Stream for 5 minutes → `ended`.
   - `live` past the max duration → `ended`.
   - Log warnings with counts; non-zero means a delivery path is broken.
5. **Redis key hygiene** — on every terminal transition, delete viewers, unique-viewers, reactions, chat history, and ban keys. Every key must also carry a TTL as a backstop. Verify with `redis-cli --scan` after testing.
6. **Cost monitoring** — livestreaming is billed per **participant**-minute, so cost scales with `viewers × duration`, not with stream count. A weekly job should compute `Σ(peakViewerCount × durationMinutes)` as an upper-bound estimate, compare against the Stream Maker allowance shared with calling, and alert at 70%.

   > Note the shared budget: the Maker Account's $100 credit covers **calling and livestreaming together**. Track the combined figure, not each separately.

7. **`LIVESTREAM_ENABLED` flag** — every endpoint and the gateway namespace return/refuse when off. Ship dark, enable for an allow-list, then widen.
8. **Runbook** at `boost-backend/docs/livestreaming-runbook.md`: stuck-live diagnosis, terminating a stream, gift ledger reconciliation, cost-spike response, Redis adapter verification.
9. **Replay / VOD** — explicitly out of scope, but write down the decision. You already have `video`, `video-processing`, and S3 modules, so it is a natural follow-up; leaving it undecided invites scope creep mid-build.

### Files / modules affected
- `src/modules/call/call-webhook.controller.ts` (extended)
- `src/modules/livestream/processors/livestream-cleanup.processor.ts` *(new)*
- `src/modules/livestream/livestream.service.ts`
- `src/config/*`
- `boost-backend/docs/livestreaming-runbook.md` *(new)*

### API / event flow
```
Stream webhook: host participant left
        └──> start 60s grace timer
               ├── host reconnects ──> cancel, stream continues
               └── timer expires ──> end (HostDisconnected), viewers dropped

go-live ──> Bull delayed job at MAX_DURATION ──> force end (MaxDuration)

@Cron 5m (Redis-locked) ──> sweep stale backstage / empty live / overrunning
Terminal transition ──> DEL all stream Redis keys
Weekly @Cron ──> Σ(peakViewers × minutes) + calling minutes ──> alert at 70% of allowance
```

### Error and edge-case handling
- **Host reconnects at second 59** → grace timer must be cancellable and idempotent.
- **Webhook not configured** → streams hang live until the sweeper catches them. The sweeper is the safety net; the webhook is the fast path. Both are required.
- **Sweeper ends a stream with active viewers** → only sweep when Stream reports no host participant. Never sweep on your own cached counts alone.
- **Flag flipped off during a live stream** → let in-flight streams finish; block new ones. Document the behaviour.
- **Cost estimate inaccuracy** → `peakViewerCount × duration` is an upper bound, not a bill. Reconcile against the Stream dashboard monthly; the estimate is for alerting, not accounting.
- **Redis key leak** → verify with `--scan` after every test stream; a leak here grows silently until it matters.
- **Allowance exhausted** → the Maker Account has hard limits, so streams **stop working** rather than generating an invoice. That is why the 70% alert exists.

### Testing procedure
1. Kill the host client mid-stream → grace period, then `ended` with `host_disconnected`; viewers dropped.
2. Kill and reconnect within the grace period → stream continues uninterrupted.
3. Set max duration to 2 minutes → the stream force-ends at 2 minutes.
4. Insert a `backstage` record an hour old → swept.
5. Insert a `live` record with no host participant → swept.
6. Run two replicas → sweep logs appear once per interval.
7. After a full test stream, `redis-cli --scan` → no residual keys.
8. Run the cost job against seeded data → matches hand calculation.
9. `LIVESTREAM_ENABLED=false` → all endpoints refuse, gateway namespace rejects, calling unaffected.
10. Full end-to-end on staging: host goes live, three viewers join, chat, hearts, a gift, host ends → every record, ledger entry, and Redis key correct.

### Expected result
Streams always terminate, resources always free, and cost is visible before it becomes a problem.

### Completion criteria
- [ ] Host disconnect ends the stream after a cancellable grace period
- [ ] Max-duration cap enforced
- [ ] Sweeper resolves every stale state, single-flight across replicas
- [ ] Zero residual Redis keys after a stream ends
- [ ] Combined calling + livestreaming cost monitored with a 70% alert
- [ ] `LIVESTREAM_ENABLED` verified in both positions
- [ ] Runbook written
- [ ] Replay/VOD decision recorded

---

## Dependency graph

```
[Video Calling backend 1-3 — shared foundation]
        │
        1 (generalise Stream foundation)
        └── 2 (schema)
             └── 3 (host lifecycle)
                  └── 4 (viewers + counts)
                       └── 5 (discovery + notifications)
                            ├── 6 (live chat)  <- BLOCKED on @socket.io/redis-adapter
                            │    ├── 7 (reactions)
                            │    └── 8 (gifting)
                            ├── 9 (moderation)   <- launch blocker
                            └── 10 (cleanup + cost + hardening)
```

**Minimum watchable stream:** Iterations 1 → 4.
**Minimum useful product:** add 5 → 6 (the mockups are unrecognisable without chat).
**Minimum shippable:** all ten. Iteration 9 is not optional for live video.

## Deliberate non-goals

- **No replay / VOD.** Decided in Iteration 10; a natural follow-up using the existing `video-processing` and S3 modules.
- **No multi-host / guest invites.** The `livestream` call type supports it; no iteration implements it.
- **No RTMP ingest (OBS / desktop streaming).** Stream supports it at $15/1,000 minutes; mobile-first for now.
- **No HLS delivery.** WebRTC only. HLS is the scale lever for roughly 1,000+ concurrent viewers and is a per-call flag, not a rearchitecture — see the frontend roadmap's non-goals.
- **No paid or ticketed streams.** Gifting only.
