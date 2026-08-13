import { z } from 'zod';
import { MAINTENANCE_MODES } from '../domain/maintenance-mode';
import { CACHE_FLUSH_POLICY } from '../domain/cache-flush-policy';
import { INTEGRATION_CATALOG } from '../domain/integration-catalog';
import { COLLECTIONS } from '../../../core/database/collections';
import { LOG_LEVELS } from '../../../core/logging/logging.config';
import { ERROR_CATEGORY_VALUES } from '../../../core/error-category';

/**
 * Request shapes for the system-operations surface.
 *
 * `.strict()` throughout, as everywhere else in this codebase: an unknown key is a 400 rather
 * than a silent strip. That matters more here than usual — a caller who misspells `dryRun` and
 * gets a 200 back would reasonably believe nothing was deleted.
 */

const INTEGRATION_KEYS = INTEGRATION_CATALOG.map((spec) => spec.key) as [string, ...string[]];
const FLUSHABLE_DBS = CACHE_FLUSH_POLICY.map((row) => row.spec.constant) as [string, ...string[]];

/**
 * Every collection this codebase declares, as a closed enum.
 *
 * Derived from the frozen registry rather than typed out, so a caller can only ever name a
 * namespace the code already knows about — the `$collStats` pipeline is then built from a value
 * that came from `collections.ts`, never from the request.
 */
const KNOWN_COLLECTIONS = Object.values(COLLECTIONS) as [string, ...string[]];

/** `?probe=smtp,telegram` — which on-demand probes to actually run this request. */
export const IntegrationQuerySchema = z.object({
    probe: z
        .string()
        .optional()
        .transform((value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []))
        .pipe(z.array(z.enum(INTEGRATION_KEYS)).max(INTEGRATION_CATALOG.length)),
}).strict();

/**
 * `PUT /dev-tools/maintenance`.
 *
 * `reason` is required for anything but `off`, and eight characters is a deliberately low bar
 * that still refuses "wip" and "x". It lands in the 503 body every refused caller sees and in
 * wi-admin's audit row, and a window with no stated reason is the one nobody else can confidently
 * end.
 */
export const SetMaintenanceSchema = z.object({
    mode: z.enum(MAINTENANCE_MODES),
    reason: z.string().trim().min(8).max(500).optional(),
    /** Bounded at 24h. An unbounded window is the one everybody forgets is open. */
    expiresInMinutes: z.number().int().min(1).max(1440).optional(),
    blockWebhooks: z.boolean().optional(),
    pauseWorkers: z.boolean().optional(),
}).strict().refine(
    (value) => value.mode === 'off' || Boolean(value.reason),
    { path: ['reason'], message: 'A reason is required to open a maintenance window' },
);

export type SetMaintenanceInputDto = z.infer<typeof SetMaintenanceSchema>;

/**
 * `POST /dev-tools/cache/flush`.
 *
 * Note what is NOT accepted: a numeric database index, and a raw pattern. Both are refused at
 * the type level rather than in a guard — see `domain/cache-flush-policy.ts` for why each one
 * would be a foot-gun.
 */
export const FlushCacheSchema = z.object({
    db: z.enum(FLUSHABLE_DBS),
    prefix: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
    /** Defaults to true in the policy layer, not here — one default, one place. */
    dryRun: z.boolean().optional(),
    confirm: z.string(),
}).strict();

export type FlushCacheInputDto = z.infer<typeof FlushCacheSchema>;

// ═══ Phase 15 ═════════════════════════════════════════════════════════════════

/**
 * `GET /system/logs`.
 *
 * `q` is bounded at 100 characters and applied as an escaped LITERAL by the service — the bound
 * is a pattern-length defence and the escaping is what stops a caller-supplied `$regex` becoming
 * a ReDoS and a scan amplifier over a collection with no text index.
 */
export const LogQuerySchema = z.object({
    level: z.enum(LOG_LEVELS).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    requestId: z.string().trim().min(1).max(200).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    source: z.enum(['ring', 'persisted']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    /**
     * A CURSOR, never an offset. The persisted store evicts from the front as it is written to,
     * so an offset would hand back duplicates and gaps under any real write load.
     */
    before: z.string().trim().length(24).optional(),
}).strict();

export type LogQueryInputDto = z.infer<typeof LogQuerySchema>;

// ═══ Phase 16 ═════════════════════════════════════════════════════════════════

/**
 * `GET /system/errors` — the same query vocabulary as `/system/logs`, narrowed to lines
 * the global error handler produced, plus the two taxonomy filters.
 *
 * `category` is an enum rather than a free string on purpose: it bounds the value that
 * reaches an equality filter, and it means a typo is a 400 rather than a silently empty
 * result somebody reads as "no errors".
 *
 * `code` is NOT enumerated — the registry has 541 entries and grows, and pinning it here
 * would be a second copy of it. It is bounded by length and used as an equality match, so
 * an unknown value is simply an empty page.
 */
export const ErrorQuerySchema = z.object({
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    requestId: z.string().trim().min(1).max(200).optional(),
    category: z.enum(ERROR_CATEGORY_VALUES as unknown as [string, ...string[]]).optional(),
    code: z.string().trim().min(1).max(100).optional(),
    source: z.enum(['ring', 'persisted']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    before: z.string().trim().length(24).optional(),
}).strict();

export type ErrorQueryInputDto = z.infer<typeof ErrorQuerySchema>;

/** `GET /system/cache/keys` — the read-only sibling of the flush. */
export const CacheKeysQuerySchema = z.object({
    db: z.enum(FLUSHABLE_DBS),
    prefix: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    /** `MEMORY USAGE` is O(size) on a collection, so it is opt-in rather than free. */
    withSize: z.enum(['true', 'false']).optional(),
}).strict();

export type CacheKeysQueryInputDto = z.infer<typeof CacheKeysQuerySchema>;

/**
 * `GET /system/database`.
 *
 * `collection` is pinned to the FROZEN registry, so a caller cannot name an arbitrary namespace
 * and the `$collStats` pipeline is only ever built from a value this codebase declared. That is
 * the strongest single control on the inspector, and `test:system` asserts it rather than
 * trusting the comment.
 */
export const DatabaseInspectQuerySchema = z.object({
    collection: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
        .pipe(z.array(z.enum(KNOWN_COLLECTIONS)).max(KNOWN_COLLECTIONS.length)),
}).strict();

export type DatabaseInspectQueryInputDto = z.infer<typeof DatabaseInspectQuerySchema>;
