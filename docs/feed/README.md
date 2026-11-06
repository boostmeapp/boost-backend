# Home feeds

- `GET /feed/global`: All (existing global feed, including campaign slots for signed-in viewers).
- `GET /feed/following`: authenticated viewer's followed creators.
- `GET /feed/boosted`: public discovery feed containing only boosted videos with an active campaign that has started, has not expired, and has views remaining. Paused, cancelled, completed and expired campaigns are excluded immediately, without waiting for the cleanup job. No organic fallback.

All endpoints accept `limit` (default 20, max 50), `page` (default 1), and `cursor` (overrides page). Boosted uses the existing newest-first video paginator, with `_id` as the timestamp tie breaker, and the same `docs`, `nextCursor` and pagination fields. It filters removed/unready videos and the signed-in viewer's blocked authors, and returns viewer like status and public media URLs. A video's boost flag alone is insufficient: a current active campaign must also exist.

Boosted Feed is a browsing surface, available to guests and signed-in users. It does not apply the targeted paid-slot delivery selector or its frequency caps. Existing qualified-view reporting still checks campaign targeting, viewer identity, blocks and deduplication before crediting campaign delivery; viewing a feed page alone does not count as a qualified view.

Deploy the backend endpoint before releasing the mobile tab. No migration or authentication changes are required. In the app, verify tab switching (including during an in-flight request), refresh, pagination, returning from full-screen playback, empty campaigns, guests, and paused/cancelled campaigns. The selected tab is kept alongside the in-memory cached feed, but is not persisted across app restarts.
