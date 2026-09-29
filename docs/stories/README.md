# Stories API

A story is one photo or one short clip that is live for **24 hours**. After
that it stops appearing anywhere, but the row stays in the database — expiry
flips a status, it never deletes. There is deliberately **no TTL index** on
these collections.

Code: `src/modules/stories/`, schemas in `src/database/schemas/story/`.

## Data

**`stories`** — `user`, `mediaType` (`image` | `video`), `mediaKey`,
`thumbnailKey?`, `durationSeconds?`, `music?`, `status`
(`active` | `expired` | `deleted`), `expiresAt`, `expiredAt?`, `viewCount`,
timestamps.

**`story_views`** — `story`, `viewer`, `owner`, `liked`, `likedAt`,
`createdAt`, with a **unique (story, viewer)** index. That index is the whole of the "count each viewer
once" rule, and it is built in production (`autoIndex: true`).

## Creating a story

Same two-step shape as a video post: the client uploads to S3 first, then
posts the key.

1. A clip: `POST /api/upload/presign` (`type: video`) → upload to S3.
   A photo: the existing image endpoints, e.g. `POST /api/upload/thumbnail`.
2. `POST /api/stories`

```json
{
  "mediaType": "video",
  "mediaKey": "videos/<userId>/1730000000-uuid.mp4",
  "thumbnailKey": "thumbnails/<userId>/1730000000-uuid.jpg",
  "durationSeconds": 22,
  "music": "Billie Eilish • Ocean Eyes"
}
```

Rejected when: the key is not under the caller's own prefix (403), the object
is not in S3 (400), a video reports no duration (400), or a clip is longer
than **30 seconds** (400).

## Expiry

Three layers, because the first two can each fail on their own:

1. **A delayed Bull job per story** (`stories` queue, `expire-story`), fired
   24 hours after creation. It re-reads the story and only acts while it is
   still `active` and actually past `expiresAt`, so running late or twice is
   harmless. If Redis is down the story is still created — scheduling failure
   is logged, not thrown.
2. **A sweep every 10 minutes** (`stories.cron.ts`) for anything the queue
   lost.
3. **Every read filters on `expiresAt`**, not just on `status`. So even with
   both of the above broken, an expired story is never served.

## Endpoints

All under `/api/stories`, all `JwtAuthGuard`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/` | create, from an uploaded key |
| GET | `/feed` | active stories from people you follow, grouped by author |
| GET | `/me` | your own live stories, plus `totalViews` |
| GET | `/:id` | one story, **with its author** — yours, or a live one from someone you follow |
| POST | `/:id/view` | record a view |
| GET | `/:id/viewers` | who viewed it — **owner only**, paged |
| POST | `/:id/like` | heart it, or take the heart back |
| POST | `/:id/share` | send it into one or more chats |
| POST | `/:id/reply` | reply by chat message, with the story attached |
| DELETE | `/:id` | take yours down (sets `deleted`, keeps the row) |

### Feed

Authors are exactly your following list, so an unrelated user's story can
never appear. Grouped per author, unseen authors first, then most recent:

```json
{
  "items": [
    {
      "user": { "id": "…", "name": "Amelia Clarke", "username": "amelia", "avatar": "https://cdn/…" },
      "hasUnseen": true,
      "lastPostedAt": "2026-09-29T10:02:00.000Z",
      "stories": [
        {
          "id": "…",
          "mediaType": "image",
          "url": "https://cdn/…jpg",
          "poster": null,
          "durationSeconds": null,
          "music": "Billie Eilish • Ocean Eyes",
          "viewCount": 12,
          "viewed": false,
          "createdAt": "2026-09-29T10:02:00.000Z",
          "expiresAt": "2026-09-30T10:02:00.000Z"
        }
      ]
    }
  ]
}
```

### Views

`POST /:id/view` → `{ "viewCount": 13, "counted": true }`

- Counts **once per viewer**, whatever they do afterwards — the second call
  returns `counted: false` and the unchanged count.
- The **owner's own view never counts**.
- Viewing is subject to the same visibility rule as reading: a story from
  someone you do not follow is 403, an expired one is 404.

`GET /:id/viewers` is the insights list, paged with `page` / `limit`
(default 20, max 50):

```json
{
  "items": [
    { "id": "…", "name": "Aria Vance", "username": "aria", "avatar": "https://cdn/…", "viewedAt": "…" }
  ],
  "page": 1, "limit": 20, "total": 45, "hasMore": true
}
```

## Likes

`POST /api/stories/:id/like` toggles → `{ "liked": true, "likeCount": 4, "viewCount": 12 }`.

A like always comes from someone who watched the story, so it lives on the
view row rather than in its own collection: liking a story you have not
opened records the view too. The owner cannot like their own story, for the
same reason their own view is not counted. Unliking never drops `likeCount`
below zero.

Every serialised story carries `likeCount`, `GET /:id` also carries `liked`
for the caller, and each row of the viewers list carries `liked` — which is
what the insights screen draws.

## Sharing a story to chats

`POST /api/stories/:id/share`

```json
{ "userIds": ["<id>", "<id>"], "text": "seen this?" }
```

Same plumbing as a reply — an ordinary chat message carrying the story —
addressed to whoever was picked instead of the story's owner. Up to 20
recipients, deduped, and you are dropped from your own list. **Your own
story can be shared this way**; a story you could not open cannot.

One bad recipient does not fail the whole share:

```json
{
  "owner": "<id>",
  "results": [
    { "userId": "<id>", "conversationId": "<id>", "message": { }, "sent": true },
    { "userId": "<id>", "sent": false, "reason": "You cannot start a conversation with this user." }
  ]
}
```

With no text of its own, the conversation list reads `Shared a story`
(a reply reads `Replied to a story`).

## Replying to a story

`POST /api/stories/:id/reply` with `{ "text": "nice one" }`.

This is not a separate messaging system: it goes through the existing chat
flow end to end.

1. `ChatService.getOrCreateConversation(sender, owner)` — the existing thread
   if there is one, a new one if there is not.
2. `ChatService.createMessage(...)` with the story attached, so the reply is
   an ordinary row in `messages`.
3. `ChatGateway.broadcastMessage(...)` — the same `newMessage` and
   `conversationUpdated` events a message typed in the thread produces, so
   clients need no new socket handling.

Blocking, "no chat with yourself" and the unread counters are all whatever
chat already does. The conversation preview reads `Replied to a story` when
the reply carries no text of its own.

Returns `{ conversationId, message }`.

### The story reference on a message

Messages gained one optional field, `story`, and keep `type: "text"` — a
client that knows nothing about stories still renders the reply correctly, it
just misses the preview.

```json
"story": {
  "storyId": "…",
  "owner": "…",
  "mediaType": "image",
  "url": "https://cdn/…jpg",
  "poster": null,
  "postedAt": "2026-09-29T10:02:00.000Z"
}
```

It is a **snapshot**, not a live lookup: `mediaKey` and `thumbnailKey` are
copied onto the message when the reply is sent, and the read path turns them
into URLs. So the thread still shows what was replied to after the story
expires — and since stories are never deleted, `storyId` also keeps
resolving. Replying to a story that has already expired is refused (404); it
is only the already-sent replies that live on.

## Not in this pass

Nothing outstanding for the current app screens. Not built: story
pagination in the feed (every live story from everyone you follow comes back
at once), and push notifications on a reply or share — chat sends none at
all today, so a story message behaves like any other message.
