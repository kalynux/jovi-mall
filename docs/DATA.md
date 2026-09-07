# jovi-mall — data

Read from source 2026-09-06: `src/core/database/`, `src/infra/redis/redis.factory.ts`,
`scripts/migrate.ts`, and every `*.model.ts`.

---

## The stores, and what each one may lose

| | MongoDB | Redis |
|---|---|---|
| holds | **everything durable** — users, orders, shipments, money, audit, logs | sessions-adjacent ephemera, idempotency keys, locks, caches |
| replica set required? | **yes** — transactions | no |
| losing a write costs | a business record. Unacceptable. | a cache refill, a re-verification, a re-search |

Redis here is **never the system of record**. Every one of its eleven logical databases holds
something whose loss is recoverable by asking again — which is what makes the fail-open rate-limit
store and the fail-open worker lock defensible rather than reckless.

---

## 1 · MongoDB — 94 collections

One database, shared with **wi-admin as a reader** (wi-admin reads `jovi_mall` directly and writes
only through this service's internal API — see
[`../../admin/docs/`](../../admin/docs/) ADR-004).

### The naming registry is the single source of truth

`src/core/database/collections.ts` holds two frozen maps:

- **`MODELS`** — 93 keys. Mongoose registration names, used as the first argument to `model()`
  **and in every `ref:` for populate()**. Changing a value here renames the model everywhere.
- **`COLLECTIONS`** — 94 keys. Physical collection names, passed as the *third* argument so the
  on-disk name is explicit and decoupled from Mongoose's pluralisation rules.

Measured 2026-09-06: **94 model registrations**, 92 of them through `MODELS.*` and two by literal
(`'AdminActionLog'`, `'PaymentWebhookEvent'`).

⚠ **The two maps are deliberately not symmetric, and both asymmetries have a reason.** They look
like registry rot and are not:

| Asymmetry | Why |
|---|---|
| `COLLECTIONS.ADMIN_ACTION_LOG` exists; `MODELS.ADMIN_ACTION_LOG` does not | the model registers under the literal `'AdminActionLog'`; nothing `ref:`s it, so it never needed a registry entry |
| `MODELS.SYSTEM_LOG` exists; **nothing registers a model with it** | `system_logs` is a **capped** collection written by the raw driver (`core/logging/mongo-sink.ts`), never through Mongoose |

The second is the load-bearing one. ⛔ **Do not "complete" it by adding a Mongoose model for
`system_logs`.** `autoIndex` would then create the collection **UNCAPPED** on first boot, before the
sink's `createCollection` ever runs, and the log store would grow without a ceiling. The comment
saying so is in `collections.ts` at the `SYSTEM_LOG` entry; this is the reason it is there.

### Capped, not TTL — and why

`system_logs` is capped rather than TTL-bounded because a capped collection has a **hard byte
ceiling** and a TTL bounds only by *age*: an error storm inside the retention window is exactly when
a TTL fails to protect the disk. The cost, stated plainly: **a capped collection cannot be resized
without dropping and recreating it.**

### Retention is per-collection and not uniform

| Collection | Retention | Mechanism |
|---|---|---|
| `system_logs` | a byte ceiling | capped collection |
| `admin_action_log` | **400 days, unconditional** | TTL index on `occurred_at` |
| `payment_webhook_events` | 45 days | TTL index on `receivedAt` |
| `stock_reservations` | until `expiresAt` | TTL index, `expireAfterSeconds: 0` |
| everything else | **permanent** | — |

⚠ **`admin_action_log`'s TTL is unconditional, and wi-admin's counterpart's is not.** wi-admin's
`admin_audit_log` has a *partial* TTL requiring `export_id`, so a row leaves only once it has been
exported to a durable file **and** aged out (ADR-006 D-3). That is right for the compliance record.
**This collection is not the compliance record** — it is a stop-gap in a database wi-admin does not
own, with no export manifest to point a vanished row at. 400 days is deliberately longer than
wi-admin's `ADMIN_AUDIT_RETENTION_DAYS` (365), so nothing here disappears before its counterpart
would have. **Never treat it as the compliance record.**

⚠ **Two indexes on `occurred_at`** — a descending compound for the feed and an ascending one for the
TTL — is correct and necessary. Mongo will not drive a TTL off the compound index. Do not tidy one
away.

### `autoIndex` is OFF in production

`lifecycle.ts`: `autoIndex: process.env.NODE_ENV !== 'production'`.

The reason is worth keeping: an index build triggered by a boot **fails silently** — the promise
rejects into a listener nobody attached and the process comes up healthy. For a read index that is a
slow page; for `payment_webhook_events`' unique `(gateway, eventId)` it is **webhook dedup quietly
not existing**. It is also an unannounced load spike on the primary, timed to a deploy.

Turning it off converts a silent-*slow* failure into a silent-*missing* one, so it is paired with
`reportIndexDrift()` after the listener opens. **Development keeps `autoIndex` on** — a developer who
has just written a schema should not have to run a migration to use it.

### Transactions

`src/core/database/transaction.manager.ts`, including a variant that **automatically retries on a
transient transaction error**. Mongo transactions require a **replica set**; the development
database runs as `rs0` for this reason and a standalone `mongod` will fail every transactional write
path, including the tracking outbox.

---

## 2 · Redis — eleven logical databases, and a hard ceiling

`src/infra/redis/redis.factory.ts`. One client per logical database, **created lazily on first
use** — Redis is never connected at boot.

| DB | Constant | Holds |
|---|---|---|
| 0 | *(none)* | `calendar_sync_lock:{vendorId}` — a per-vendor `PX` lock, fail-open |
| 3 | `EMAIL_VERIFY_DB` | `auth:verify:*` |
| 5 | `WA_IDEMPOTENCY_DB` | WhatsApp idempotency keys (24–72 h) |
| 6 | `WA_WINDOW_DB` | WhatsApp 24-hour service window |
| 7 | `SLOT_LOCK_DB` | booking slot locks |
| 8 | `DOWNLOAD_TOKEN_DB` | digital-delivery download tokens |
| 10 | `BOT_SURFACE_DB` | `bot:idem:*` + `bot:geo:*` |
| 11 | `RATE_LIMIT_DB` | request counters |
| 12 | `WORKER_LOCK_DB` | background-worker overlap locks |
| 13 | `CONNECTION_CODE_DB` | messaging connection codes |
| 14 | `LOGIN_CODE_DB` | passwordless `/login` sessions |
| 15 | `CACHE_DB` | `geo:*` + `related:*` |

### ⛔ The budget is 5–15, not 0–15

Two constraints stack and **only the first is a Redis fact**:

1. **Redis's `databases` directive defaults to 16**, so valid indices are 0–15. It is
   **startup-only** — measured against the development Redis on 2026-08-25: `CONFIG SET databases
   32` → `ERR Unsupported CONFIG parameter`. The compose stack's three `redis:7-alpine` services
   carry no `command:` override, so they run the same default.
2. **This service does not own the low indices — wi-admin does.** It claims `ADMIN_SESSION_DB = 1`,
   `ADMIN_RATE_LIMIT_DB = 2`, `PERMISSION_CACHE_DB = 3`. The compose stack gives each service its
   own Redis precisely because of this — **but a developer machine runs one**, and both `.env` files
   point at `redis://localhost:6379`.

So **assign from 5–15 only**, and check `admin/src/infra/redis/redis.factory.ts` before assuming a
number is yours. Eleven slots, eleven things — **there is no room for a twelfth.**

⚠ **`EMAIL_VERIFY_DB = 3` already collides** with wi-admin's `PERMISSION_CACHE_DB`, and is left
alone deliberately: nothing reads the other's keys (both exact-gets), so the cost on a shared Redis
is that a flush of one clears the other, and on the separate-instance deployment there is no cost at
all. Moving it would invalidate every verification link in flight.

⚠ **4 and 9 are RETIRED, not free.** They held the two pre-cutover account-linking mechanisms. The
gap in the sequence **is the point**. Closing it costs nothing and risks reading a pre-cutover
verification code back as something else entirely. `test:connections` pins both numbers.

⚠ **Two databases hold two things each behind key prefixes, and that is a stated concession**, not
the pattern to copy. The rule everywhere else is one database per **blast radius**, because the
cache-flush policy states consequences per database and one note cannot honestly cover two. What
makes it survivable is that the flush endpoint takes a *prefix*, so each half stays independently
clearable — and `BOT_SURFACE_DB` is therefore **prefix-only** (`wholeDbAllowed: false`), because
`bot:idem:` is the duplicate-checkout guard and a whole-database flush would take it along with the
harmless `bot:geo:`.

⚠ **DB 0 is deliberately NOT in `REDIS_DB_CATALOG`.** Everything in that table is addressable by the
cache-flush endpoint, and `db: 0` is refused there outright as "a typo or a probe". The cost is that
an orphaned calendar-sync lock waits out its own TTL — which is what the TTL is for.

### Two accessors, not interchangeable

| | Connects? | For |
|---|---|---|
| `getRedisClient(db)` | yes | real work, and the cache flush — flushing a DB *this* process never opened is legitimate, because another instance opened it |
| `peekRedisClient(db)` | **never** | every read on `/api/internal/admin/system/*` |

**A probe observes; it does not provision.** A readiness probe that pinged Redis would *create* a
connection this process may never have made, changing the thing it claims to measure on every probe
interval.

---

## 3 · Migrations — 20, forward-only, ledgered

`scripts/migrate.ts` + `src/core/database/schema-migration.model.ts`.

```bash
npm run migrate:status                 # what has run here, and from which version
npm run migrate:up                     # apply everything unapplied, in order, ledgered
npm run migrate:up -- --dry-run        # rehearse everything; ledger nothing
npm run migrate:up -- --only <name>    # one of them
```

Four properties, each a decision:

- **It SHELLS OUT.** Each migration is a standalone program with its own `dotenv.config()`, its own
  `mongoose.connect` and its own `process.exit`. The runner spawns `npm run <binding>`, times it, and
  ledgers the result — so **the migration under test is byte-identical to the migration that runs**,
  and this file cannot break one.
- **Order is DECLARED, not discovered.** One rule produces it: **index builds run LAST**, because a
  unique build fails outright against data that still holds duplicates. Letting the data migrations
  reach their final shape first turns "E11000, go and investigate" into a build that simply
  succeeds.

  ⚠ **`migrate.ts`'s own comment states this rule with the wrong evidence** (measured 2026-09-06,
  filed as DOC-PROGRAM **P-11**). It reads *"Three of them claim UNIQUENESS
  (`migrate:payment-indexes`, `migrate:cod-late-deposit-index`)"* — which names two, not three, and
  one of the two is the wrong migration. Counted by `grep -c 'unique: *true'`, **four** index
  migrations create unique indexes: `migrate:payment-indexes` (5), `migrate:customer-catalog-indexes`
  (2), `migrate:review-indexes` (2) and `migrate:inventory-indexes` (2).
  **`migrate:cod-late-deposit-index` creates none — it DROPS a superseded unique index**, re-scoping
  late-deposit uniqueness from agent to contract. The ordering rule is correct and the reasoning
  behind it is correct; only the list of examples is wrong.
- **The registry is CLOSED.** `assertRegistryCovers()` diffs `MIGRATIONS` against every `migrate:*` /
  `backfill:*` binding in `package.json` and fails on any difference — so a migration added without a
  row here cannot become a migration the ledger silently does not track.
- **Forward-only.** There is no `migrate:down`, same as geo-tracker's `migrate.go` and for the same
  reason: a down migration for a backfill is a fiction (it cannot know which rows it wrote), and
  every one of them is idempotent, so the correction for a bad migration is **another migration**.

The 20 rows, in order: three agent-domain data migrations · three billing/payments/booking · four
backfills · `migrate:drop-agent-invites` (**the only destructive row**) · `migrate:retire-admin-role`
· then eight index builds.

⚠ **Pre-production rule D-5 (2026-08-21): dev data is disposable — write no new backfills or
renames.** Index migrations only; a data problem is fixed in the **seed**, not by a migration.

---

## 4 · Idempotency

Four mechanisms, deliberately different, because they guard four different things:

| Surface | Mechanism | What a duplicate would cost |
|---|---|---|
| **payment webhooks** | unique `(gateway, eventId)` in `payment_webhook_events`, TTL 45 d | crediting a payment twice |
| **the n8n bot surface** | **mandatory** client-supplied idempotency key, `bot:idem:*` in Redis DB 10 | a duplicate checkout |
| **the tracking outbox** | `eventId`, deduped **at geo-tracker** | a duplicated lifecycle transition |
| **earnings splits** | a per-source **unique index** on the allocation | paying a split twice |

The last is the one to copy when in doubt: the recovery sweep
(`recoverMissedCodSplits` / `recoverMissedDeliverySplits`) is safe to re-run precisely because the
uniqueness lives in the database rather than in the sweep's own bookkeeping.

⚠ **The bot key is mandatory, not optional.** An optional idempotency key is an idempotency key
nobody sends.
