import { createClient, RedisClientType } from 'redis';

/**
 * The Redis layer. One client per logical database, created lazily on first use.
 *
 * ── The rule this file now enforces: a probe observes; it does not provision ──
 * Redis connects on first `getRedisClient()` call and NEVER at boot — `server.ts` does not
 * touch it. That makes the obvious diagnostics implementation wrong: a readiness probe that
 * pings Redis would *create* a connection the process never made, on DB 0, which nothing in
 * this codebase uses. It would change the thing it claims to measure, on every probe interval.
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
export const WA_VERIFY_DB = 4; // keep token for whatsapp verification
export const WA_IDEMPOTENCY_DB = 5; // keep idempotency keys for whatsapp (24-72 hours)
export const WA_WINDOW_DB = 6; // keep window status for whatsapp (24 hours)
export const SLOT_LOCK_DB = 7; // keep slot locks for booking
export const DOWNLOAD_TOKEN_DB = 8; // keep download tokens for digital delivery
export const TELEGRAM_LINK_TOKEN_DB = 9; // keep tokens for Telegram account linking
export const TELEGRAM_WINDOW_DB = 10; // keep window status for telegram (24 hours)
export const RATE_LIMIT_DB = 11; // request counters for the rate limiter (Phase 16)
export const WORKER_LOCK_DB = 12; // background-worker overlap locks (F-19)

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
    db: WA_VERIFY_DB,
    constant: 'WA_VERIFY_DB',
    label: 'WhatsApp verification codes',
    purpose: 'One-time codes proving a user controls a phone number',
    ttlHint: 'minutes',
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
    db: TELEGRAM_LINK_TOKEN_DB,
    constant: 'TELEGRAM_LINK_TOKEN_DB',
    label: 'Telegram link tokens',
    purpose: 'One-time tokens binding a Telegram chat to a platform account',
    ttlHint: 'minutes',
  },
  {
    db: TELEGRAM_WINDOW_DB,
    constant: 'TELEGRAM_WINDOW_DB',
    label: 'Telegram service window',
    purpose: 'Per-chat send-window state',
    ttlHint: '24 hours',
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
