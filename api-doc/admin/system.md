# System operations — read-only diagnostics

`/api/internal/admin/system/*` · service-token only (`requireAdminCaller`) · **every route is a GET**

The operator surface wi-admin renders at `/api/v1/system/*`. Nothing here changes anything, so
nothing here is audited — the ordinary rule for reads.

The dangerous half lives next door at [`dev-tools.md`](./dev-tools.md): triggering a worker,
replaying the outbox, rebuilding search vectors, opening a maintenance window, flushing a cache
database. **That separation is a mount, not a convention.** A mutation added to the system router
would silently inherit the read surface's permissions and skip the audit trail, so don't.

> **Why these are delegated rather than read out of `jovi_mall` directly.**
> ADR-009 D-1 — delegate a verdict, read a record. Every answer here is a verdict about *this
> process*: which cron tasks exist and whether one is mid-sweep, which Redis connections are open
> right now, what a private in-memory metrics registry holds, which maintenance mode is in force
> after expiry is applied. None of it is in a collection, and a copy of the logic in wi-admin
> would be a second opinion about this process's own state.

---

## The rule every read here obeys

> **A diagnostics read never causes a side effect a customer would see, costs money, or consumes
> a quota that a real request needs.**

Two corollaries run through the whole surface and explain most of its shape:

**A probe observes; it does not provision.** Redis connects lazily in this service and never at
boot. Every read here goes through `peekRedisClient`, which returns an already-open client or
null — so a database this process has not needed reports `idle`, not `down`, and the endpoint does
not create the connection it is reporting on. The one deliberate exception is the cache *flush*,
which is a write and may connect; the asymmetry is documented on both accessors in
`infra/redis/redis.factory.ts`.

**Configured and reachable are different columns.** Conflating them produces the worst possible
answer — "WhatsApp: unknown" — which an operator reads as "WhatsApp is broken" when it means "we
chose not to ask".

---

## `GET /dependencies`

Mongo and Redis as this process actually sees them. Both probes run under `Promise.allSettled` with
a per-probe timeout (`HEALTH_PROBE_TIMEOUT_MS`, default 1500ms), so a hung dependency degrades its
own row rather than hanging the response.

```jsonc
{
  "success": true,
  "data": {
    "mongo": {
      "status": "up",                    // up | down | unknown
      "readyState": "connected",         // never read anywhere in this repo before Phase 14
      "database": "jovi_mall",
      "host": "localhost:27017",
      "latencyMs": 3,
      "error": null,
      "server": {
        "available": true,               // ⚠ see below
        "reason": null,
        "replicaSet": "rs0",
        "connections": { "current": 12, "available": 838, "totalCreated": 240 },
        "maxPoolSize": 100
      }
    },
    "redis": {
      "entries": [
        { "db": 3, "constant": "EMAIL_VERIFY_DB", "label": "Email verification tokens",
          "status": "idle", "everOpened": false, "latencyMs": null, "connectionErrors": 0, "error": null },
        { "db": 7, "constant": "SLOT_LOCK_DB", "label": "Booking slot holds",
          "status": "up", "everOpened": true, "latencyMs": 1, "connectionErrors": 0, "error": null }
      ],
      "note": "Connections are lazy — \"idle\" means this process has not needed that database, not that it is down."
    },
    "maintenance": { "storedMode": "off", "effectiveMode": "off", "reason": null, "expiresAt": null }
  }
}
```

> ⚠ **`server.available: false` is normal on managed Mongo.** `serverStatus` requires the
> `clusterMonitor` role, which Atlas shared tiers do not grant. The reason is reported and the
> endpoint still returns 200 — it does not 500, and it does not invent pool numbers Mongoose
> does not expose.

---

## `GET /integrations`

Query: `?probe=smtp,telegram` — runs the on-demand probes for this request only.

Each integration reports `configured` (a free config predicate) and `reachability` (with the mode
that produced it). Four modes:

| mode | meaning |
|---|---|
| `probed` | checked on this request against a real health path — cheap and side-effect free |
| `on_demand` | safe but not free; only checked when named in `?probe=` |
| `passive` | never checked. Reports what **real traffic** last learned |
| `never` | no safe probe exists. Configuration only, and the note says why |

Passive reachability is the interesting one: the platform calls these providers constantly in the
course of ordinary work, and every one of those calls already knows whether it succeeded. So
instead of asking, we remember — an operator gets "Stripe: ok, 40 seconds ago" at zero cost and
with no side effect, which is better than a probe could have told them.

| Provider | Reachability | Why |
|---|---|---|
| geo-tracker (+ routing) | `probed` | `GET /healthz`, unauthenticated and dependency-free |
| Storage (local) | `probed` | `fs.access(root, W_OK)` — asks the kernel, creates nothing. Cloudinary/Firebase are config-only |
| SMTP | `on_demand` | `transporter.verify()` does EHLO/AUTH and sends nothing. Off the default read because it costs a TCP+TLS handshake and some providers rate-limit auth attempts. **It is called nowhere else in this repo** — a broken SMTP config used to surface on a customer's verification email |
| Telegram | `on_demand` | `getMe` is cheap but authenticates the bot; not on every page-load |
| Geocoding | `passive` | Nominatim's usage policy is ~1 req/s with bans for abuse. An operator dashboard must not spend that budget |
| Vectoriser | `passive` | Third party, no documented health path |
| Stripe | `never` | A probe is an authenticated call against a live merchant account — it consumes rate limit and appears in the gateway's logs. **The key prefix is reported instead** (`mode: "live" \| "test"`): the operationally useful fact, and it leaks nothing |
| WhatsApp | `never` | Sending is a message to a real person and costs money |
| FCM | `never` | A probe mints an OAuth token against Google |
| Google Calendar | `never` | No service-level probe exists — authorization is per vendor. Reports two free Mongo counts instead: connected vendors, and vendors whose token last failed to refresh |
| NotchPay / MyCoolPay | `never` | **Not implemented** — see below |

> ⚠ **NotchPay and MyCoolPay report `configured: false` even with an API key set, and that is
> deliberate.** Both gateways are placeholders: `callNotchPayAPI` / `callMyCoolPayAPI` contain a
> commented-out `fetch` and end in a throw. Unkeyed they return a **mock success**, so a checkout
> appears to start and hands the customer a fake USSD code while no money moves; keyed, every call
> throws. `configured` has to mean "this payment path works", because that is what an operator
> reads it as. They are also deliberately **not** wired to the passive-observation recorder —
> recording a mock as a successful call would make this page vouch for a payment path that does
> not exist.

---

## `GET /queues`

Two queues, and the second is the one nothing reported before.

**`trackingOutbox`** — `byStatus`, `oldestPendingAt` + age, `byType`, and two counters worth
knowing apart:

- `stuckPending` — pending **and** already out of attempts. Should always be `0`; non-zero means
  the dispatcher's parking logic did not run, which is a different fault from a backlog.
- `exhausted` — failed and out of attempts. These need `POST /dev-tools/outbox/replay`.

`dispatcherEnabled: false` means `GEO_TRACKER_BASE_URL` is unset — the outbox fills and nothing
drains it, which is the intended local default rather than a fault.

**`assignment`** — `dueSessions` is the number that matters. `AssignmentSweepWorker` is the only
thing that advances an auto-assignment session and the only thing that expires a manual offer; if
it stops, nothing throws and nothing logs, and shipments simply sit on offer forever. A sustained
non-zero `dueSessions` means the sweep is dead, wedged, or slower than its own interval.

> **This endpoint sits beside `GET /api/v1/system/outbox`, which does not replace it and is not
> replaced by it.** That one reads `tracking_outbox` **directly** out of `jovi_mall`; this one is
> delegated. During a jovi-mall incident — exactly when an operator wants queue depth — the
> delegated read is the one that returns 503 and the direct read still answers. The redundancy is
> the feature.

---

## `GET /cache`

> ⚠ **Redis does not track hits and misses per logical database.** `keyspace_hits`,
> `keyspace_misses`, `used_memory`, `maxmemory` and `evicted_keys` are **instance-wide**; only
> `INFO keyspace` breaks down per database, and it reports key counts and TTLs, not hit rate.

So the response is explicitly two-scoped, with the scope stated on the wire. The obvious shape —
one row per database with a hit rate on it — would be a lie in eight places, and an operator would
"discover" that the booking slot-lock database has a 40% hit rate and go hunting a caching bug that
does not exist.

A pleasant consequence: one `INFO` call on any single open client answers everything, so there is
no per-database command loop and no need to open a client per database. With **no** client open,
this returns `available: false` with a reason rather than connecting.

`hitRate` is `null` rather than `1` on an instance with zero lookups — a ratio over zero is not a
number, and rendering 100% would be actively misleading.

---

## `GET /workers`

All twelve workers, with **three distinct booleans** rather than one:

| field | means |
|---|---|
| `scheduled` | a cron task or timer object exists — `start()` ran and `stop()` did not |
| `executing` | a pass is in flight right now, whoever started it |
| `manualClaim` | a `POST /dev-tools/workers/:key/run` currently holds the claim |

There are three because **three different things in this codebase were all called `running`**, and
the one the old endpoint reported was the least useful of them: it tracked manual triggers only, so
a scheduled sweep churning away for ten minutes reported `running: false`.

Other fields worth knowing:

- **`schedules`** is derived from the value the worker actually schedules with, and
  `scheduleLabel` renders it. The old hand-typed strings were **wrong for eight of ten workers**;
  `npm run test:system` now asserts the reported expression is identical to the worker's own, so a
  literal retyped into the registry fails the suite rather than misleading an operator.
- **`enabled`** is the config master switch, reported separately. Without it a dispatcher turned
  off by an unset `GEO_TRACKER_BASE_URL` reads identically to a running one.
- **`triggerable`** / `notTriggerableReason` — `inbound-calendar-sync` is observable but not
  runnable, because its work splits across two horizons with per-instance state and "run it once"
  has no single honest meaning.
- **`pausedByMaintenance`** — without it, an operator in a `down` window sees
  `scheduled: true, executing: false` forever and concludes the worker is broken.

> ⚠ **All three booleans are PROCESS-LOCAL** (`scopeNote` says so on the wire). With several
> instances behind a load balancer this describes the one that answered.

> ⚠ **`executing` on the seven cron workers is an observation, not a guard.** Those workers have
> no overlap protection at all — `cron.schedule` fires `void this.runSweep()` and a slow sweep can
> overlap its own next tick. This phase makes that condition *visible*; making it *impossible*
> changes scheduling behaviour on seven live sweeps and is deliberately a separate decision.

`GET /dev-tools/workers` still exists with its original shape for compatibility (wi-admin calls it
from two places). Its `schedule` is now accurate and its `running` is now `executing || manualClaim`
— both strictly more truthful at an unchanged shape.

---

## `GET /metrics`

The JSON projection of the private Prometheus registry — the same registry `/metrics` (text) serves.
One source of truth, two renderings.

```jsonc
{ "collectedAt": "…", "registrySize": 31,
  "metrics": [ { "name": "jovimall_http_requests_total", "help": "…", "type": "counter",
                 "values": [ { "labels": { "method": "GET", "route_group": "/api/products",
                                           "status_class": "2xx" }, "value": 4821 } ] } ] }
```

The projection is **explicit**, not prom-client's raw `getMetricsAsJSON()`. That shape is an
internal detail of a dependency; pinning it here keeps adding or renaming an instrument a one-repo
change instead of a two-repo dashboard break.

### Label cardinality

`route_group`, never `route`. `status_class`, never `status`. **Never** a user, role, vendor or
order id.

The normaliser collapses ObjectId / UUID / numeric / long-opaque segments to `:id`, truncates to
four segments, and then **looks the result up in a closed allowlist built from the mount table** —
anything absent returns `other`. That last step is what makes the label space bounded rather than
probably bounded: prom-client enforces no per-metric cardinality cap, so the allowlist *is* the cap.
`test:system` proves it by fuzzing a thousand adversarial paths.

`event_type` is bounded the same way but by a different mechanism: by **subscription**. The set of
event types something actually handles is finite and fixed at boot and cannot be grown by a caller;
a published event nobody handles collapses to `unhandled`, which is itself a useful signal.

### Coverage caveats, stated rather than discovered

- `jovimall_redis_operation_errors_total` counts **connection-level** errors only. Redis command
  errors are thrown to their caller and never reach the client's `error` event.
- `jovimall_mongo_operation_errors_total` covers **connection-level errors only** —
  `mongoose.connection.on('error')` and `on('disconnected')`, wired in Phase 15. **Query errors
  are NOT counted.**

  > ⚠ **Correction.** Until Phase 15 this section claimed the counter also covered "query errors
  > caught by a schema-level post-hook". No such hook existed anywhere in `src/`, and
  > `recordMongoError` had zero call sites — so the counter was not under-reporting, it was
  > **permanently zero** while this document warned only of partial coverage. That is worse than
  > the failure mode the paragraph below was written to prevent. Counting the query-level half
  > needs a global Mongoose plugin registered before the first `model()` call, which is a
  > bootstrap-ordering change across 182 models; it is a named debt in ADR-015, not done here.

- `jovimall_worker_*` — **four of thirteen workers are instrumented**: every manual
  `POST /dev-tools/workers/:key/run`, plus `tracking-dispatch`, `assignment-sweep` and
  `earnings-release` on their scheduled path. Those three are the ones whose silent stall is most
  expensive (a delivered shipment still broadcasting, shipments sitting on offer forever, and
  money not released). The other nine report nothing yet, so
  `time() - jovimall_worker_last_success_timestamp_seconds > 86400` is a valid alert **for the
  instrumented workers only**. These five instruments were declared in Phase 14 and incremented by
  nothing at all until Phase 15.

A counter that silently under-reports is worse than no counter, because somebody will read zero as
"no errors".

---

## `GET /maintenance`

Reports `storedMode` **and** `effectiveMode` separately. They differ exactly when a window has
passed its `expires_at`: the document still says `down` because a read path must never write, and
the platform is already open. Showing only one would make that either invisible or inexplicable.

See [`dev-tools.md`](./dev-tools.md) for the write path, the mode semantics and the full exemption
list.

---

---

## `GET /config` — Phase 15

The runtime configuration, **from a whitelist**. ADR-014 named this as its natural follow-up and
named the reason it was not free: the `FORBIDDEN_CONFIG_TOKEN` discipline had to be reproduced
here rather than assumed.

```jsonc
{ "success": true, "data": {
    "service": "jovi-mall",
    "entries": [ { "key": "NODE_ENV", "value": "production", "set": true },
                 { "key": "EARNINGS_CRON", "value": null,    "set": false } ],
    "wiring": { "geoTrackerConfigured": true, "storageProvider": "local",
                "geoProvider": "nominatim", "fcmConfigured": true, "stripeKeyMode": "test" } } }
```

**Built by naming keys, never by spreading `process.env`.** The obvious implementation — return
everything and delete the secrets — is open by default: the day somebody adds a `*_API_KEY` to a
config module it appears here without anyone touching the whitelist. This service reads 144
distinct environment variables, at least 28 of which are credentials.

`assertExposedConfigSafe()` runs at **boot**, beside `assertSigningSecrets()`, and refuses to
start if the whitelist names anything credential-shaped — belt-and-braces on a list that gets
edited by hand under time pressure.

### `set: false` is not the same as "no value"

There is no central validated config object in this service; almost every key has a compiled-in
default applied by its own `*.config.ts`. A bare `null` would read as "this sweep has no
schedule" when it means "the default applies". So the two reads are complementary:
**`/config` says what has been configured, `/system/workers` says what is in force.**

### What is deliberately absent

- **Every `*_URL` and `*_URI`.** `MONGO_URI` and `REDIS_URL` carry a password in userinfo in any
  real deployment, and `GEO_TRACKER_BASE_URL` is internal topology. The gap that would leave —
  "is the dispatcher pointed at anything" — is filled by **deriving** the answer into `wiring`
  rather than by weakening the rule. Every field there is a Phase-14 predicate that cannot carry
  a password by construction, plus the Stripe key MODE that ADR-014 D-2 already decided is the
  useful, leak-free fact.
- **`SMTP_USER`** — and this one is the point. It matches no forbidden token and no sensitive
  leaf name, yet it is half a credential. Its absence is a human decision, which is the honest
  demonstration that **the whitelist is the control and the regex is only the backstop**.
  `SMTP_HOST`/`SMTP_PORT` are out for a second-order reason: they are not sensitive, but listing
  them puts an obvious blank next to `SMTP_USER` and invites the next author to complete the set.

---

## `GET /logs` — Phase 15

Recent log lines, from the in-memory ring buffer or the capped collection.

| param | shape | note |
|---|---|---|
| `level` | `trace…fatal` | at-or-above, never equal-to |
| `since` / `until` | ISO-8601 | half-open `[since, until)` |
| `requestId` | exact | **the cross-service join** — wi-admin's audit `correlation_id` is this value |
| `q` | ≤100 chars | escaped and applied as a **literal**; a caller-supplied `$regex` would be a ReDoS and a scan amplifier |
| `source` | `ring` \| `persisted` | default `persisted`, falls back to `ring` with `sourceUsed` on the wire |
| `limit` | 1..500 | |
| `before` | ObjectId | a **cursor, not an offset** — the collection evicts from the front, so an offset yields duplicates and gaps |

One route rather than two, because an operator asks one question — "what happened" — and making
them pick a backing store first is making them learn the implementation. `meta` folds in what
would otherwise be a second `/logs/stats` route: `persistence` (state, level floor, whether the
collection is genuinely capped, dropped/failed write counts) and `ring` (capacity, stored,
`droppedSinceBoot`, and a `scopeNote` saying the buffer is **process-local**).

> ⚠ **A log line is free text and can contain personal data** — an email in an SMTP failure, a
> phone number in a WhatsApp send error, an address in a geocoding warning. The scrubber removes
> credential *shapes*, never personal data, and deliberately so: redacting all PII from free text
> would destroy the endpoint's reason to exist. The response says this in `meta.warning`, and it
> is why wi-admin gates this on a tier-1 `developer_tools.logs.read` rather than on
> `system.health.read`, which reaches tier 2.

### What is behind it

jovi-mall had **no logging library at all** before Phase 15 — 1268 `console.*` calls, stdout
only, no levels, no redaction, nothing queryable. It now has pino with redaction derived from the
audit sanitiser's field set, a bounded ring buffer, and a **capped** `system_logs` collection
persisting warn+ only. `console.*` is bridged through the logger at boot (`LOG_CONSOLE_BRIDGE`
is the kill switch), which is what lets the 311 existing `console.error('…', err)` sites arrive
as structured errors with searchable stacks.

**Capped rather than TTL**, in weight order: a capped collection has a hard byte ceiling (a TTL
bounds by *age*, so an error storm inside the window is unbounded — precisely the incident where
you least want logs filling the volume that holds `orders`); TTL deletion is a best-effort
background thread that falls behind exactly under load; TTL deletes generate oplog and index
churn on the platform's error path; and insertion order **is** time order, so the read is a
`$natural` reverse scan needing no time index. The cost, stated: **a capped collection cannot be
resized without dropping it** — treat `LOG_MONGO_CAP_BYTES` as a one-way door.

---

## `GET /cache/keys` — Phase 15

Key **names**, types and TTLs in one named logical database. The per-key read that `/cache`'s
counts make you want next.

```
?db=SLOT_LOCK_DB&prefix=slot:&limit=200&withSize=false
```

**Values are never returned, and there is deliberately no single-key value read.** A
`GET /cache/key?name=…` would be a disclosure oracle for download tokens, WhatsApp idempotency
keys and verification codes — exactly the three databases the flush policy calls destructive. A
key's name, type and TTL answer every legitimate operational question without being one.
`withSize=true` opts into `MEMORY USAGE`, which is O(size) on a collection and therefore off by
default.

It shares `resolveInspectPlan` with the flush, in the same file, so the escaping cannot drift:
addressed **by name**, prefix is a literal with the `*` appended by us, `prefix: "*"` refused.

**Two of the flush's guards are deliberately dropped**, and both omissions are decisions:

| guard | flush | inspect | why |
|---|---|---|---|
| `confirm` | required | **not required** | making an operator type `SLOT_LOCK_DB` to *look* trains reflexive confirmation-typing, which destroys the guard's meaning on the path where it matters |
| whole-DB refusal on destructive DBs | enforced | **permitted** | listing an entire destructive database is fine; clearing one is not. **Looking is not clearing** |

> **`peekRedisClient`, not `getRedisClient`.** ADR-014 D-1's rule is *a probe observes; it does
> not provision*, and this is a probe — a listing served from a connection minted for the listing
> is precisely the probe that changes what it measures. With no open client it returns **200**
> with `available: false` and a reason, because Redis connects lazily here and an idle database
> is not a down one.

Every command goes through a closed allowlist (`scan`, `type`, `pttl`, `ttl`, `memoryUsage`,
`info`) in `domain/redis-command-policy.ts`. That is the `route-group.ts` argument applied to
Redis: *the allowlist is the cap*. A cache inspector is exactly one convenience away from
`sendCommand(req.body.args)`, and routing every command through one helper turns "we did not
write a passthrough" into "a passthrough does not compile".

---

## `GET /database` — Phase 15

Collection stats and **index drift**.

```
?collection=orders&collection=shipments      // repeatable; omit for every collection
```

### Index drift is the read that earns this endpoint

`autoIndex` is on in this service and **a failed index build fails silently at boot** — several
model headers say so, and so does CLAUDE.md. Until now the only detector was
`verify:live-parity`, over a handful of models, and only when somebody ran it. A missing unique
index does not throw; it lets a duplicate through, months later, in a collection nobody watches.

Three buckets, from comparing `schema.indexes()` (plus a walk over field-level declarations)
against the live `listIndexes()`:

| bucket | meaning |
|---|---|
| **`missing`** | declared, not built. **The actionable one.** |
| `extra` | built, declared nowhere — usually migration residue |
| `mismatched` | same key, different options. The nastiest: a "unique" index that is not unique in production |

The canonical shape is deliberately **narrow** — key (order significant), `unique`, `sparse`,
`partialFilterExpression`, `expireAfterSeconds`. `background`, `v`, `2dsphereIndexVersion`,
generated names and default collations differ harmlessly on almost every index, and a report full
of those is one nobody reads. `_id_` is never reported: it would be one guaranteed false positive
per collection.

Stats come from **`$collStats`**, since `collection.stats()` was removed in driver 6. A managed
tier that refuses it degrades that row with a reason rather than 500ing the response — the same
posture `probeMongoServerDetail` takes for `serverStatus`.

Bounded by `DB_INSPECT_BUDGET_MS` (5s); `truncated` and `notReached[]` name what the sweep did not
get to, because silent truncation reads as completeness.

> **Nothing here writes.** No `createIndex`, no `dropIndex`. A "fix the drift" button has a real
> blast radius — a unique index build fails outright on a collection that already holds
> duplicates, and a large build on a primary is an availability event. Reporting is the useful
> 90%; repairing is a decision with a maintenance window attached.

Two caveats travel on the wire: drift reflects **the models this process registered** (a module
never imported at boot is invisible), and an index build in progress reads as `missing`.

---

## Related

- [`dev-tools.md`](./dev-tools.md) — the dangerous half
- `../health.md` — `/api/health` (frozen), `/api/health/live`, `/api/health/ready`, and `/metrics`
- `admin/docs/ADR-014-SYSTEM-OPERATIONS.md` — Phase 14's decision record
- `admin/docs/ADR-015-DEVELOPER-TOOLS.md` — Phase 15's
