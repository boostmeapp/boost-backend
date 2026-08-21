# Iteration 3 — Feed API Contract, Auth & Pagination

**Scope:** backend-led, with a matching frontend change. Ship the backend first; it is
backward compatible with the shipped app.
**Closes:** D-25 … D-35. Documents D-36.
**Depends on:** Iteration 2 (`src/utils/media.js` exists on the client and becomes a
pass-through here).

---

## 1. Objective

Make the feed endpoint tell the truth and stop it from lying about its own pagination.

After this iteration:

- `GET /feed/global` resolves the viewer when a token is present, so `hasLiked` is real and
  block filtering actually applies.
- The response carries **absolute, playable `videoUrl` and `thumbnailUrl`**, so the app
  stops composing S3 URLs and the bucket hostname disappears from the client entirely —
  which is the hook iteration 5 needs to switch on a CDN with one environment variable.
- Pagination is **cursor-based** and stable: no duplicated items, no skipped items, no
  `countDocuments` on every page.
- The response payload shrinks to the ~14 fields the app actually reads.
- `username` is populated, so handles stop being `@firstname`.
- The Following feed paginates at all, which it currently does not.

---

## 2. Problems addressed

### 2.1 `/feed/global` never knows who is asking (D-25)

[feed.controller.ts:12-23](boost-backend/src/modules/feed/feed.controller.ts#L12-L23):

```ts
  // ✅ GLOBAL FEED (NO AUTH)
@Get('global')
async getGlobalFeed(
  @Query() query: PaginationDto,
  @CurrentUser() user?: User, // OPTIONAL USER
) {
```

The comment says "optional user". There is no mechanism that makes it optional — there is
no mechanism at all. `@CurrentUser()` is a plain param decorator that reads `request.user`
([current-user.decorator.ts](boost-backend/src/common/decorators/current-user.decorator.ts)),
and nothing on this route populates it:

- The route has no `@UseGuards`.
- `app.module.ts` providers contains `ThrottlerGuard` and `AllExceptionsFilter` and **no**
  `APP_GUARD` entry for `JwtAuthGuard` ([app.module.ts:116-129](boost-backend/src/app.module.ts#L116-L129)).

So `user` is always `undefined`, `userId` is always `undefined`, and
[feed.service.ts:140-145](boost-backend/src/modules/feed/feed.service.ts#L140-L145) takes
the else branch for everyone:

```ts
  } else {
    finalVideos = videos.map(video => ({ ...video, hasLiked: false }));
  }
```

Every heart in the For You feed is hollow, for every user, always. And
`getBlockedUserIds(undefined)` returns `[]`
([feed.service.ts:21-28](boost-backend/src/modules/feed/feed.service.ts#L21-L28)), so
blocking a user hides their content from the Following feed but **not** from For You — the
block feature is half-functional in production right now.

The identical problem exists on `GET /videos/:id` (D-26), which is decorated `@Public()`
([video.controller.ts:76-79](boost-backend/src/modules/video/video.controller.ts#L76-L79)).
`@Public()` is metadata read by `JwtAuthGuard`; with no guard on the route it does nothing,
so `viewerId` is `undefined` and `hasLiked`/`isFollowing` are hardcoded `false` there too —
which is why the `/video/[id]` surface shows every video as unliked and every creator as
unfollowed.

### 2.2 The whole document is sent, 20 at a time (D-27, D-28)

[feed.service.ts:117-123](boost-backend/src/modules/feed/feed.service.ts#L117-L123):

```ts
  const videos = await this.videoModel
    .find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('user', 'firstName lastName profileImage')
    .lean();
```

No `.select()`. `.lean()` returns every field in the schema: `chunks[]`, `processedVideoKey`,
`manifestUrl`, `watchTimeTotal`, `boostScore`, `boostStartDate`, `boostEndDate`,
`hasRewardPool`, `rewardPoolAmount`, `rewardPoolDistributed`, `rewardEligibleViews`,
`moderationStatus`, `reportCount`, `removedReason`, `removedAt`, `removedBy`,
`processingProgress` — for 20 documents, on a mobile connection, on every page.

The app reads about a dozen of them
([HomeScreen.jsx:209-231](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L209-L231)).

And the populate omits `username`, while the app does:

```js
// HomeScreen.jsx:202
const handle = video.user?.username ? `@${video.user.username}` : (firstName ? `@${firstName.toLowerCase()}` : '@user');
```

`video.user.username` is never present, so every handle in the feed is `@firstname`. The
field exists on the user schema ([user.schema.ts:71](boost-backend/src/database/schemas/user/user.schema.ts#L71))
and is indexed; it is simply not selected.

### 2.3 Offset pagination over a moving window (D-29, D-30, D-31)

```ts
const totalDocs = await this.videoModel.countDocuments(query);   // every page request
...
.sort({ createdAt: -1 }).skip(skip).limit(limit)
```

`countDocuments` with the `{processingStatus, moderationStatus}` predicate is a full index
scan of the matching range on every single page fetch, and the result is used only to
compute `hasNextPage` and `totalPages`.

Worse, `skip`/`limit` over a `createdAt: -1` sort is unstable by construction: if one video
is uploaded between the page-1 and page-2 requests, every item shifts down one slot, so the
last item of page 1 reappears as the first item of page 2. The client then calls
[store/index.js:86-88](newboostraapp/src/store/index.js#L86-L88):

```js
appendVideos: (newVideos) => set((state) => ({ videos: [...state.videos, ...newVideos] })),
```

— no de-duplication. Two entries with the same `id` means `keyExtractor` produces duplicate
keys, which makes `FlatList` remount cells and React log a duplicate-key warning. That is
the reported "feed items repeating on scroll-to-load", and it is also a source of the
scroll jank, because a remount tears down and rebuilds a `<Video>`.

### 2.4 The Following feed never loads page 2 (D-33)

[videoService.js:186-195](newboostraapp/src/services/videoService.js#L186-L195):

```js
return {
    success: true,
    data: videos,
    pagination: isArray ? null : {
        totalDocs: response.data.totalDocs,
        limit: response.data.limit,
        page: response.data.page,
        totalPages: response.data.totalPages,
        //  ← hasNextPage is NOT copied
    }
};
```

Compare `getAllVideos` at lines 22-29, which does copy it. `HomeScreen.fetchVideos` then
runs `setHasNextPage(result.pagination.hasNextPage)` → `setHasNextPage(undefined)`, and
`handleLoadMore` at line 266 does `if (!hasNextPage) return;`. The Following feed is
permanently capped at 20 items. The backend returns the flag correctly
([feed.service.ts:95](boost-backend/src/modules/feed/feed.service.ts#L95)); the client
throws it away.

### 2.5 The client composes S3 URLs (D-32)

The backend never returns a playable URL. `HomeScreen` builds one:

```js
// HomeScreen.jsx:182, 221
const S3_BASE_URL = 'https://boostme-storage.s3.eu-north-1.amazonaws.com/';
videoUrl: video.rawVideoKey ? `${S3_BASE_URL}${video.rawVideoKey}` : null,
```

Iteration 2 collapsed the three copies of that hostname into `src/utils/media.js`, but the
constant is still baked into a shipped app binary. That means a CDN cutover would require
an app-store release and would leave every un-upgraded install pointed at the origin
forever. The hostname has to move server-side before iteration 5 is possible.

### 2.6 Assorted (D-34, D-35, D-36)

- [HomeScreen.jsx:244](newboostraapp/src/screens/home/screens/HomeScreen.jsx#L244) reads
  `videos.length` inside `fetchVideos`, which closed over the value from the render that
  created it — after `setVideos(...)` on the line above, it is stale by definition.
- `PaginationDto` defaults `limit` to 10 while the app always sends 20, and
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`
  ([main.ts:84-99](boost-backend/src/main.ts#L84-L99)) will reject a `cursor` query param
  with a 400 unless it is declared on a DTO.
- `calculateRankScore` and `getPersonalizedFeed`
  ([feed.service.ts:168-281](boost-backend/src/modules/feed/feed.service.ts#L168-L281))
  are wired to no route — so boosted videos, which users pay for, receive zero ranking
  advantage in the feed the app actually consumes. This iteration does **not** enable
  ranking (that is a product decision with revenue implications, and `getPersonalizedFeed`
  as written loads *every* ready video into memory on every request). It is called out
  here so the decision is explicit rather than accidental.

---

## 3. Approach

**Backend**

1. New `OptionalJwtAuthGuard` — resolves the viewer when a valid token is present, never
   rejects when one is not. Apply to `GET /feed/global` and `GET /videos/:id`.
2. New `MediaUrlService` — one injectable that turns an S3 key into an absolute URL,
   reading `AWS_CLOUDFRONT_DOMAIN` and falling back to the S3 host when it is the
   `REPLACE_WITH_*` placeholder. The feed service uses it to emit `videoUrl` and
   `thumbnailUrl`.
3. New `FeedQueryDto extends PaginationDto` adding `cursor`, with `limit` defaulting to 20.
4. Rewrite `getGlobalFeed` / `getFollowingFeed`: `.select()` projection, `username` in the
   populate, keyset pagination on `{createdAt, _id}`, `limit + 1` for `hasNextPage`, no
   `countDocuments`. Keep the legacy `page`/`skip` branch so the shipped app keeps working.
5. Add the compound indexes those sorts need.

**Frontend**

6. `videoService`: send `cursor`, return `nextCursor`, and copy `hasNextPage` on the
   Following path.
7. `store`: `nextCursor` state; `appendVideos` de-duplicates by id.
8. `HomeScreen`: consume `video.videoUrl` / `video.thumbnailUrl` from the response (fall
   back to key composition for one release), paginate by cursor, drop the stale closure.

---

## 4. Why this approach

**Why an optional guard rather than registering `JwtAuthGuard` globally.** Registering it
as an `APP_GUARD` would make every route authenticated-by-default, and the codebase is not
written for that — `@Public()` appears on exactly one handler
(`video.controller.ts:76`), so the moment you flip it on, `/auth/login`, `/auth/register`,
`/health`, the reset-password controller and every other unguarded route start returning
401. That is a large, risky refactor that has nothing to do with the video feed. A
route-scoped `OptionalJwtAuthGuard` changes the behaviour of exactly the two routes that
need it.

**Why keyset (cursor) pagination rather than fixing offsets.** The instability is inherent
to `skip` over a sort key that new rows are inserted at the head of; there is no amount of
care on the client that fixes it. A keyset cursor asks "give me the next 20 strictly older
than this exact document", which is stable under concurrent inserts by construction, and it
lets Mongo use the index to seek directly rather than counting past `skip` documents. It
also makes `countDocuments` unnecessary: fetch `limit + 1` and check whether you got the
extra one.

**Why the tiebreak on `_id`.** `createdAt` is not unique — two uploads in the same
millisecond are entirely possible during a burst, and a cursor on `createdAt` alone would
either skip one of them or loop. `{createdAt: -1, _id: -1}` is a total order because `_id`
is unique, and `ObjectId` comparison is well-defined.

**Why keep the legacy offset branch.** The currently-installed app sends `page` and expects
`docs`/`hasNextPage`. Deleting that branch bricks every install until the store review
clears. Dual-mode costs about fifteen lines and lets the backend ship on its own schedule.
Remove the branch a release after the new client is at high adoption.

**Why move URL composition server-side now rather than in iteration 5.** Because iteration
5's whole value is "change one env var and every client is on the CDN". If the hostname is
in the app binary, iteration 5 becomes an app release with a long tail of un-upgraded
installs still hammering the origin. This is the enabling change; do it before you need it.

**Why not enable `getPersonalizedFeed`.** Read it: it calls `.find(baseQuery).lean()` with
no limit, loads every ready video in the database into Node memory, ranks them all, then
slices 20. That is fine at 200 videos and a production incident at 200,000. Enabling
ranking is worth doing and needs its own design (precomputed `rankScore` written by a
scheduled job, indexed, then a keyset paginate over it). Out of scope; tracked as D-36.

---

## 5. Exact backend changes

### 5.1 New — `src/common/guards/optional-jwt-auth.guard.ts`

```ts
import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Resolves request.user when a valid Bearer token is present, and lets the
 * request through untouched when it is absent, malformed or expired.
 *
 * Use on public routes whose response is *richer* for a signed-in viewer
 * (hasLiked, isFollowing, block filtering) but must still serve guests.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // No token / bad token / expired token — proceed as a guest.
    }
    return true;
  }

  handleRequest(_err: any, user: any) {
    return user || undefined;
  }
}
```

Register it in [src/common/guards/index.ts](boost-backend/src/common/guards/index.ts):

```diff
 export * from './jwt-auth.guard';
+export * from './optional-jwt-auth.guard';
 export * from './local-auth.guard';
 export * from './roles.guard';
```

> `JwtStrategy.validate` does a `usersService.findOne(payload.sub)` on every request
> ([jwt.strategy.ts](boost-backend/src/modules/auth/strategies/jwt.strategy.ts)). That is
> one extra `findById` per feed request for signed-in users — the same cost the Following
> feed already pays. Acceptable; noted in §9.

### 5.2 New — `src/common/services/media-url.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * The single place in the backend that knows where media is served from.
 *
 * Reads AWS_CLOUDFRONT_DOMAIN. While that variable holds the REPLACE_WITH_*
 * placeholder it falls back to the S3 virtual-hosted URL, so behaviour is
 * identical to today. Iteration 5 sets the variable and every URL — including
 * absolute S3 URLs already stored in old rows — moves to the edge with no
 * client change and no data migration.
 */
@Injectable()
export class MediaUrlService {
  private readonly base: string;
  private readonly s3Origin: string;

  constructor(config: ConfigService) {
    const bucket = config.get<string>('AWS_S3_BUCKET');
    const region = config.get<string>('AWS_REGION') || 'us-east-1';
    this.s3Origin = `https://${bucket}.s3.${region}.amazonaws.com/`;

    const cdn = (config.get<string>('AWS_CLOUDFRONT_DOMAIN') || '').trim();
    const configured = cdn && !cdn.startsWith('REPLACE_WITH');

    this.base = configured
      ? `${cdn.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
          .replace(/^/, 'https://') + '/'
      : this.s3Origin;
  }

  /** S3 key -> absolute URL. Absolute S3 URLs are rewritten onto the current host. */
  toUrl(keyOrUrl?: string | null): string | null {
    if (!keyOrUrl) return null;
    const v = String(keyOrUrl).trim();
    if (!v || v === 'null' || v === 'undefined') return null;

    if (/^https?:\/\//i.test(v)) {
      return v.startsWith(this.s3Origin)
        ? this.base + v.slice(this.s3Origin.length)
        : v;
    }
    return this.base + v.replace(/^\/+/, '');
  }
}
```

Export it from a small shared module so both `FeedModule` and `VideoModule` can inject it —
`src/common/services/common-services.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { MediaUrlService } from './media-url.service';

@Global()
@Module({ providers: [MediaUrlService], exports: [MediaUrlService] })
export class CommonServicesModule {}
```

and add `CommonServicesModule` to the `imports` array in
[app.module.ts](boost-backend/src/app.module.ts#L92) (next to `DatabaseModule`).

### 5.3 New — `src/modules/feed/dto/feed-query.dto.ts`

```ts
import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class FeedQueryDto {
  /** Legacy offset pagination. Ignored when `cursor` is present. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  /** Opaque keyset cursor from a previous response's `nextCursor`. */
  @IsOptional()
  @IsString()
  cursor?: string;
}
```

`limit` defaults to 20 (matching what the app sends) and caps at 50, not 100 — a 100-item
page of feed documents is not something the client can use and is a cheap amplification
vector.

> **`forbidNonWhitelisted` reminder.** Until this DTO is deployed, sending `?cursor=...`
> returns 400. Backend first, then app. Always.

### 5.4 `src/modules/feed/feed.controller.ts`

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FeedService } from './feed.service';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { FeedQueryDto } from './dto/feed-query.dto';

@Controller('feed')
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  // Public, but richer for a signed-in viewer (hasLiked + block filtering).
  @UseGuards(OptionalJwtAuthGuard)
  @Get('global')
  async getGlobalFeed(@Query() query: FeedQueryDto, @CurrentUser() user?: User) {
    return this.feedService.getGlobalFeed(query, user?._id?.toString());
  }

  @UseGuards(JwtAuthGuard)
  @Get('following')
  async getFollowingFeed(@CurrentUser() user: User, @Query() query: FeedQueryDto) {
    return this.feedService.getFollowingFeed(user._id.toString(), query);
  }
}
```

Both service methods now take the DTO rather than positional args — that is the only
signature change, and `FeedService` is exported but injected nowhere else
([feed.module.ts](boost-backend/src/modules/feed/feed.module.ts)), so there are no other
call sites to update. Verify with `grep -rn "feedService\." boost-backend/src`.

### 5.5 `src/modules/feed/feed.service.ts` — the core rewrite

Add at the top of the class:

```ts
  /** Fields the mobile client actually reads. Everything else stays on the server. */
  private static readonly FEED_PROJECTION =
    'user title description tags likeCount commentCount shareCount viewCount ' +
    'duration rawVideoKey thumbnailUrl thumbnailKey isBoosted createdAt';

  private static readonly USER_PROJECTION =
    'firstName lastName username profileImage';

  private encodeCursor(v: any): string {
    return Buffer.from(
      `${new Date(v.createdAt).getTime()}_${v._id}`,
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): { createdAt: Date; id: Types.ObjectId } | null {
    try {
      const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('_');
      const createdAt = new Date(Number(ts));
      if (Number.isNaN(createdAt.getTime())) return null;
      return { createdAt, id: new Types.ObjectId(id) };
    } catch {
      return null;   // a bad cursor is treated as "start from the beginning"
    }
  }

  /** Shapes one lean document into the wire format the app consumes. */
  private present(video: any, hasLiked: boolean) {
    return {
      _id: video._id,
      user: video.user,
      title: video.title,
      description: video.description,
      tags: video.tags,
      likeCount: video.likeCount,
      commentCount: video.commentCount,
      shareCount: video.shareCount,
      viewCount: video.viewCount,
      duration: video.duration,
      isBoosted: video.isBoosted,
      createdAt: video.createdAt,

      // Absolute and playable. The client no longer composes URLs.
      videoUrl: this.mediaUrl.toUrl(video.rawVideoKey),
      thumbnailUrl: this.mediaUrl.toUrl(video.thumbnailKey || video.thumbnailUrl),

      // Kept for one release so the currently-installed app keeps working.
      rawVideoKey: video.rawVideoKey,

      hasLiked,
    };
  }
```

Inject `MediaUrlService` into the constructor:

```diff
   private likesService: LikesService,
+  private mediaUrl: MediaUrlService,
 ) {}
```

Then the shared paginator:

```ts
  /**
   * One keyset-or-offset paginator for both feeds.
   * Cursor mode when `cursor` is supplied; offset mode otherwise (legacy clients).
   */
  private async paginate(
    baseQuery: Record<string, any>,
    { page = 1, limit = 20, cursor }: FeedQueryDto,
    viewerId?: string,
  ) {
    const query: Record<string, any> = { ...baseQuery };
    const useCursor = Boolean(cursor);

    if (useCursor) {
      const c = this.decodeCursor(cursor!);
      if (c) {
        query.$and = [
          ...(query.$and || []),
          {
            $or: [
              { createdAt: { $lt: c.createdAt } },
              { createdAt: c.createdAt, _id: { $lt: c.id } },
            ],
          },
        ];
      }
    }

    const q = this.videoModel
      .find(query)
      .select(FeedService.FEED_PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)                       // +1 tells us if there is a next page
      .populate('user', FeedService.USER_PROJECTION)
      .lean();

    if (!useCursor) q.skip((page - 1) * limit);

    const rows = await q.exec();

    const hasNextPage = rows.length > limit;
    if (hasNextPage) rows.pop();

    let likedMap = new Map<string, boolean>();
    if (viewerId && rows.length) {
      likedMap = await this.likesService.hasUserLikedVideos(
        viewerId,
        rows.map(v => v._id.toString()),
      );
    }

    const docs = rows.map(v =>
      this.present(v, likedMap.get(v._id.toString()) || false),
    );

    return {
      docs,
      nextCursor: hasNextPage && rows.length
        ? this.encodeCursor(rows[rows.length - 1])
        : null,
      limit,
      page,
      hasNextPage,
      hasPrevPage: page > 1,

      // countDocuments() removed: it was a full index scan on every page request
      // and only fed hasNextPage, which limit+1 now answers exactly.
      totalDocs: null,
      totalPages: null,
    };
  }
```

`getGlobalFeed` and `getFollowingFeed` collapse to query construction:

```ts
  async getGlobalFeed(query: FeedQueryDto, userId?: string) {
    const blockedIds = await this.getBlockedUserIds(userId);

    const base: any = {
      processingStatus: 'ready',
      moderationStatus: { $ne: ModerationStatus.REMOVED },
    };
    if (blockedIds.length) base.user = { $nin: blockedIds };

    return this.paginate(base, query, userId);
  }

  async getFollowingFeed(userId: string, query: FeedQueryDto) {
    const followingDocs = await this.followModel
      .find({ follower: new Types.ObjectId(userId) })
      .select('following')
      .lean();

    const followingIds = followingDocs.map(f => f.following);
    if (!followingIds.length) {
      return {
        docs: [], nextCursor: null, limit: query.limit ?? 20, page: query.page ?? 1,
        hasNextPage: false, hasPrevPage: false, totalDocs: 0, totalPages: 0,
      };
    }

    const blockedIds = await this.getBlockedUserIds(userId);
    const visible = blockedIds.length
      ? followingIds.filter(id => !blockedIds.some(b => b.toString() === id.toString()))
      : followingIds;

    return this.paginate(
      {
        user: { $in: visible },
        processingStatus: 'ready',
        moderationStatus: { $ne: ModerationStatus.REMOVED },
      },
      query,
      userId,
    );
  }
```

Leave `calculateRankScore` / `getPersonalizedFeed` in place, unrouted, with a comment
pointing at D-36.

### 5.6 `src/modules/video/video.controller.ts`

Make the single-video route resolve its viewer (D-26):

```diff
-import { JwtAuthGuard } from '../../common/guards';
-import { CurrentUser, Public } from '../../common/decorators';
+import { JwtAuthGuard, OptionalJwtAuthGuard } from '../../common/guards';
+import { CurrentUser } from '../../common/decorators';
@@
   @Get(':id')
-  @Public()
+  @UseGuards(OptionalJwtAuthGuard)
   async findOne(@Param('id') id: string, @CurrentUser() user?: User) {
     return this.videoService.findOne(id, user?.id);
   }
```

`findOne` already selects `username` in its populate
([video.service.ts:294](boost-backend/src/modules/video/video.service.ts#L294)) — nothing
else to change there, except adding the absolute URLs so `/video/[id]` matches the feed:

```diff
     return {
       ...video,
+      videoUrl: this.mediaUrl.toUrl(video.rawVideoKey),
+      thumbnailUrl: this.mediaUrl.toUrl((video as any).thumbnailKey || video.thumbnailUrl),
       hasLiked,
       isFollowing,
     };
```

(inject `MediaUrlService` into `VideoService` the same way; `CommonServicesModule` is
`@Global()` so no module wiring is needed).

**Cleanup while you are here:** delete `@Get('feed/following')` and
`@Get('feed/following/cursor')` from this controller (lines 30-58) and the corresponding
`getFollowingFeed` / `getFollowingFeedCursor` from `VideoService` (lines 66-216). They are
a second and third parallel implementation of the same feature, return a different envelope
shape, and are called by nothing —
verify with `grep -rn "videos/feed/following" newboostraapp/src boost-backend/src`. Leaving
three feed implementations alive is how the next person fixes the wrong one.

### 5.7 `src/database/schemas/video/video.schema.ts` — indexes

Add next to the existing index declarations (after line 175):

```ts
// Keyset pagination for the global feed: equality on the two status fields,
// then a total order on (createdAt, _id).
VideoSchema.index(
  { processingStatus: 1, moderationStatus: 1, createdAt: -1, _id: -1 },
  { name: 'FeedGlobalKeyset' },
);

// Same, scoped to a set of followed creators.
VideoSchema.index(
  { user: 1, processingStatus: 1, moderationStatus: 1, createdAt: -1, _id: -1 },
  { name: 'FeedFollowingKeyset' },
);
```

`VideoSchema.set('autoIndex', true)` is already on
([video.schema.ts:160](boost-backend/src/database/schemas/video/video.schema.ts#L160)), so
these build on boot. See §9 — on a large collection that is a foreground build that will
stall startup. Prefer building them manually first (§10, T-3.0).

The pre-existing `{ processingStatus: 1, createdAt: -1 }` index becomes a strict prefix of
`FeedGlobalKeyset` and can be dropped later; leave it for now.

### 5.8 Backend files touched

```
boost-backend/src/common/guards/optional-jwt-auth.guard.ts        (new)
boost-backend/src/common/guards/index.ts                          (+1 export)
boost-backend/src/common/services/media-url.service.ts            (new)
boost-backend/src/common/services/common-services.module.ts       (new)
boost-backend/src/app.module.ts                                   (+CommonServicesModule)
boost-backend/src/modules/feed/dto/feed-query.dto.ts              (new)
boost-backend/src/modules/feed/feed.controller.ts                 (guards, DTO)
boost-backend/src/modules/feed/feed.service.ts                    (major rewrite)
boost-backend/src/modules/video/video.controller.ts               (guard; delete dead routes)
boost-backend/src/modules/video/video.service.ts                  (urls; delete dead feeds)
boost-backend/src/database/schemas/video/video.schema.ts          (+2 indexes)
```

---

## 6. Exact frontend changes

### 6.1 `src/store/index.js`

```diff
 const createFeedSlice = (set) => ({
     videos: [],
     page: 1,
+    nextCursor: null,
     hasNextPage: false,
@@
     setVideos: (videos) => set({ videos }),
-    appendVideos: (newVideos) => set((state) => ({
-        videos: [...state.videos, ...newVideos]
-    })),
+    // Offset pagination could return an item twice; a keyset cursor should not,
+    // but a duplicate key remounts the cell and tears down its <Video>, so we
+    // guarantee uniqueness here regardless of what the server sends.
+    appendVideos: (newVideos) => set((state) => {
+        const seen = new Set(state.videos.map((v) => v.id));
+        const fresh = newVideos.filter((v) => v?.id && !seen.has(v.id));
+        return fresh.length ? { videos: [...state.videos, ...fresh] } : {};
+    }),
     setPage: (page) => set({ page }),
+    setNextCursor: (nextCursor) => set({ nextCursor }),
@@
     resetFeedStore: () => set({
         videos: [],
         page: 1,
+        nextCursor: null,
         hasNextPage: false,
```

### 6.2 `src/services/videoService.js`

`getAllVideos` — accept and return the cursor:

```diff
     async getAllVideos(params = {}) {
         try {
             const queryParams = { limit: 20, ...params };
+            // Never send both; a present `cursor` makes `page` meaningless.
+            if (queryParams.cursor) delete queryParams.page;
             const response = await apiClient.get(API_CONFIG.ENDPOINTS.FEED.FOR_YOU, { params: queryParams });
@@
             return {
                 success: true,
                 data: videos,
-                pagination
+                pagination,
+                nextCursor: isArray ? null : (response.data.nextCursor ?? null),
             };
```

`getFollowingFeed` — same, **plus the D-33 fix**:

```diff
                 pagination: isArray ? null : {
                     totalDocs: response.data.totalDocs,
                     limit: response.data.limit,
                     page: response.data.page,
                     totalPages: response.data.totalPages,
+                    hasNextPage: response.data.hasNextPage,
+                    hasPrevPage: response.data.hasPrevPage,
-                }
+                },
+                nextCursor: isArray ? null : (response.data.nextCursor ?? null),
```

Also strip the per-call `console.log`s in this file (D-42) or route them through
`src/utils/log.js` from iteration 1.

### 6.3 `src/screens/home/screens/HomeScreen.jsx`

**(a) Consume server-authored URLs** in the mapper (lines 209-231):

```diff
-                        videoUrl: toMediaUrl(video.rawVideoKey),
-                        thumbnailUrl: toPosterUrl(video.thumbnailUrl),
+                        // The backend now sends absolute URLs. toMediaUrl/toPosterUrl
+                        // pass absolute URLs through untouched, so this line also keeps
+                        // working against an older API during a staged rollout.
+                        videoUrl: toMediaUrl(video.videoUrl || video.rawVideoKey),
+                        thumbnailUrl: toPosterUrl(video.thumbnailUrl),
```

**(b) Paginate by cursor.** `fetchVideos` gains the cursor and drops the stale closure:

```js
const fetchVideos = async (refresh = false, cursor = null, type = feedType) => {
    if (fetchLockRef.current) return;
    fetchLockRef.current = true;

    if (refresh) setIsRefreshing(true);
    else if (cursor) setIsLoadingMore(true);
    else setIsLoading(true);

    try {
        const params = cursor ? { limit: 20, cursor } : { limit: 20, page: 1 };
        const result = type === 'following'
            ? await videoService.getFollowingFeed(params)
            : await videoService.getAllVideos(params);

        if (!result.success) return;

        const mappedVideos = result.data.map(mapFeedVideo);   // unchanged mapper, extracted

        if (cursor) {
            appendVideos(mappedVideos);
        } else {
            setVideos(mappedVideos);
        }

        setNextCursor(result.nextCursor ?? null);
        setHasNextPage(
            result.nextCursor != null || result.pagination?.hasNextPage === true,
        );
        // NOTE: the active item is seeded by the effect added in iteration 1 §5.3(e).
        // Do not call setActiveVideo() here — that reintroduces a second authority.
    } catch (error) {
        if (error?.message === 'NETWORK_UNAVAILABLE') return;
        console.error('[FEED] ERROR:', error);
    } finally {
        fetchLockRef.current = false;
        setIsLoading(false);
        setIsRefreshing(false);
        setIsLoadingMore(false);
    }
};

const handleLoadMore = () => {
    const { nextCursor, hasNextPage } = useStore.getState();   // no stale closure
    if (!hasNextPage || !nextCursor) return;
    if (isLoadingMore || fetchLockRef.current) return;
    fetchVideos(false, nextCursor);
};
```

Update the three other `fetchVideos(...)` call sites to the new signature: the mount effect
(line 286), `handleRefresh` (iteration 1 §5.3(i)), and `handleFeedTypeChange` (line 111 →
`fetchVideos(true, null, type)`).

**(c)** `page` / `setPage` are no longer used by the feed path. Leave them in the store
(other code may read them) but stop writing them from `fetchVideos`.

### 6.4 Frontend files touched

```
newboostraapp/src/store/index.js                              (nextCursor, dedup)
newboostraapp/src/services/videoService.js                    (cursor in/out, D-33 fix, logs)
newboostraapp/src/screens/home/screens/HomeScreen.jsx         (cursor pagination, server URLs)
newboostraapp/src/utils/media.js                              (no change — already passes absolutes through)
```

---

## 7. Caching / preloading / buffering / autoplay / pagination / API / delivery / performance

| Area | Change |
|---|---|
| **API** | `GET /feed/global` gains an optional auth guard and a `cursor` param. Both feeds gain `videoUrl`, `thumbnailUrl` and `nextCursor` in the response; `totalDocs`/`totalPages` become `null`. Response is projected down to ~14 fields + a 4-field populated user. `GET /videos/:id` gains an optional auth guard and absolute URLs. Two dead routes deleted. |
| **Pagination** | Offset → keyset. Stable under concurrent uploads. `hasNextPage` from `limit + 1` instead of `countDocuments`. Client de-duplicates on append as a belt-and-braces guard. |
| **Caching** | No HTTP caching added on the feed response — a personalised, cursor-paginated feed should not be cached by intermediaries. Explicitly set `Cache-Control: private, no-store` on the feed route if you want to be sure Render's proxy never holds it. |
| **Delivery** | Unchanged host. But composition moves server-side, which is the precondition for iteration 5's one-variable CDN switch. |
| **Preloading / buffering / autoplay** | Unchanged. |
| **Performance** | Two Mongo queries removed per page (`countDocuments` on both feeds). `skip` replaced by an index seek. Payload per page down roughly 60–75 % — measure it, it is the easiest number in this whole plan to verify. One `findById` added per *authenticated* For You request (the JWT strategy's user lookup). |

---

## 8. Expected behaviour after this iteration

1. A signed-in user sees their own likes reflected in the For You feed — previously
   liked videos show a filled heart on load.
2. Blocking a user removes their videos from For You, not just from Following.
3. Handles render as `@username` for users who have one.
4. Scrolling to load more never shows the same video twice, even if someone uploads while
   you scroll.
5. The Following feed loads past 20 items.
6. The feed response is visibly smaller — no `chunks`, `rewardPool*`, `moderation*`,
   `removedReason`, `watchTimeTotal`.
7. Each item in the response carries a ready-to-play absolute `videoUrl`.
8. `/video/[id]` shows correct like and follow state.
9. Feed latency drops (two fewer queries, an index seek instead of a skip).
10. The currently-installed app build continues to work against the new backend unchanged.

**Still outstanding:** boosted videos still get no ranking advantage (D-36).

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Index build stalls startup.** `autoIndex: true` + two new compound indexes on a large `videos` collection means a foreground build during boot on Render, which can exceed the health-check timeout and loop-restart the instance. | **Medium-High** | Build them manually and in the background **before** deploying: `db.videos.createIndex({processingStatus:1,moderationStatus:1,createdAt:-1,_id:-1},{name:'FeedGlobalKeyset',background:true})` and the same for `FeedFollowingKeyset`. Then deploy; `autoIndex` finds them present and is a no-op. This is T-3.0 and it is not optional. |
| **Block filtering suddenly starts working**, so users who have blocked people see a shorter For You feed and may report it as "videos missing" | Medium | Correct behaviour, but it *is* a visible change. Check `db.users.countDocuments({blockedUsers: {$exists:true, $ne: []}})` first to size the affected population before you ship. |
| **`hasLiked` suddenly starts working**, so hearts that were hollow become filled — read as a bug by anyone who got used to it | Low | Same category. Communicate it. |
| Deploy-order inversion: an app build sending `cursor` reaches a backend without `FeedQueryDto` → `400` on every feed request → blank feed for everyone | **High if mishandled** | Backend first, always. T-3.1 verifies the old client still works against the new backend before the app ships. The old client sends only `page` and `limit`, both of which `FeedQueryDto` accepts. |
| `MediaUrlService` mis-parses `AWS_CLOUDFRONT_DOMAIN` and emits `https://https://...` | Medium | The constructor strips a leading scheme before re-adding one. Covered directly by T-3.4, which is worth running with several formats (`d123.cloudfront.net`, `https://d123.cloudfront.net`, `https://d123.cloudfront.net/`). |
| A bad or hand-crafted `cursor` causes a 500 | Low | `decodeCursor` returns `null` on any parse failure and the query falls back to the first page. Covered by T-3.9. |
| Dropping `totalDocs` breaks a consumer | Low | `grep -rn "totalDocs\|totalPages" newboostraapp/src`. Known readers are `videoService`'s pagination object and nothing downstream. They will receive `null`. |
| Deleting `/videos/feed/following*` breaks an unknown client (admin panel, web) | Low-Medium | `grep -rn "feed/following" across every repo you own` before deleting. If in doubt, leave them and add a `@deprecated` comment — the cleanup is not load-bearing. |
| `OptionalJwtAuthGuard` swallows a real auth error and a user silently browses as a guest with an expired token | Medium | That is the intended behaviour for a public feed, and `apiClient` already refuses to force-logout on non-auth-critical 401s ([apiClient.js](newboostraapp/src/utils/apiClient.js)). But confirm T-3.6: an *expired* token yields a 200 with `hasLiked: false`, not a 401. |
| Extra `findById` per authenticated feed request (JWT strategy) raises latency | Low | It is an indexed `_id` lookup. Measure in T-3.12; if it matters, cache the user in-process for 30 s keyed on `sub`. |

---

## 10. Test plan

### Phase A — backend, deployed alone, old app still installed

| # | Test | How | Pass |
|---|---|---|---|
| T-3.0 | **Indexes built out of band** — ⚠️ **gated, see below** | Run both `createIndex(..., {background:true})` commands. `db.videos.getIndexes()` | `FeedGlobalKeyset` and `FeedFollowingKeyset` present before deploy. |

> **⚠️ T-3.0 is gated by [Constraint #9](video-fix/iterations/00-OVERVIEW.md) — the app is
> live.** Run the two `createIndex` commands in the **Render dev environment** first and
> record how long each build takes on a comparable collection size. Running them against
> production is a separately-decided release step, executed during a low-traffic window,
> with the connection held open until both return.
>
> `background: true` makes the build non-blocking, so this is far less dangerous than the
> row-mutating scripts elsewhere in the plan — but it still consumes I/O on the live
> primary, and an interrupted build leaves a partial index. Do not fire it and walk away.
>
> **You cannot skip it, either.** The risk row above is explicit: deploying with
> `autoIndex: true` and no pre-built indexes triggers a *foreground* build during boot on
> Render, which can exceed the health-check timeout and loop-restart the instance. So the
> deploy of iteration 3 is blocked on the dev environment existing. Plan for that.
| T-3.1 | **Old client compatibility** | With the *currently shipped* app build, cold-launch and scroll 60 items | Feed loads, paginates, plays. **This gates the whole deploy.** |
| T-3.2 | **Guest still served** | `curl "$API/feed/global?page=1&limit=20"` with no `Authorization` | `200`. `docs.length === 20`. Every `hasLiked === false`. |
| T-3.3 | **Signed-in viewer resolved** | Like a video via `POST /videos/:id/like`, then `curl -H "Authorization: Bearer $TOK" "$API/feed/global?limit=50"` | That video's `hasLiked === true`. |
| T-3.4 | **URL composition** | Inspect `docs[0].videoUrl` in T-3.2's response | Starts with `https://boostme-storage.s3.eu-north-1.amazonaws.com/videos/`. `curl -sI` on it returns 200. Then temporarily set `AWS_CLOUDFRONT_DOMAIN=d123.example.net`, restart, re-curl → URL host is `d123.example.net`, path unchanged. **Unset it again.** |
| T-3.5 | **Username populated** | Same response | `docs[n].user.username` present for users who have one. |
| T-3.6 | **Expired token degrades gracefully** | `curl -H "Authorization: Bearer <expired>" "$API/feed/global"` | `200`, not `401`. `hasLiked` all `false`. |
| T-3.7 | **Projection** | `curl "$API/feed/global?limit=1" \| jq '.docs[0] \| keys'` | No `chunks`, `rewardPoolAmount`, `watchTimeTotal`, `moderationStatus`, `removedReason`, `processingProgress`, `boostScore`. |
| T-3.8 | **Payload shrank** | `curl -s "$API/feed/global?limit=20" \| wc -c`, compare to the baseline recorded in `00-OVERVIEW.md` | ≥ **50 %** smaller. |
| T-3.9 | **Cursor round-trip** | `curl "$API/feed/global?limit=5"` → take `nextCursor` → `curl "$API/feed/global?limit=5&cursor=$C"` | Second page's 5 ids are disjoint from the first page's, and strictly older by `createdAt`. |
| T-3.10 | **Cursor stability under insert** | Fetch page 1 (limit 5). Publish a new video. Fetch page 2 with the cursor. | Page 2 has **no** id from page 1. (Repeat with `?page=2` to observe the old behaviour failing — this is the proof the fix matters.) |
| T-3.11 | **Bad cursor** | `curl "$API/feed/global?cursor=notbase64"` and `?cursor=` | `200` with the first page. No 500. |
| T-3.12 | **Latency** | `curl -w '%{time_total}' -o /dev/null -s "$API/feed/global?limit=20"` × 5, warmed instance, guest and authed | Guest median **≤** the baseline. Authed within +80 ms of guest (the JWT user lookup). |
| T-3.13 | **Following feed paginates server-side** | `curl -H "Bearer $TOK" "$API/feed/following?limit=5"` with a user following someone with >5 videos | `hasNextPage: true`, `nextCursor` non-null. |
| T-3.14 | **Blocked users filtered from For You** | Block a creator, then fetch `/feed/global` authed | None of that creator's videos appear. Unblock and confirm they return. |
| T-3.15 | **`/videos/:id` viewer resolution** | `curl -H "Bearer $TOK" "$API/videos/<a video you liked>"` | `hasLiked: true`, `isFollowing` correct, `videoUrl` absolute. |
| T-3.16 | **Explicit-junk still rejected** | `curl "$API/feed/global?bogus=1"` | `400`. Confirms validation was not weakened. |

### Phase B — app

| # | Test | Steps | Pass |
|---|---|---|---|
| T-3.17 | **Likes render correctly** | Sign in, like 3 videos, force-quit, relaunch, scroll to them | All 3 show a filled heart on first render. |
| T-3.18 | **Handles** | Scroll 20 items | Items from users with a username show `@username`, not `@firstname`. |
| T-3.19 | **No duplicates on load-more** | Scroll to item 60. Dump `useStore.getState().videos.map(v=>v.id)` and check for repeats. Repeat while a second account publishes 3 videos mid-scroll. | Zero duplicate ids. Zero React duplicate-key warnings in the JS log. |
| T-3.20 | **Following feed loads page 2** | Follow a creator with >20 videos. Open Following. Scroll past 20. | Item 21 loads. (Today it never does.) |
| T-3.21 | **Feed still plays with server URLs** | Scroll 20 items | Every item plays. `grep` the network trace: requests go to the same host as before. |
| T-3.22 | **Guest mode** | Sign out. Open For You. | Feed loads and plays. Hearts hollow. Tapping like shows the auth modal. |
| T-3.23 | **Iteration 1 + 2 regression sweep** | Re-run T-1.2, T-1.3, T-1.5, T-2.15 | All unchanged. |

---

## 11. Success criteria

- [ ] **T-3.1 passes** — the shipped app build works against the new backend before any app release.
- [ ] `hasLiked` is `true` for a liked video when a token is sent, `false` when it is not (T-3.2, T-3.3).
- [ ] An expired token yields **200**, not 401 (T-3.6).
- [ ] Feed payload for `limit=20` is **≥ 50 % smaller** than the baseline in `00-OVERVIEW.md` (T-3.8).
- [ ] `curl` on `docs[0].videoUrl` returns **200** and plays (T-3.4).
- [ ] Setting `AWS_CLOUDFRONT_DOMAIN` changes the emitted host with no other change (T-3.4). **This is the iteration-5 gate.**
- [ ] Cursor page 2 shares **zero ids** with page 1, including when a video is published in between (T-3.9, T-3.10).
- [ ] A malformed cursor returns 200, never 500 (T-3.11).
- [ ] Guest feed latency ≤ baseline on a warmed instance (T-3.12).
- [ ] **Zero duplicate ids** in `useStore.getState().videos` after scrolling 60 items with concurrent publishing (T-3.19).
- [ ] **Zero** React duplicate-key warnings during that scroll.
- [ ] Following feed reaches item 21 (T-3.20).
- [ ] `grep -rn "countDocuments" boost-backend/src/modules/feed` returns nothing.
- [ ] `grep -rn "boostme-storage.s3" newboostraapp/src` still returns only `src/utils/media.js`, and that constant is now only a **fallback**.
- [ ] Both new indexes are present and `db.videos.explain()` on the feed query reports `IXSCAN` on `FeedGlobalKeyset`, not `COLLSCAN` or `SORT`.
- [ ] Iterations 1 and 2 regression sweep clean (T-3.23).
