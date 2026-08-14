# Developer tools — operations that change things

`/api/internal/admin/dev-tools/*` · service-token only (`requireAdminCaller`) · **no public twin,
deliberately**

Every route here re-runs a side effect against live data or refuses traffic. On the wi-admin side
each is behind a `destructive`, tier-1-only `developer_tools.*` permission, the `dev_tools.enabled`
feature flag (off by default), and an audit row.

The read-only half is [`system.md`](./system.md). The split is a mount, not a convention.

> The first four tools shipped in Phase 12 and were never documented; this file retro-documents
> them alongside the two Phase 14 additions and the one Phase 15 addition (`outbox/prune`).
>
> **Every** manual run from `POST /workers/:workerKey/run` now records
> `jovimall_worker_runs_total` / `_duration_seconds` / `_last_success_timestamp_seconds`. Those
> instruments were declared in Phase 14 and incremented by *nothing* until Phase 15. On the
> **scheduled** path only four workers are instrumented so far — `tracking-dispatch`,
> `assignment-sweep`, `earnings-release` and `analytics-aggregation`; see `system.md`'s coverage
> caveat.

---

## `GET /workers`

The compatibility read. Shape frozen — wi-admin calls it from two places
(`SystemController.workers` and `DevToolsController.listWorkers`) and jovi-mall deploys first, so
changing it here would open a window where wi-admin's own `/api/v1/system/workers` breaks.

```jsonc
{ "success": true, "data": {
    "workers": [ { "key": "plan-expiry", "label": "Plan expiry",
                   "schedule": "daily at 03:00", "running": false } ],
    "runningIsProcessLocal": true } }
```

Two fields became strictly more truthful at an unchanged shape, which needed no coordination:
`schedule` is now **derived** from what the worker actually schedules with (the hand-typed strings
were wrong for eight of ten workers), and `running` is now `executing || manualClaim` rather than
manual claims alone.

Use [`GET /system/workers`](./system.md#get-workers) for the full picture — all **thirteen**
workers, three distinct booleans, structured schedules, `enabled`, `pausedByMaintenance`.

> **The array grew in Phase 15 and the SHAPE did not.** `analytics-aggregation` was the
> platform's thirteenth scheduled job and was invisible to every surface: it called
> `cron.schedule` and discarded the task handle, so it had no inventory entry, no `stop()`, a
> hardcoded schedule, and — the part nobody had noticed — **no `maintenanceBlocksWorkers()`
> guard**, meaning a full-table sweep over every active vendor ran happily inside a `down`
> window. It is now an `ObservableWorker` like the rest and is triggerable, so this endpoint
> returns **12** triggerable workers where it returned 11. Frozen means the field set, not the
> length.

---

## `POST /workers/:workerKey/run`

One pass, now, against live data. Awaited rather than fired and forgotten, so the response reports
what happened — some of these sweeps are slow, and that is the caller's problem to time out on; a
202 would give an administrator no way to know whether it worked.

- `404 DEV_TOOLS_WORKER_UNKNOWN` — `details.known` lists the valid keys
- `409 DEV_TOOLS_WORKER_BUSY` — already claimed **on this instance**

The response carries **`ran`**:

```jsonc
{ "worker": "earnings-release", "durationMs": 8421, "ran": true,
  "note": "Matured earnings released; missed splits recovered" }

{ "worker": "earnings-release", "durationMs": 4, "ran": false,
  "note": "Not run — this sweep was already in progress, here or on another instance. Nothing was changed. Try again once it finishes." }
```

> ⚠ **`409 DEV_TOOLS_WORKER_BUSY` is in-process only, and it is no longer the safety mechanism.**
> With several instances behind a load balancer two administrators hitting two instances both pass
> that check — but the second run is then refused by the shared overlap lock inside the worker
> (F-19, `src/core/jobs/worker-lock.ts`), and comes back `200` with **`ran: false`**. Two different
> answers for two different questions: the 409 says *this instance is already doing it for someone*,
> `ran: false` says *the sweep is running somewhere and yours did nothing*.
>
> A refused trigger is **not** recorded as a success, so it cannot advance
> `worker_last_success_timestamp_seconds` and mute the staleness alert for a worker that has not
> actually run.

**A manual run still works during a maintenance window, but it cannot force an overlap.** The two
guards sit in deliberately different places: the maintenance pause is at each worker's *tick site*,
so an operator can override it — that is the point of this surface. The overlap lock is *inside*
the sweep, where a manual trigger cannot route around it. Maintenance is a policy an operator may
override; overlap is a correctness constraint, and an operator's intent does not make two
concurrent writes to the same earnings row safe.

Twelve keys are triggerable — `plan-expiry`, `agency-shipment-cap`, `file-cleanup`,
`earnings-release`, `unpaid-order-cancel`, `unpaid-booking-cancel`, `booking-reminder`,
`cod-deposit-deadline`, `tracking-dispatch`, `agent-capacity-reconcile`, `assignment-sweep`,
`analytics-aggregation`. `inbound-calendar-sync` is not: its work splits across two horizons
behind private methods with per-instance state, so "run it once" has no single honest meaning. It
still appears in `GET /system/workers` with the reason on the wire, because not being able to *see*
a worker is a different problem from not being able to *run* it.

---

## `POST /outbox/replay`

Puts **`failed`** tracking-outbox rows back to `pending` for the dispatcher's next drain.

```jsonc
{ "limit": 100, "eventIds": ["…"] }   // limit default 100, max 1000
```

Only `failed` rows are eligible. Replaying a `sent` row would deliver a lifecycle event to
geo-tracker a second time — it dedups on `eventId`, so it would be absorbed, but relying on the far
side's dedup to make a local mistake harmless is not a design.

`attempts` is reset so the dispatcher's backoff starts fresh: a row replayed deliberately should not
be immediately re-failed by an exhausted counter.

Find the candidates with [`GET /system/queues`](./system.md#get-queues) → `trackingOutbox.exhausted`.

---

## `POST /catalogue/vectorise`

Rebuilds search vectors across every product. The one legacy developer tool that already existed
(`POST /api/admin/products/bulk-vectorise`); same controller, so there is one implementation rather
than a copy that drifts.

---

## `PUT /maintenance` — Phase 14

Opens or closes a maintenance window. **The most dangerous verb on this router**, because it is the
only one whose failure mode is losing the ability to undo it.

```jsonc
{ "mode": "off" | "readonly" | "down",
  "reason": "…",              // required unless mode is "off"; min 8 chars
  "expiresInMinutes": 30,     // optional, 1..1440
  "blockWebhooks": false,     // optional; defaults false
  "pauseWorkers": true }      // optional; defaults to (mode === "down")
```

Response carries `changed`, `previousMode`, the resulting state, and **`convergenceSeconds`** —
stated rather than discovered, because other instances read the singleton through a short cache and
there is a real window in which they disagree. Idempotent: re-issuing the current mode returns
`changed: false` and does not restart the window's clock.

### Modes

| mode | refuses |
|---|---|
| `off` | nothing |
| `readonly` | `POST` / `PUT` / `PATCH` / `DELETE` on the public API |
| `down` | everything on the public API |

### The exemption list

Every entry is here because blocking it converts a maintenance window into an outage, and in two
cases into somebody else's outage. **Exempt in every mode:**

1. **`/api/internal/admin/*`** — the whole prefix. This is the door the operator uses to turn
   maintenance **off**, and they also need `/system/*` to decide when to exit. Blocking it is a
   self-inflicted lockout recoverable only by a redeploy or a hand-written Mongo update.
2. **`/api/internal/agents/*`** — geo-tracker's authorization door, and the one a naive
   implementation gets wrong. It is a **read-only verdict**; nothing about it writes. Block it and
   geo-tracker cannot answer "may this viewer track this agent", so every live subscription fails
   authorization and every watcher is dropped. A jovi-mall maintenance window becomes a geo-tracker
   outage.
3. **`/api/tracking/*`** — same family, read-only, same reason.
4. **`/api/health*`** — a probe must always answer. If readiness 503s during a window, the
   orchestrator kills the instances and the window becomes an outage nobody can exit. Corollary:
   **`/api/health/ready` returns 200 during maintenance**, reporting the mode in its body. Draining
   traffic is a load-balancer action, not a maintenance-mode side effect.
5. **`/metrics`** — telemetry matters most during the incident.

**Not exempt: `/api/admin/*`.** The legacy public admin surface is guarded by `requireRole(['admin'])`
on a platform `users` row. An admin with a users row is still a user; the operator's door is
`/api/internal/admin/*`.

Prefix matching is on **segment boundaries**, so naming a route `/api/healthcheck-bypass` does not
exempt it.

### Gateway webhooks — a trade, not a rule

`/api/webhooks/*` is **exempt by default in both modes**, overridable per window with
`blockWebhooks: true`.

- "Gateways retry" is *true* for Stripe (3 days, exponential backoff) and *assumed* for the mobile-
  money providers. Betting money on an assumption about a regional PSP's retry policy is the bad
  half of the trade.
- A dropped payment event is not "the order stays unpaid". This service's payment path grants
  digital entitlements, opens escrow holds, mints shipments and fires four notification stacks. A
  missed success event is a customer who has been charged and has nothing.
- The counter-argument is real — a webhook is a write, and `readonly` exists to stop writes. The
  resolution: webhook writes are narrow and **idempotent by construction**, keyed off a gateway
  reference and already re-entrant because gateways send duplicates anyway. They are the one write
  class safe to leave open in a way that `POST /customer/orders` is not.
- **Residual risk, plainly:** if the window exists *because of* a migration on orders or payments,
  an open webhook path writes into the collection being migrated. That is what `blockWebhooks` is
  for — the operator running that migration sets it and accepts the retry queue.

`/api/digital/download/:token` is exempt in `readonly` and blocked in `down`: its "write" is burning
a single-use token, exactly the thing that must not be lost mid-download.

### Workers

`pauseWorkers` defaults to `mode === 'down'`. **`readonly` deliberately does not pause them**: a
read-only window usually means a schema change on one collection, and the sweeps are the platform's
correctness machinery — pausing `tracking-dispatch` leaves geo-tracker broadcasting a delivered
shipment's position, and pausing `unpaid-booking-cancel` holds slots for free. Pausing them there is
worse than letting them run.

### Two properties that keep the exit open

- **State lives in Mongo**, not Redis. Redis converges instantly, but this service connects to it
  lazily and its persistence is not guaranteed here — a Redis restart would **silently drop
  maintenance mode**, reopening the platform for writes mid-migration with nobody told. Mongo is
  already a hard dependency, so it adds no new failure mode.
- **Every unknown fails OPEN.** An unrecognised mode, a corrupt document, an elapsed expiry — all
  resolve to `off`. The failure mode of failing *closed* here is a platform that is down and whose
  own operator door may be part of what is down.
- On the wi-admin side this one tool **bypasses the `dev_tools.enabled` flag**, unlike every other
  tool there. Otherwise an operator could not enter maintenance during an incident without first
  turning that flag on — and worse, somebody turning it off mid-window would lock the exit. Same
  carve-out as the feature-flag routes themselves, for the same reason: a switch must not be able to
  turn off its own switch.

Refused requests get `503 SYSTEM_MAINTENANCE_ACTIVE` with a `Retry-After` header when the window has
a known end, and `details: { mode, reason, startedAt, expiresAt }`.

---

## `POST /cache/flush` — Phase 14

Deletes cached keys from **one named logical Redis database**.

```jsonc
{ "db": "SLOT_LOCK_DB",   // a NAME, never an index
  "prefix": "slot:",      // optional; mandatory on destructive databases
  "limit": 1000,          // 1..10000
  "dryRun": true,         // DEFAULT TRUE
  "confirm": "SLOT_LOCK_DB" }  // must repeat `db` exactly
```

Response: `{ matched, deleted, truncated, cursor, sample, blastRadius, destructive }`.

### The guards, and what each one prevents

- **Named, never indexed.** A numeric field invites `0`, and a typo turning `7` into `8` silently
  flushes live download links instead of booking holds. A misspelt name is a 404.
- **`confirm` must repeat the name.** The standard "type it out" guard; it also makes a replayed or
  half-built request fail closed.
- **`dryRun` defaults to true**, mirroring `FILE_CLEANUP_DRY_RUN`. A dry run returns the match count
  and a capped key **name** sample — values are never read.
- **SCAN, never KEYS.** `KEYS` is O(n) over the whole keyspace and blocks the Redis event loop for
  the duration — taking bookings, verification codes and download links down with it, in the middle
  of whatever incident prompted the flush.
- **Bounded twice**, by key limit and by wall clock (`CACHE_FLUSH_BUDGET_MS`). `truncated` and
  `cursor` are always returned: silent truncation reads as "done" when it means "some of it".
- **The prefix is a literal.** Glob metacharacters are escaped and *we* append the `*`. Otherwise
  `prefix: "*"` is a whole-database flush wearing a prefix's clothes — refused explicitly rather
  than escaped into a literal asterisk, which would return zero matches and look like success.
- **No whole-instance flush.** `FLUSHALL` appears nowhere in the path, and `db: 0` is refused
  outright — nothing in this codebase uses database 0.
- **No `SELECT`, ever.** The factory pins the database at client creation, so a `SELECT` bug cannot
  cross databases.

### Blast radius per database

| DB | Constant | Whole-DB | What is lost |
|---|---|---|---|
| 3 | `EMAIL_VERIFY_DB` | yes | In-flight verification links. Users request a new one. Low. |
| 4 | `WA_VERIFY_DB` | yes | In-flight WhatsApp codes. Users request a new one. Low. |
| 5 | `WA_IDEMPOTENCY_DB` | **prefix only** | **DESTRUCTIVE.** These keys are the only thing stopping a retried send from becoming a **second WhatsApp message to a real person**. Reopens a duplicate-send window for the remainder of each key's TTL (24–72h). |
| 6 | `WA_WINDOW_DB` | yes | Service-window state, recomputed on next inbound. Worst case a paid template where free-form would have done — low, but it costs money. |
| 7 | `SLOT_LOCK_DB` | **prefix only** | **DESTRUCTIVE.** Drops live booking holds. **Degraded, not broken:** the actual double-sale guard is `createBooking`'s in-transaction overlap re-check, so what is lost is the reservation *courtesy* — two customers can reach checkout for the same slot and the second loses at commit — not the single-occupancy invariant. |
| 8 | `DOWNLOAD_TOKEN_DB` | **prefix only** | **DESTRUCTIVE.** Invalidates every live download link. A paying customer mid-download gets a dead URL and must re-mint from their library. |
| 9 | `TELEGRAM_LINK_TOKEN_DB` | yes | In-flight linking tokens. Users restart linking. Low. |
| 10 | `TELEGRAM_WINDOW_DB` | yes | Per-chat send-window state. Low. |

The three destructive rows require a prefix, so with `confirm` and `dryRun` they are effectively a
two-step. The blast-radius note is echoed in every response, so it travels into wi-admin's audit row
and reaches whoever reads the trail afterwards.

`npm run test:system` asserts that **every catalogued Redis database has a policy row** — a database
added to the factory without one fails the suite rather than becoming silently unflushable.

### Errors

| Code | Status | When |
|---|---|---|
| `DEV_TOOLS_CACHE_DB_UNKNOWN` | 404 | No database by that name |
| `DEV_TOOLS_CACHE_FLUSH_REFUSED` | 422 | Whole-DB on a destructive database, `confirm` mismatch, or `prefix: "*"` |
| `DEV_TOOLS_CACHE_UNAVAILABLE` | 503 | Redis unreachable from this process |

---

## `POST /outbox/prune` — Phase 15

Deletes **delivered** tracking-outbox rows past a retention age. The phase's one new dangerous
verb, closing a debt ADR-014 named: `sent` rows were never pruned, and the collection's only index
is `{status, created_at}` — so every scan over it, the dispatcher's own drain every two seconds
included, gets slower with age, forever.

```jsonc
{ "olderThanDays": 30,   // min 7, max 365
  "status": "sent",      // the ONLY accepted value
  "limit": 10000,        // 1..50000
  "dryRun": true,        // DEFAULT TRUE
  "confirm": "30" }      // must repeat olderThanDays
```

Response: `{ status, olderThanDays, cutoff, dryRun, matched, deleted, truncated, oldestRemainingSentAt }`.

### The guards, and what each one prevents

- **`status` is a literal, not an enum.** Pruning `failed` rows destroys the evidence
  [`outbox/replay`](#post-outboxreplay) exists to act on — the operator would delete the backlog
  they were about to retry. Pruning `pending` destroys undelivered events outright: geo-tracker
  would never learn a shipment completed, and its tracking session would stay open forever.
  Neither is a variant of this operation. A field that *could* take another value is a field
  somebody eventually passes another value to.
- **A hard 7-day floor**, not configurable. A `sent` row younger than the dispatcher's own retry
  horizon is not safely disposable, and a week of delivery history is the minimum an
  investigation into "did geo-tracker get this event" needs. Making it an environment variable
  would let the one guard bounding the blast radius be turned down to zero by configuration.
- **`confirm` repeats the AGE**, not a magic word. The cache flush's `confirm` repeats a database
  name because the database decides that operation's blast radius; here the age is the only
  variable that does. `confirm: "sent"` would be typed reflexively and confirm nothing.
- **`dryRun` defaults true**, exactly as the cache flush does.
- **Bounded delete.** Find-then-`deleteMany({_id: {$in}})`, never an unbounded
  `deleteMany({created_at: {$lt}})` — a single unbounded delete over millions of rows on a primary
  is an availability event. `truncated` tells the operator to run it again rather than guess.
- **`oldestRemainingSentAt`** is returned so "is another pass worth it" does not require
  re-deriving the cutoff by hand.

`422 DEV_TOOLS_OUTBOX_PRUNE_REFUSED` carries `details.code` — one of `status_not_prunable`,
`age_below_floor`, `age_above_ceiling`, `confirmation_mismatch`.

---

## Errata — `cache/flush`'s unknown-database status

The table above lists `404 DEV_TOOLS_CACHE_DB_UNKNOWN` for an unrecognised database name. In
practice `FlushCacheSchema.db` is a `z.enum` over the catalogued names, so an unknown one is
rejected by validation first and the caller sees **`400 VALIDATION_ERROR`**. The 404 remains
reachable only if the policy layer is called without that schema in front of it — defence in
depth, not the live path. The same is true of `GET /system/cache/keys`.

Recorded rather than silently corrected, because the two documented codes are what a dashboard
branches on.

---

## There is deliberately no `webhooks/redeliver`

Every `/webhooks/*` mount in this service is **inbound** (payments, WhatsApp, Telegram) and nothing
records an outbound delivery, so there is no subject. The only outbound mechanism is the tracking
outbox, which `outbox/replay` covers. The `developer_tools.webhooks.redeliver` permission stays in
wi-admin's catalog naming its missing prerequisite; writing an endpoint for it would be worse than
the gap.
