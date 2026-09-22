# Boost Campaigns: Backend Plan

Status: **backend implemented** in `src/modules/boost-campaigns` (phases 1–6). The app side (§11) is wired too: view reporting, live estimates, Boost Now and the dashboard. The app keeps its own option lists (their keys match `/boost/config`) rather than loading them from the server. The open questions in §13 were built using the recommended answer for each, and every one of them is a config value or a small change if you decide differently.

This is the plan for the backend behind the app's new Boost flow (Goal → Audience → Budget → Review). It covers the rules, the data model, how views are counted, how boosted videos reach people, the API, and the build order. The open questions at the end record which defaults were chosen.

---

## 1. What exists today (and why it can't be reused as is)

| Area | Current state | Problem for the new flow |
|---|---|---|
| **View counting** | `VideoService.incrementViewCount()` exists, but **no route or service calls it**. | Every video's `viewCount` stays at `0`. This is why the app shows `👁 0` on every video. |
| **Feed** | `GET /feed/global` sorts by `createdAt` only. `isBoosted` and `boostScore` are stored but never read. The ranked "personalized" feed isn't wired to any route. | **Boosting currently changes nothing about who sees a video.** |
| **Boost records** | One `boosts` collection serves three payment paths: the legacy Stripe €1–100 boost with a reward pool, the IAP product boost, and the coin "promote" at £/day × days. | The fields mean different things per path (`amount` is € in one, £ in another, 0 in a third). There's no place for targeting or delivery stats. |
| **Watch signal** | The app calls `POST /rewards/watch` once per video mount after 10 seconds, for signed-in users only. | This is the only watch event we get. It's tied to the viewer-reward economy, not to view counting. |
| **Coins** | `users.coinBalance`, with an atomic `spendCoins` and `refundCoins` in `CoinsService` and a `coin_transactions` ledger. | ✅ Reusable as is. |
| **Targeting data** | `users.dob` and `users.gender` (`male`/`female`/`other`/`prefer_not_to_say`) are optional and only set from Edit Profile. There is **no location data.** | Age and gender targeting only work for users who filled in their profile. Location targeting is **not offered**: we have no reliable way to know where users are (see §6.4). |
| **Background jobs** | Bull + Redis are already set up (notifications), and `@nestjs/schedule` cron is used (`expireDueBoosts`). | ✅ Reusable. |

**Decision:** build campaigns as a **new `boost_campaigns` collection and module**, and leave the old `boosts` flow alone until the new app version ships (see §10).

---

## 2. Product rules (v1)

These follow the app's current UI.

| Rule | Value |
|---|---|
| Goal | `views` only ("More Video Views") |
| Price | **100–1,000 coins**, in steps of 50. The Low, Balanced and High presets are 100, 500 and 1,000. |
| Duration | 1, 3, 7 or 14 days |
| Audience size | `specific` \| `balanced` \| `wide` (meaning defined in §6.3) |
| Age | `under18` (13–17) \| `above18` (18–55+) \| `40plus` (40–80+) |
| Gender | `all` \| `men` \| `women` \| `others` |
| Campaigns per video | One live campaign at a time |
| What is sold | **Qualified unique views.** A viewer counts at most once per campaign. |

### 2.1 How many views does a campaign buy?

```
VIEWS_PER_COIN   = 4                  (env, tunable)
eligibleAudience = users matching the targeting (see §6.2), excluding the owner
audienceReach    = floor(eligibleAudience × share)   share: specific 20%, balanced 50%, wide 100%
                   (never below 1 when anyone is eligible)
requestedViews   = coins × VIEWS_PER_COIN
finalReach       = min(audienceReach, requestedViews)   → the campaign's targetViews
coinsCharged     = ceil(finalReach / VIEWS_PER_COIN)
```

The formulas live in `src/modules/boost-campaigns/boost-reach.ts`.

Because a viewer counts once per campaign, **you cannot deliver more unique views than there are eligible people.** With 80 active users, a 500-coin boost (2,000 wanted views) can deliver at most 80. So:

- The estimate endpoint returns the real `eligibleAudience` and the *useful* coin maximum. The app can then show honest numbers instead of the static "1,500 – 5,000" ranges.
- If the user still submits more coins than are useful, we only charge `coinsCharged` and say so in the response.

### 2.2 Fair billing

Coins are **reserved up front** (spent via `spendCoins`) and **settled at the end**:

```
refund = coinsCharged − ceil(deliveredViews / VIEWS_PER_COIN)
```

This applies when a campaign expires short of its target or is cancelled. A campaign that hits its target completes early with no refund. The owner never pays for views that weren't delivered.

At `COINS_PER_GBP = 100`, 500 coins is £5.

---

## 3. Data model

### 3.1 `boost_campaigns` (new)

```ts
BoostCampaign {
  _id
  user: ObjectId → User            // owner
  video: ObjectId → Video
  goal: 'views'

  targeting: {
    audienceSize: 'specific' | 'balanced' | 'wide'
    age: 'under18' | 'above18' | '40plus'
    gender: 'all' | 'men' | 'women' | 'others'
  }

  // Money
  coinsRequested: number            // what the user picked
  coinsCharged: number              // what was actually reserved (§2.1)
  coinsRefunded: number             // settled at the end, default 0
  viewsPerCoin: number              // snapshot of VIEWS_PER_COIN at purchase

  // Delivery
  targetViews: number
  deliveredViews: number            // qualified unique views (§4)
  impressions: number               // times the video was served in a boost slot
  uniqueReach: number               // distinct viewers served at least once
  engagements: { likes, comments, follows }   // from attributed viewers during the campaign
  eligibleAudienceAtStart: number   // snapshot, for reporting

  // Lifecycle
  status: 'active' | 'paused' | 'completed' | 'expired' | 'cancelled'
  durationDays: 1 | 3 | 7 | 14
  startAt: Date
  endAt: Date
  endedAt?: Date
  endReason?: 'target_reached' | 'time_up' | 'cancelled_by_user' | 'video_removed'

  // Ledger link: coin_transactions rows carry ref "boost_campaign:<_id>"
  idempotencyKey: string            // from the Idempotency-Key header

  createdAt, updatedAt
}
```

**Indexes**
- `{ status: 1, endAt: 1 }`: expiry job
- `{ video: 1 }`, unique partial where `status ∈ {active, paused}`: one live campaign per video
- `{ user: 1, createdAt: -1 }`: dashboard list
- `{ user: 1, idempotencyKey: 1 }`, unique: double-tap protection on "Boost Now"

### 3.2 `boost_impressions` (new)

One row per viewer per campaign, updated on each serve. It's used for frequency caps and to prove a view came from the boost.

```ts
BoostImpression {
  campaign: ObjectId, viewer: ObjectId, video: ObjectId
  firstServedAt: Date, lastServedAt: Date
  servesToday: number, servesDay: string   // 'YYYY-MM-DD'; reset when the day changes
  totalServes: number
}
```
- Unique `{ campaign: 1, viewer: 1 }`
- TTL on `lastServedAt` (30 days), since the campaign keeps its own totals

### 3.3 `boost_views` (new)

One row per **qualified** view attributed to a campaign. The unique index is what enforces "counts once".

```ts
BoostView {
  campaign: ObjectId, viewer: ObjectId, video: ObjectId
  watchSeconds: number
  createdAt: Date
}
```
- Unique `{ campaign: 1, viewer: 1 }`: a duplicate insert throws `E11000` and is ignored

### 3.4 Changes to existing schemas

| Schema | Change | Why |
|---|---|---|
| `User` | `lastActiveAt?: Date`, indexed | "Eligible audience" should mean people who actually open the app. Set it at most once per hour from the auth guard, throttled with Redis. |
| `Video` | Keep `isBoosted` and add `activeCampaign?: ObjectId` | Boosted badge in the UI, plus quick lookup. |
| `CoinTransaction` | No schema change: the SPEND and REFUND rows use `ref: "boost_campaign:<id>"` | Links the ledger to campaigns. The campaign id is created before the spend so the ledger row can reference it. |

### 3.5 Config (`src/modules/boost-campaigns/boost-campaigns.config.ts`)

```ts
COINS_MIN = 100; COINS_MAX = 1000; COINS_STEP = 50
TIERS = { low: 100, balanced: 500, high: 1000 }
DURATIONS = [1, 3, 7, 14]
VIEWS_PER_COIN = env(4)
QUALIFIED_VIEW_SECONDS = 3            // or 50% of a video shorter than 6s
MAX_SERVES_PER_VIEWER_PER_DAY = 3     // per campaign
MIN_MINUTES_BETWEEN_SERVES = 10       // stops the same boost repeating page after page
BOOST_SLOT_EVERY = 5                  // one boosted item per 5 feed items
ACTIVE_WINDOW_DAYS = 30               // "eligible" = opened the app in this window
AUDIENCE_SHARE = { specific: 0.2, balanced: 0.5, wide: 1 }
```

---

## 4. How views are tracked

There are **two separate counters**, and we fix both.

### 4.1 General `viewCount` (fixes the "0 views" bug)

New endpoint: **`POST /videos/:id/views`**, body `{ watchSeconds, campaignId? }`.

- **Client:** the app calls it once per video mount when playback crosses `QUALIFIED_VIEW_SECONDS` (3s). This goes in `FeedPostItem`'s existing `timeUpdate` handler, next to the reward call.
- **Server:** deduplicate with Redis: `SET view:{videoId}:{viewerId|deviceId} 1 NX EX 86400`. If the key was set, run `$inc: { viewCount: 1, watchTimeTotal: watchSeconds }` on the video. So each viewer adds at most one view per video per 24 hours.
- **Guests:** allowed. Send an `X-Device-Id` header (a random UUID stored on the device) as the dedupe key.
- Owners viewing their own video don't count.

### 4.2 Campaign `deliveredViews` (what the user paid for)

The server looks up the video's live boost itself, so a view counts **wherever it was watched**: the home card feed, a boost slot, a profile or full screen. The client doesn't need to send `campaignId`; it's still accepted for older builds. A view counts toward the boost **only if all of these hold**:

1. The viewer is signed in. Guests can't be deduplicated reliably, so they add to `viewCount` but not to delivery.
2. The video has an `active` boost and `now < endAt`.
3. The viewer isn't the owner, matches the boost's audience (age and gender, §6), and there's no block either way.
4. `watchSeconds` is between 3 and `video.duration + 5`, which rejects impossible values.
5. Inserting into `boost_views` succeeds. A duplicate means the viewer was already counted.

A viewer reached outside a boost slot is added to `boost_impressions` so they appear in `uniqueReach`.

> An earlier version only counted views that came from a boost slot, as proof of delivery. With a tiny catalogue, every boosted video also shows in the normal feed, so people watched it there and the view counted toward the video but not the boost. That was confusing, so any qualified view now counts.

Then, atomically:

```
BoostCampaign.findOneAndUpdate(
  { _id, status: 'active', deliveredViews: { $lt: targetViews } },
  { $inc: { deliveredViews: 1 } }, { new: true })
```

If `deliveredViews === targetViews`, the campaign completes with `endReason: 'target_reached'` (§7).

**Anti-abuse:** a Redis rate limit of at most 30 view reports per viewer per minute. Anything above is ignored silently, not rejected.

### 4.3 Engagement (dashboard "Engagements")

When a like, comment or follow happens, check whether the actor has a `boost_impressions` row for an active campaign on that video (or for that creator, in the follow case). If so, `$inc` the matching `engagements.*` field. This hooks into `LikesService`, `CommentsService` and `FollowsService`, the same places the notification triggers live.

---

## 5. How boosted videos get delivered

Delivery happens inside **`FeedService.getGlobalFeed`** ("For You"). The Following feed stays organic.

For each page request by a signed-in viewer:

1. Build the organic page as today.
2. Load **candidate campaigns**: active, not the viewer's own, viewer not blocked either way, targeting matches the viewer (§6.2), no `boost_views` row for the viewer yet, and `servesToday < MAX_SERVES_PER_VIEWER_PER_DAY`.
   - The list of active campaigns is small, so it's cached in Redis for 60s (`boost:active`). The per-viewer filters run against it in memory, with one `boost_views` lookup and one `boost_impressions` lookup per page.
3. **Order by pacing**: the campaign furthest behind schedule goes first.
   ```
   expected = targetViews × elapsed / duration
   behind   = expected − deliveredViews        // larger = more urgent
   ```
4. Put one campaign into every `BOOST_SLOT_EVERY`-th position (positions 4, 9, 14, …). Remove the same video from the organic part of the page so it doesn't appear twice.
5. For each injected item, upsert `boost_impressions`: bump `servesToday` and `totalServes`, set `firstServedAt` if it's new, and add to the campaign's `impressions` and `uniqueReach`.
6. Mark the item in the response:
   ```json
   { "...video fields", "isBoosted": true, "boost": { "campaignId": "…" } }
   ```
   The app sends `campaignId` back in `POST /videos/:id/views`.

**Guests** get boosted items too, which is free exposure, but no impression row is written and their views don't count toward delivery.

---

## 6. Targeting

### 6.1 Viewer attributes

- **Age bucket:** from `user.dob`. `under18` is 13–17, `above18` is 18 and over, `40plus` is 40 and over. The buckets overlap on purpose, to match the UI.
- **Gender:** `male` matches `men`, `female` matches `women`, and `other` or `prefer_not_to_say` match `others`. `all` matches everyone.

### 6.2 Matching and missing data

Most users have no `dob` or `gender` yet, so *missing data always matches*, at every audience size. A user without a `dob` matches any age filter. Otherwise, with today's data, nearly every targeted campaign would have an eligible audience of zero.

`eligibleAudience` = users with `isActive: true` whose `lastActiveAt` is within the last `ACTIVE_WINDOW_DAYS`, whatever the audience size, matching the filters, excluding the owner and any block relationship. Users with **no** `lastActiveAt` yet also count: the field is new, and existing users only get it the next time they open the app. The count is cached per targeting combination for 10 minutes.

### 6.3 What "audience size" means

Audience size doesn't change who is eligible. Age and gender apply at every size. It sets what share of the eligible audience the boost targets, so reach always grows from Specific to Wide:

| Size | Share | 47 eligible → |
|---|---|---|
| `specific` | 20% | up to 9 people |
| `balanced` | 50% | up to 23 people |
| `wide` | 100% | up to 47 people |

It works as a cap on the delivery target. The boost stops once that many people have viewed it. It doesn't pick a particular subset of people.

(Earlier versions made Specific require profile data, and then used activity windows of 7, 30 and 90 days. With today's sparse data, both gave the same or zero reach, so both were dropped.)

### 6.4 No location targeting

Boosts can't target a country. We don't store where users are. The ways to find out (IP lookup, device region, a profile field, GPS) were each either unreliable or unlikely to be filled in, so the option was dropped rather than shipped as a filter that does nothing. Bringing it back means adding a `country` field to users, a way to fill it, and a `locations` field on the campaign targeting.

---

## 7. Lifecycle and pacing

```
            create (coins spent)
                   │
                   ▼
   ┌──────────►  ACTIVE  ──── target reached ───► COMPLETED (no refund)
   │               │  │
 resume          pause └──── endAt passed ──────► EXPIRED   (refund undelivered)
   │               ▼
   └─────────── PAUSED ───── user cancels ──────► CANCELLED (refund undelivered)
                    (ACTIVE can be cancelled too)
```

- **Create:** validate → compute the target (§2.1) → `spendCoins(coinsCharged)` → insert the campaign → set `video.isBoosted = true` and `activeCampaign`. If the insert fails after the spend, refund right away. There are no multi-document transactions on the current Mongo setup, so we compensate instead.
- **Expire:** a cron job every 5 minutes finds `status: active, endAt ≤ now`, settles the refund (§2.2), marks the campaign `expired`, and clears `video.isBoosted`.
- **Complete:** triggered inline by the view that hits the target (§4.2).
- **Cancel:** `POST /boost/campaigns/:id/cancel` settles the refund the same way.
- **Pause and resume** (the dashboard shows "Pause Campaign"): paused campaigns get no boost slots. `endAt` does **not** move, so pausing still uses up time. Keeping it simple is deliberate.
- **Video removed or deleted:** the campaign is cancelled with `endReason: 'video_removed'` and fully settled.
- **Notifications** (reusing the notification module): "Your boost is live", "Your boost finished: 1,240 views", and "Your boost ended early, 120 coins refunded".

---

## 8. API

All endpoints need a JWT unless marked otherwise. Paths sit under the existing `boost` prefix to keep the app config simple.

| Method & path | Purpose |
|---|---|
| `GET /boost/config` | Tiers, coin min/max/step, durations, audience sizes, age buckets, genders, suggested countries. **The app stops hardcoding these.** |
| `POST /boost/estimate` | Body `{ targeting, coins, durationDays }` → `{ eligibleAudience, targetViews, coinsCharged, maxUsefulCoins, estimatedReach: { min, max } }`. Feeds the Audience and Budget reach numbers. |
| `POST /boost/campaigns` | Header `Idempotency-Key`. Body `{ videoId, goal, targeting, coins, durationDays }` → `{ campaign, coinsCharged, coinBalance }`. Errors: `INSUFFICIENT_COINS` (400), `ACTIVE_CAMPAIGN_EXISTS` (409), `VIDEO_NOT_READY` (400), `NOT_VIDEO_OWNER` (403). |
| `GET /boost/campaigns?tab=live\|past\|cancelled&page=` | Boost dashboard tabs. `live` is active and paused, `past` is completed and expired. |
| `GET /boost/campaigns/:id` | One campaign with stats: delivered, target, progress %, impressions, engagements, coins spent so far, avg coins per view, pace ("optimal" / "behind"). |
| `POST /boost/campaigns/:id/cancel` | → `{ campaign, refundedCoins, coinBalance }` |
| `POST /boost/campaigns/:id/pause` · `/resume` | Pause and resume |
| `POST /videos/:id/views` (optional auth) | View report (§4). Always responds `204` so it leaks nothing about counting. |
| `GET /boost/admin/campaigns` (admin) | All campaigns with filters |

**Dashboard metrics mapping** (the Figma "Boost Main Screen"):

| Dashboard label | Source |
|---|---|
| Delivered views, "of N Views (x%)" | `deliveredViews`, `targetViews` |
| Delivery pace | `behind` from §5 → Optimal / Behind / Completed |
| Engagements | `engagements.likes + comments + follows` |
| Total coins spent | `ceil(deliveredViews / viewsPerCoin)` of `coinsCharged` |
| Avg cost per view | `coinsSpent / deliveredViews` |

---

## 9. Module layout

```
src/modules/boost-campaigns/
  boost-campaigns.module.ts
  boost-campaigns.controller.ts      // /boost/config, /estimate, /campaigns…
  boost-campaigns.service.ts         // create, cancel, pause, settle
  boost-delivery.service.ts          // candidate selection + injection (used by FeedService)
  boost-targeting.service.ts         // viewer matching + eligible audience counts
  boost-campaigns.cron.ts            // expiry + settlement
  boost-campaigns.config.ts
  dto/
  video-views.service.ts             // POST /videos/:id/views: viewCount dedupe + campaign attribution
                                     // (its controller sits in boost-campaigns.controller.ts, because it
                                     //  needs the campaign models and would otherwise create a module cycle)
  boost-engagement.service.ts        // likes/comments/follows credit
src/database/schemas/boost-campaign/
  boost-campaign.schema.ts
  boost-impression.schema.ts
  boost-view.schema.ts
```

`FeedService` gets `BoostDeliveryService` injected and calls it in `getGlobalFeed`. Everything else in the feed stays the same.

---

## 10. What happens to the old boost code

- **Phase 1:** leave `/boost/quote`, `/boost/promote`, the IAP `purchaseBoost` and the Stripe legacy boost untouched, so the currently installed app keeps working. Mark them `@deprecated` in code.
- **After the new app version is adopted:** remove `promote` and `quote`. The IAP product boost and the reward pool are a separate decision (Q4).
- The existing `expireDueBoosts` cron keeps running for old `boosts` rows.

---

## 11. App changes this needs (for reference)

1. Report views to `POST /videos/:id/views` at 3s with `{ watchSeconds, campaignId }`, sending `campaignId` when the feed item has `boost.campaignId`.
2. Send an `X-Device-Id` header, so guest views are deduplicated.
3. Load `/boost/config` instead of the hardcoded `boostOptions.js`.
4. Replace the static reach ranges with `/boost/estimate`.
5. Wire "Boost Now" to `POST /boost/campaigns` with an idempotency key, and handle `INSUFFICIENT_COINS` by opening the coin top-up.
6. Load the Boost dashboard from `GET /boost/campaigns`, and wire Pause and Cancel.

---

## 12. Build order

| Phase | Scope | Why this order |
|---|---|---|
| **1. View counting** | `POST /videos/:id/views`, Redis dedupe, `viewCount` and `watchTimeTotal`, plus the app call | Fixes the "0 views" bug on its own, and everything else depends on it. |
| **2. Schemas + config** | The three new collections, `User.lastActiveAt`, config, `GET /boost/config` | Foundation |
| **3. Create and settle** | `/estimate`, `POST /campaigns`, cancel, expiry cron, refunds, notifications | Money paths first, with tests for every refund case |
| **4. Delivery** | Candidate selection, pacing, feed injection, impressions | Boosts start actually reaching people |
| **5. Attribution** | Campaign counting in the views endpoint, target-reached completion, engagement hooks | Delivery numbers become real |
| **6. Dashboard** | List and detail endpoints, pause and resume, admin list | UI data |
| **7. Cleanup** | Deprecate and remove the legacy promote and quote once the app is out | |

**Tests that must exist before release:** the refund formula (expire, cancel, target reached, video removed); double-submit with the same idempotency key; concurrent views at the target boundary never over-delivering; a viewer counted once per campaign; the owner and blocked users never counted; a guest view adding to `viewCount` but not delivery.

---

## 13. Open questions (built with the recommended answers; change them any time)

| # | Question | Recommendation |
|---|---|---|
| Q1 | What is `VIEWS_PER_COIN`? The UI placeholder assumes 4–10 people per coin. | Start at **4** (500 coins → 2,000 views wanted). It's env-configurable. |
| Q2 | Location targeting? | **Removed.** We don't collect user location, so a country filter couldn't do anything real. See §6.4. |
| Q3 | Strict or lenient targeting while profile data is sparse? | Lenient everywhere (§6.2). Audience size is a share of the eligible audience (§6.3). |
| Q4 | Should viewers still earn from boosted videos (the old 20% reward pool)? | **Not in v1.** Keep coin campaigns separate from the reward economy. Paying people to watch also invites fake views. |
| Q5 | Should guest views count toward delivery? | No: they can't be deduplicated reliably. They still count toward `viewCount`. |
| Q6 | A free first boost for new creators? | Worth it at 50–100 users. It would be a `freeBoostUsed` flag on the user plus a 0-coin campaign path. |
| Q7 | Should the app show real reach (`/estimate`) instead of the static 500–15,000 ranges? | Yes. With the current user base the static ranges overpromise by about 20–100×. |
