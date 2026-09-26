# Connections API

The followers screens in the app: **Followers · Following · Suggested** on your
own profile, **Mutuals · Followers · Following** on someone else's, plus the
"Followed by Ahsan, Irshad and others" strip on a profile header.

Nothing here writes. Following and unfollowing stay on the existing
`/api/follows` routes; these endpoints only read the graph in the shape the
lists need.

Code: `src/modules/follows/connections.{controller,service}.ts`.

## Auth

`OptionalJwtAuthGuard`. A signed-in viewer gets the follow state on every row;
a guest gets the same lists with `isFollowing` and `followsYou` false, and no
mutuals (mutuals are relative to the viewer, so a guest has none).

## Endpoints

All under `/api/connections`.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/:userId/followers` | people who follow `:userId` |
| GET | `/:userId/following` | people `:userId` follows |
| GET | `/:userId/mutuals` | followers of `:userId` the viewer also follows |
| GET | `/suggested` | accounts the viewer does not follow yet, most followed first |
| GET | `/:userId/summary` | tab counts and the first three mutual faces |

### Query

| Param | Default | Notes |
| --- | --- | --- |
| `page` | `1` | 1-based |
| `limit` | `10` | max 50; ten matches the app's page size |
| `q` | – | search box; matches username, first name or last name, case-insensitive |

### List response

```json
{
  "items": [
    {
      "id": "6a912bf1cb33592cca62e4f9",
      "name": "alexbrad",
      "username": "alexbrad",
      "subtitle": "Follows you",
      "avatar": "https://cdn.../profiles/…jpg",
      "followerCount": 12,
      "isFollowing": false,
      "followsYou": true,
      "isSelf": false
    }
  ],
  "page": 1,
  "limit": 10,
  "total": 86,
  "hasMore": true
}
```

`hasMore` is what the list's load-more-on-scroll reads; ask for `page + 1`
while it is true.

`name` follows the usual rule — username, then first + last name, then
"Anonymous". `avatar` is already on the delivery host, so the client renders it
as-is.

### Summary response

```json
{
  "followers": 86,
  "following": 70,
  "mutuals": { "total": 29, "items": [ /* first three rows */ ] }
}
```

`mutuals` is empty on your own profile.

## Notes

- Banned and deactivated accounts are filtered out of every list.
- Suggested also drops the viewer, everyone they already follow, and anyone
  they have blocked.
- The follow flags are two queries per page over the page's ids, not one per
  row, so a page costs the same whatever its size.
- Ordering: followers/following/mutuals newest follow first; suggested by
  follower count, with `_id` as a tiebreak so paging is stable.
