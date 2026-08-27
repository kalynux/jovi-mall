import { createClient, RedisClientType } from 'redis';

/**
 * The Redis layer. One client per logical database, created lazily on first use.
 *
 * ── The rule this file now enforces: a probe observes; it does not provision ──
 * Redis connects on first `getRedisClient()` call and NEVER at boot — `server.ts` does not
 * touch it. That makes the obvious diagnostics implementation wrong: a readiness probe that
 * pings Redis would *create* a connection the process may never have made, on DB 0. It would
 * change the thing it claims to measure, on every probe interval.
 *
 * ⚠ **This paragraph used to end "on DB 0, which nothing in this codebase uses", and that
 * half was false** (corrected 2026-08-25). `InboundCalendarSyncService` opens DB 0 in its
 * constructor when `REDIS_URL` is set and writes `calendar_sync_lock:{vendorId}` there with a
 * `PX` TTL — a real per-vendor lock, fail-open, released on completion. The argument above
 * survives without that clause and is why it was only corrected rather than removed: the
 * calendar sync is one optional consumer, so a probe still provisions a connection on a
 * deployment where it is idle or unconfigured.
 *
 * ⚠ **DB 0 is deliberately NOT in `REDIS_DB_CATALOG`.** Everything in that table is
 * addressable by the cache-flush endpoint, and `db: 0` is refused there outright as "a typo or
 * a probe" — a rule worth more than making one lock flushable. The cost is that an orphaned
 * calendar-sync lock waits out its own TTL, which is what the TTL is for.
 *
 * So there are two accessors and they are not interchangeable:
 *
 *   getRedisClient(db)     connects if needed. For real work, and for the cache flush —
 *                          flushing a DB this process never opened is legitimate, because
 *                          another instance opened it.
 *   peekRedisClient(db)    returns an already-open client or null. Never connects. This is
 *                          what every read on /api/internal/admin/system/* uses.
 *
 * The `clients` map stays private. Exporting it would let a caller `quit()` a client out from
 * under a live request; `redisClientSnapshot()` hands out data instead.
 */

export const EMAIL_VERIFY_DB = 3; // keep token for email verification
export const WA_IDEMPOTENCY_DB = 5; // keep idempotency keys for whatsapp (24-72 hours)
export const WA_WINDOW_DB = 6; // keep window status for whatsapp (24 hours)
export const SLOT_LOCK_DB = 7; // keep slot locks for booking
export const DOWNLOAD_TOKEN_DB = 8; // keep download tokens for digital delivery
export const BOT_SURFACE_DB = 10; // the bot surface's own ephemera — `bot:idem:*` + `bot:geo:*`
export const RATE_LIMIT_DB = 11; // request counters for the rate limiter (Phase 16)
export const WORKER_LOCK_DB = 12; // background-worker overlap locks (F-19)
export const CONNECTION_CODE_DB = 13; // unified messaging connection codes (Phase 2/3)
export const LOGIN_CODE_DB = 14; // passwordless /login sessions — link token + code
export const CACHE_DB = 15; // pure-optimisation caches — `geo:*` (ADR-A04 D-1) + `related:*`

/**
 * ⛔ **THE CEILING IS 16, AND 0–15 IS NOT THE BUDGET — 5–15 IS.**
 *
 * Two constraints stack, and only the first is a Redis fact:
 *
 * **1 · Redis's `databases` directive defaults to 16**, so the only valid indices are
 * **0–15**. Measured 2026-08-25 against the development Redis: `CONFIG GET databases` → `16`,
 * `SELECT 16` → `ERR invalid DB index`, and `CONFIG SET databases 32` → `ERR Unsupported
 * CONFIG parameter` — it is startup-only, so raising it means editing a conf file and
 * restarting. True of the compose stack too, whose three `redis:7-alpine` services carry no
 * `command:` override and therefore run the same default.
 *
 * **2 · ⚠ THIS SERVICE DOES NOT OWN THE LOW INDICES. `wi-admin` DOES.** It claims
 * `ADMIN_SESSION_DB = 1`, `ADMIN_RATE_LIMIT_DB = 2` and `PERMISSION_CACHE_DB = 3`
 * (`admin/src/infra/redis/redis.factory.ts`). The compose stack gives each service its own
 * Redis instance precisely because of this — but a **developer machine runs one**, and both
 * `.env` files point at `redis://localhost:6379`. Verified 2026-08-25: DB 1 on the local
 * Redis holds twelve live `admin-sessions:*` keys.
 *
 * So an index below 4 is not free here even when this file says nothing about it. **Assign
 * from 5–15 only**, and check `admin/src/infra/redis/redis.factory.ts` before assuming a
 * number is yours.
 *
 * ⚠ **`EMAIL_VERIFY_DB = 3` ALREADY COLLIDES** with wi-admin's `PERMISSION_CACHE_DB`, and it
 * is left alone deliberately. Nothing reads the other's keys — `auth:verify:*` against a
 * permission verdict, both exact-gets — so the practical cost on a shared Redis is that a
 * flush of one clears the other, and the separate-instance deployment has no cost at all.
 * Moving it would invalidate every verification link in flight for a problem the compose
 * stack already solves.
 */

/**
 * ⚠ 4 and 9 are RETIRED, not free — and 10 and 16 are RECLAIMED, which is a different thing.
 *
 * **4 and 9** held `wa_verify:{CODE}` and `tlgt:{token}` for the two account-linking
 * mechanisms the unified connection domain replaced. Both are gone; the numbers are left
 * unassigned so a stale key from a pre-cutover deployment can never be read back by a feature
 * that has since claimed the database. The gap in the sequence is the point, not an oversight.
 * **Do not close it**: the cost of two unused integers is nothing, and the cost of reading a
 * pre-cutover verification code back as something else entirely is a security incident.
 * Inspected and deliberately kept by the Phase 4 dead-and-orphaned sweep, 2026-08-19 (plan
 * step 4.A.6.4), which is the kind of pass most likely to take them. `test:connections` pins
 * both numbers.
 *
 * **10 is different, and reassigning it was safe for a reason that does not extend to 4 or 9.**
 * It was `TELEGRAM_WINDOW_DB`, reserved for a 24-hour service window — and **the Telegram Bot
 * API has no such thing**; that constraint is Meta's alone. So nothing was ever written to it:
 * no reader, no writer, no line of the telegram module touches Redis at all, verified by
 * source scan, and the live database was empty. A number that never held a key cannot hand one
 * back. (The merged bot store's keys are `bot:*` exact-gets besides, so even a stale key of
 * another shape is unreadable by it.)
 *
 * **16 was never valid**, being above the ceiling — see above. Its `RECOMMENDATION_CACHE_DB`
 * moved onto `CACHE_DB` as the `related:*` prefix, which is the first time that cache has
 * worked.
 *
 * History: 15 went to the geocoding cache and 16 to the recommendation cache (both
 * 2026-08-21); 2026-08-25 merged the two onto 15 as `CACHE_DB`, gave 10 to the bot surface,
 * and released 1/2 back to wi-admin after briefly and wrongly taking them.
 */

/**
 * ⚠ **TWO DATABASES HOLD TWO THINGS EACH, BEHIND KEY PREFIXES, AND THAT IS A CONCESSION.**
 *
 * The rule everywhere else in this table is one logical database per BLAST RADIUS, because
 * the cache-flush policy states consequences per database and one note cannot honestly cover
 * two. `LOGIN_CODE_DB` and `RECOMMENDATION_CACHE_DB` were both split out on exactly that
 * argument. The ceiling above is what forced the concession: 5–15 is eleven slots and there
 * were thirteen things.
 *
 * What makes it survivable is that **the flush endpoint takes a prefix**, so each half stays
 * independently clearable and the policy row states both radii rather than averaging them:
 *
 *   `BOT_SURFACE_DB`  `bot:idem:` (DESTRUCTIVE — the duplicate-checkout guard)
 *                     `bot:geo:`  (trivial — an address flow searches again)
 *   `CACHE_DB`        `geo:`      (spends a rate-limited third-party call to refill)
 *                     `related:`  (free — one aggregation per product page)
 *
 * `BOT_SURFACE_DB` is therefore **prefix-only** (`wholeDbAllowed: false`): its dangerous half
 * already demanded that, and a whole-database flush would silently take it along with the
 * harmless one.
 *
 * **A third pairing is not available.** The next feature that wants a logical database has to
 * raise `databases` on every Redis this platform runs against, or share one of these two — and
 * sharing is only honest when the blast radii can be stated separately, as above.
 */

/**
 * What each logical database holds — the table three separate features needed.
 *
 * The constants above were the only record of this, as trailing comments, which is fine while
 * one reader needs them and useless the moment three do. `/system/dependencies`, `/system/cache`
 * and the cache-flush allowlist all describe these databases, and a fact stated in a comment
 * cannot be iterated over.
 *
 * The constants stay exported so no call site changes. This table is additive.
 */
export interface RedisDbSpec {
  db: number;
  /** The exported constant's name — how the flush endpoint addresses a database. */
  constant: string;
  label: string;
  /** What is lost if these keys disappear. Feeds the flush blast-radius note. */
  purpose: string;
  ttlHint: string;
}

export const REDIS_DB_CATALOG: readonly RedisDbSpec[] = Object.freeze([
  {
    db: EMAIL_VERIFY_DB,
    constant: 'EMAIL_VERIFY_DB',
    label: 'Email verification tokens',
    purpose: 'One-time links proving a user controls an email address',
    ttlHint: 'hours',
  },
  {
    db: WA_IDEMPOTENCY_DB,
    constant: 'WA_IDEMPOTENCY_DB',
    label: 'WhatsApp idempotency keys',
    purpose: 'What stops a retried send becoming a second message to a real person',
    ttlHint: '24-72 hours',
  },
  {
    db: WA_WINDOW_DB,
    constant: 'WA_WINDOW_DB',
    label: 'WhatsApp service window',
    purpose: 'Whether a free-form reply is still allowed, or a paid template is required',
    ttlHint: '24 hours',
  },
  {
    db: SLOT_LOCK_DB,
    constant: 'SLOT_LOCK_DB',
    label: 'Booking slot holds',
    purpose: 'The 15-minute courtesy hold between choosing a slot and paying for it',
    ttlHint: '15 minutes',
  },
  {
    db: DOWNLOAD_TOKEN_DB,
    constant: 'DOWNLOAD_TOKEN_DB',
    label: 'Digital download tokens',
    purpose: 'Live download links issued to customers who have paid',
    ttlHint: 'minutes to hours',
  },
  {
    db: BOT_SURFACE_DB,
    constant: 'BOT_SURFACE_DB',
    label: 'Bot-surface ephemera',
    // TWO things behind two prefixes, and the flush policy states both radii separately —
    // see the concession note above the catalogue.
    //
    // `bot:idem:*` is the fifth set of keys here that is load-bearing rather than an
    // optimisation, and the argument is `WA_IDEMPOTENCY_DB`'s one level up: a record is the
    // only thing between a retried chat message and a SECOND set of orders with a second
    // stock hold. `POST /api/internal/bot/checkout` is not idempotent underneath, and chat
    // transports retry — the automation layer retries, the network retries, and the customer
    // taps twice.
    //
    // `bot:geo:*` holds the full geocoding candidate behind an opaque single-use handle, so
    // the automation layer never carries coordinates and `POST /addresses` cannot be sent a
    // hand-assembled `geo` object. That matters beyond tidiness: a null inside the 2dsphere-
    // indexed saved-address array makes the WHOLE customer document unwritable — measured,
    // and not fixed by a sparse or partial index. See `dropNullLocation`.
    purpose: 'Idempotency records (bot:idem:) and address-candidate handles (bot:geo:) for /api/internal/bot/*',
    ttlHint: '24 hours (idempotency) / 30 minutes (candidates)',
  },
  {
    db: RATE_LIMIT_DB,
    constant: 'RATE_LIMIT_DB',
    label: 'Rate-limit counters',
    // The only DB in this catalogue whose loss is harmless: an emptied window re-opens one
    // allowance and nothing durable is gone. That is also why the limiter FAILS OPEN when
    // this database is unreachable — see api/rate-limit/fail-open-store.ts.
    purpose: 'Per-caller request counters. Losing them re-opens one window of allowance.',
    ttlHint: 'seconds',
  },
  {
    db: WORKER_LOCK_DB,
    constant: 'WORKER_LOCK_DB',
    label: 'Background worker locks',
    // The second DB whose loss is survivable, and the only one where flushing is a documented
    // REMEDY: a lock orphaned by a hard kill blocks its sweep until the TTL expires, and emptying
    // this database releases every one of them. The cost of flushing while sweeps are genuinely
    // running is that two instances may run the same sweep once — which is exactly the state the
    // whole database exists to prevent, so do it deliberately. See core/jobs/worker-lock.ts.
    purpose: 'One key per background sweep in flight. Losing them permits one overlapping pass.',
    ttlHint: 'minutes (renewed while the sweep runs)',
  },
  {
    db: CONNECTION_CODE_DB,
    constant: 'CONNECTION_CODE_DB',
    label: 'Messaging connection codes',
    // Replaces WA_VERIFY_DB and TELEGRAM_LINK_TOKEN_DB, which held the two
    // predecessor mechanisms. Note the direction is INVERTED from those: the
    // bot mints the code and this database holds the messaging identity waiting
    // to be claimed, so a key here names a person's WhatsApp or Telegram
    // account and no platform account at all.
    purpose: 'Codes minted by a bot on /connect, holding an unclaimed messaging identity',
    ttlHint: '10 minutes',
  },
  {
    db: LOGIN_CODE_DB,
    constant: 'LOGIN_CODE_DB',
    label: 'Passwordless sign-in sessions',
    // A SEPARATE database from 13 rather than a key prefix on it, and the reason is
    // this `purpose` line: the flush policy states consequences per database, and
    // "in-flight sign-ins fail" is not "in-flight connections fail". Sharing the
    // number would make one blast-radius note have to cover two.
    //
    // What a key here stands for is also categorically different from 13's. A
    // connection code holds a messaging identity nobody owns yet; a record here
    // points at an EXISTING account and redeeming it grants a customer session.
    // Same ten minutes, very different thing to leak.
    purpose: 'Magic-link tokens and /login codes. Losing them fails every sign-in in flight.',
    ttlHint: '10 minutes',
  },
  {
    db: CACHE_DB,
    constant: 'CACHE_DB',
    label: 'Pure-optimisation caches',
    // TWO caches behind two prefixes, and the ONLY two databases in this catalogue whose
    // entire contents are recomputable — which is why neither half is `destructive` in the
    // flush policy. They were split across 15 and 16 until 2026-08-25, on the argument that
    // one flush is free and the other spends a rate-limited third-party call. That argument
    // is intact: the flush endpoint takes a prefix, so each half stays independently
    // clearable and the policy row states both costs rather than averaging them.
    //
    // `geo:*` — address-search and reverse results, keyed by normalised query (ADR-A04 D-1).
    // Flushing is the correct remedy for the one real failure mode, a wrong or stale result
    // cached for up to a day; the cost is provider load, and on the keyless default that is
    // real — Nominatim's public instance permits roughly one request per second.
    //
    // `related:*` — computed co-occurrence lists, keyed by product id. What it buys is that
    // the aggregation (a `$match` on one product's order lines, then a `$group` over their
    // siblings) does not run once per product-page view.
    //
    // ⚠ `related:*` lived on DB 16 from 2026-08-21 until 2026-08-25 and therefore NEVER
    // WORKED — 16 is above the ceiling, so every `SELECT` errored, and `related-products.
    // cache.ts` correctly fails open, so every read missed and every write was dropped with
    // no symptom at all. Moving it here is the first time that cache has run.
    purpose: 'Geocoding results (geo:) and related-product lists (related:). Both recomputable; losing them costs provider calls and CPU respectively.',
    ttlHint: 'hours to days (GEO_CACHE_TTL_SECONDS / RELATED_PRODUCTS_CACHE_TTL_SECONDS)',
  },
]);

export function findRedisDbByConstant(constant: string): RedisDbSpec | null {
  return REDIS_DB_CATALOG.find((row) => row.constant === constant) ?? null;
}

const clients: Map<number, RedisClientType> = new Map();

/**
 * Databases this process has opened at least once, even if the client later closed.
 *
 * Distinct from `clients.has(db)`: "never needed" and "needed once and since dropped" are
 * different operational facts, and the read surface reports both.
 */
const everOpened: Set<number> = new Set();

/** Connection-level error counts per database, for the metrics layer. */
const connectionErrors: Map<number, number> = new Map();

/**
 * Where connection errors are reported, INSTALLED rather than imported.
 *
 * The metrics module wants to count these, but importing it from here would run
 * infra → modules, which is the wrong direction and the kind of cycle that crashes at boot.
 * So the dependency is inverted: metrics installs itself, and this file knows nothing about it.
 * Same shape as wi-admin's `installAuditDenialSink()`, for the same reason.
 *
 * ⚠ Scope: this observes CONNECTION-level failures only. A command that fails is thrown to its
 * caller and never passes through here, so the counter under-reports by construction. Said on
 * the wire and in `api-doc/admin/system.md` rather than left to be discovered.
 */
type RedisErrorSink = (db: number) => void;
let redisErrorSink: RedisErrorSink | null = null;

export const installRedisErrorSink = (sink: RedisErrorSink): void => {
  redisErrorSink = sink;
};

export const getRedisClient = async (db: number = 0): Promise<RedisClientType> => {
  if (clients.has(db)) {
    const client = clients.get(db)!;
    if (!client.isOpen) {
      await client.connect();
    }
    return client;
  }

  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  const client = createClient({
    url,
    database: db,
  }) as RedisClientType;

  client.on('error', (err) => {
    connectionErrors.set(db, (connectionErrors.get(db) ?? 0) + 1);
    // Metrics never break the error path they are observing.
    try {
      redisErrorSink?.(db);
    } catch {
      /* ignore */
    }
    console.error(`[Redis] Error in DB ${db}:`, err);
  });

  client.on('connect', () => {
    console.log(`[Redis] Connected to DB ${db}`);
  });

  // Lazy connect: We don't await connect here based on "Lazy connect" requirement?
  // Actually, node-redis v4 REQUIRES connect() before use.
  // The requirement says "Lazy connect", which usually means "connect when first requested".
  // Since this function is "getRedisClient" and returns a Promise, we can connect here.
  // If we returned the client immediately without connecting, the user would have to connect.
  // But our signature is `async`, so we can ensure connection.

  await client.connect();
  clients.set(db, client);
  everOpened.add(db);

  return client;
};

/**
 * An already-open client, or null. **Never connects.**
 *
 * The read half of the pair described in this file's header. A diagnostics endpoint that
 * called `getRedisClient` would provision a connection to report on connections.
 */
export const peekRedisClient = (db: number): RedisClientType | null => {
  const client = clients.get(db);
  return client && client.isOpen ? client : null;
};

/**
 * Any open client, for the commands whose answer is instance-wide rather than per-database.
 *
 * `INFO` reports memory, evictions and keyspace hit/miss for the whole Redis instance and
 * `INFO keyspace` covers every logical DB at once — so `/system/cache` needs exactly one open
 * client, not one per database, and must not open one to find out.
 */
export const anyOpenRedisClient = (): { db: number; client: RedisClientType } | null => {
  for (const [db, client] of clients.entries()) {
    if (client.isOpen) return { db, client };
  }
  return null;
};

export interface RedisClientState {
  db: number;
  open: boolean;
  everOpened: boolean;
  connectionErrors: number;
}

/** Connection topology as data. Callers get facts, never a handle they could close. */
export const redisClientSnapshot = (): RedisClientState[] =>
  REDIS_DB_CATALOG.map((row) => ({
    db: row.db,
    open: clients.get(row.db)?.isOpen ?? false,
    everOpened: everOpened.has(row.db),
    connectionErrors: connectionErrors.get(row.db) ?? 0,
  }));

// Graceful shutdown helper
export const closeRedisClients = async () => {
  for (const [db, client] of clients.entries()) {
    if (client.isOpen) {
      await client.quit();
      console.log(`[Redis] Closed DB ${db}`);
    }
  }
  clients.clear();
};
