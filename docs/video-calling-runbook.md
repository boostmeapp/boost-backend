# Video calling — operations runbook

For whoever is on call for 1:1 calling. Push and webhook setup live in [video-calling-push-runbook.md](video-calling-push-runbook.md); this page covers everything else.

**How it fits together:** Stream (hosted) carries the media, the signalling and the ringing push. The backend decides who may call whom, issues Stream tokens, and keeps the call records (`calls` collection). Stream reports call events back through a signed webhook, and a ring-timeout job plus a 5-minute sweeper close anything left open.

---

## Configuration per environment

Each environment has **its own Stream app**. A shared app means staging test calls ring real users' phones.

| Variable | Dev / staging | Production | Notes |
|---|---|---|---|
| `STREAM_API_KEY`, `STREAM_API_SECRET`, `STREAM_APP_ID` | dev Stream app | production Stream app | Secret in the deploy platform's secret store, never in git |
| `STREAM_PRODUCTION_APP_ID` | production app's id | production app's id | **Set in every environment.** Boot refuses a non-production backend on the production app, and production on any other app |
| `CALLING_ENABLED` | unset (on) | `false` → rollout → `true` | Defaults **off** in production |
| `CALLING_ROLLOUT_USER_IDS` | — | internal user ids, comma-separated | Can call while the flag is off |
| `STREAM_WEBHOOK_ENABLED` | `true` (`false` on a shared app) | `true` | |
| `CALL_RING_TIMEOUT_SECONDS` | 45 | 45 | |
| `CALL_MAX_PER_HOUR` | 30 | 30 | Per caller, rolling hour |
| `CALL_ANSWER_RATE_ALERT_FLOOR` | 0.4 | 0.4 | |
| `CALL_MONTHLY_PARTICIPANT_MINUTES_ALLOWANCE` | optional | **your plan's limit** | Enables the 70% usage alert |
| `STREAM_APN_PROVIDER_*`, `STREAM_FIREBASE_PROVIDER` | see push runbook | see push runbook | |

A boot failure starting `Refusing to start:` means the Stream credentials belong to the wrong app. Fix the credentials; don't remove `STREAM_PRODUCTION_APP_ID`.

## Rollout

1. Deploy with `CALLING_ENABLED` unset in production. The app gets `503 CALLING_DISABLED` from `/calls/token` and hides calling.
2. Put internal accounts in `CALLING_ROLLOUT_USER_IDS`. Only they can fetch tokens, and a user without a token is never "calling-capable", so they can only call each other.
3. Watch `GET /api/admin/calls/metrics` for a few days: answer rate, `sweeperCaught`, ratings.
4. Set `CALLING_ENABLED=true`.

**Turning it off** (`CALLING_ENABLED=false`) stops *new* calls only: tokens, `POST /calls`, `can-call`. Calls already in progress continue (Stream holds them), and they still end and record correctly. The webhook, history, settings and admin tools keep working.

## Monitoring

`GET /api/admin/calls/metrics?hours=24` (admin only):

| Field | Healthy | If not |
|---|---|---|
| `answerRate` | above ~0.5 | Push delivery broken → push runbook |
| `sweeperCaught` | ~0 | Ring-timeout queue or webhook not delivering → "Records stuck" below |
| `ringToAnswerSeconds.p95` | under ~20s | Slow wake-up on locked phones; check push priority |
| `ratings.lowShare` | under ~0.15 | Quality regression; compare `metadata.quality` on bad calls |
| `usage.share` | under 0.7 | See "Cost" |

**Alerts are log lines at error level beginning `ALERT`.** Point your log-based alerting at that prefix:
- `ALERT call answer rate …`: hourly, when at least 10 answerable calls were made and the rate is under the floor.
- `ALERT call usage at …`: daily at 09:00, at 70% of the monthly allowance.

Every status change logs one line: `call.transition callId=… from=… to=… actor=… reason=… durationMs=…`. Grep a `callId` to see a call's whole life.

## Troubleshooting

| Symptom | Check, in order |
|---|---|
| Calls don't ring on locked phones | [Push runbook](video-calling-push-runbook.md#calls-dont-ring-on-locked-phones--check-in-this-order) |
| Calls ring but don't connect | [Stream status](https://status.getstream.io/) → the client's network (corporate Wi-Fi often blocks UDP; Stream falls back to TURN/TCP) → the Stream dashboard's call stats for that call |
| Records stuck `ringing` / `active` | [Webhook section of the push runbook](video-calling-push-runbook.md#webhook-call-records-self-heal) → logs for `Ring timeout NOT scheduled` (Redis) → the sweeper's `Call sweep caught …` warnings |
| Everyone gets `CALLEE_UNSUPPORTED` | Expected until each callee opens a calling-capable build once. If they have, check `/calls/token` isn't failing for them |
| Everyone gets `CALLING_DISABLED` | `CALLING_ENABLED` is off (the production default) |
| `503 CALLING_UNAVAILABLE` | Stream credentials missing. `GET /api/health/stream?check=true` |
| A user is being harassed | `PATCH /api/admin/users/:id/calling-restricted {"restricted":true}`; end a live call with `POST /api/admin/calls/:id/terminate` |

## Admin tools

| | |
|---|---|
| `GET /api/admin/calls?userId=&status=&from=&to=` | Find calls |
| `GET /api/admin/calls/:id` | One call in full, for reviewing a `call` report |
| `POST /api/admin/calls/:id/terminate` | Force-end; harmless if already over |
| `PATCH /api/admin/users/:id/calling-restricted` | Stop a user placing calls without banning them |

## Cost

Stream counts **participant-minutes**: every started minute, for each person in the call. The backend estimates month-to-date usage from answered calls (`usage` in metrics). It's an early warning; the billed figure is in the Stream dashboard.

**The Maker plan's limit is hard: at 100%, calls stop working.** Nothing bills more. When the 70% alert fires, upgrade the plan or ask Stream for a higher limit before the month runs out. Rough scale: 1,000 ten-minute calls ≈ 20,000 participant-minutes.

## Secrets

- `STREAM_API_SECRET` lives only in the deploy platform's secret store. The git history has been audited: the value was never committed.
- **Rotating** (Stream dashboard → app → regenerate secret, then update the backend and restart):
  - Existing app tokens stop working at once. Clients refetch automatically, because their token provider calls `/calls/token` on failure. Confirm that on a device before rotating in production.
  - Webhook signatures switch to the new secret at the same moment, so deploy the new value promptly: requests signed with the old one are rejected (401) and Stream retries them.
- If the secret is ever committed, **rotate it**. Deleting the line doesn't un-leak it.

## Data retention and account deletion

- **Call records are kept indefinitely.** They're small, and they're also the other participant's history.
- **When an account is deleted** (self-service or admin), `CallAccountCleanupService`:
  1. ends that user's live calls (reason `account_deleted`)
  2. removes their per-user quality and feedback entries and history-hidden markers
  3. hard-deletes them, and the calls they own, from Stream
- The records remain with an id that no longer resolves to anyone; the other person's history shows "Deleted user".
- If a deletion request must also remove the other side's history of calls with this person, delete those `calls` documents by hand and note it in the request.

## Load

Token issuance is local HMAC signing plus one Stream user upsert; call initiation is a handful of indexed Mongo queries plus two Stream calls. At the current scale Stream isn't the bottleneck. If `/calls/token` p95 climbs past a few hundred ms under load, the Stream upsert is the first suspect, not token signing.

## Access

Record who holds these so an incident doesn't depend on one person:
- Stream dashboard (dev app, production app): `____`
- Deploy platform secrets: `____`
- Apple Developer / Firebase: see push runbook
