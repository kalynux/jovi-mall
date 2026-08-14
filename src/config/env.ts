import { createAppError } from '../core/errors';
import { ERROR_CODES } from '../core/error-codes';

/**
 * Environment validation — every problem at once, and **fail closed** on the ones that matter.
 *
 * ── What this is, and what it deliberately is NOT ─────────────────────────────
 * wi-admin's `config/env.ts` is a Zod schema that *supplies* every value: nothing there reads
 * `process.env` at a call site. This file does not do that, and the difference is a decision
 * rather than an omission.
 *
 * This service reads 254 variables through ~15 module-level `*.config.ts` objects
 * (`modules/agents/config/agent.config.ts`, `modules/system/config/system.config.ts`, …), a
 * shape its own CLAUDE.md documents as intentional: "never a literal in a rule and never a bare
 * `process.env` read at a call site". Those modules already centralise their defaults. Moving
 * all 254 into one schema would rewrite every one of them plus ~40 inline sites, in a service
 * with no test framework, to end up where the defaults already are.
 *
 * So the division of labour is:
 *
 *   - the module configs own **values and defaults** (unchanged), and
 *   - this file owns **whether the environment those defaults are applied to makes sense**.
 *
 * What that buys is the property the module configs structurally cannot have. Every one of them
 * uses the same `intEnv(name, fallback)` shape, which silently substitutes the fallback for a
 * value it cannot parse — so `COD_DEPOSIT_DEADLINE_DAYS=two` boots clean and runs on 2, and
 * `STORAGE_PROVIDER=cloudinary` with no Cloudinary credentials boots clean and writes uploads to
 * local disk. A per-variable default cannot detect either; only a pass over the whole
 * environment can.
 *
 * ── Two properties worth preserving when adding rules ────────────────────────
 *  1. **Every problem is reported at once.** Collect into `problems`, never throw on the first —
 *     an operator should fix one list, not restart five times to discover five mistakes.
 *  2. **Errors and warnings are different things, and the split is not severity theatre.**
 *     An `error` refuses the boot. A `warning` prints and continues, and is reserved for what
 *     this process genuinely cannot decide — whether there is a proxy in front of it, whether
 *     anyone intends to scrape `/metrics`. Making those errors would refuse valid deployments;
 *     leaving them silent is what produced the report this file answers.
 *
 * Note what runs BEFORE this: `modules/agents/config/agent.config.ts` throws at import if the
 * trust weights do not sum to 100, and it is imported transitively by `app.ts`. That check
 * therefore fires before `startServer()` reaches this function, and is not duplicated here.
 */

/** Below this, a secret is guessable regardless of how random it looks. */
const MIN_SECRET_LENGTH = 16;

/**
 * Values that are never an acceptable secret in production, whatever their length.
 * Mirrors `config/secrets.config.ts` and wi-admin's `config/env.ts`, plus the literals this
 * repository actually ships as fallbacks (see `GOOGLE_TOKEN_ENCRYPTION_KEY` below).
 */
const PLACEHOLDER_SECRETS = new Set([
    'secret',
    'changeme',
    'change_me',
    'password',
    'token',
    'replace-me',
    'replace_with_a_shared_secret',
    'development_secret_do_not_use_in_prod',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
]);

export type EnvProblemLevel = 'error' | 'warning';

export interface EnvProblem {
    level: EnvProblemLevel;
    /** The variable at fault. `(multiple)` when a rule spans several. */
    variable: string;
    /** What is wrong, and — always — what it will do if left alone. */
    message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readers
// ─────────────────────────────────────────────────────────────────────────────

function raw(source: NodeJS.ProcessEnv, name: string): string | undefined {
    const value = source[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function isSet(source: NodeJS.ProcessEnv, name: string): boolean {
    return raw(source, name) !== undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed-shape checks
//
// Each of these fires ONLY when the variable is set. An unset variable is the module
// config's business — it has a default and is entitled to it. What is never acceptable is a
// value the operator wrote, believes is in force, and which was silently discarded.
// ─────────────────────────────────────────────────────────────────────────────

/** Variables parsed with `parseInt`/`Number` somewhere downstream. */
const INTEGER_VARS: readonly string[] = Object.freeze([
    'PORT',
    'SMTP_PORT',
    'AUTH_ACCESS_TOKEN_TTL', 'AUTH_REFRESH_TOKEN_TTL',
    'MAX_DIGITAL_ASSET_SIZE',
    'VENDOR_PASSWORD_MIN_LENGTH',
    'STRIPE_XAF_PER_USD',
    'GEO_REQUEST_TIMEOUT_MS', 'GEO_DEFAULT_LIMIT',
    'CREDIT_COST_VECTORISATION', 'CREDIT_COST_WHATSAPP_TEMPLATE',
    'VECTORISER_TIMEOUT_SINGLE_MS', 'VECTORISER_TIMEOUT_BULK_MS',
    'VECTORISER_MAX_RETRIES', 'VECTORISER_RETRY_BASE_DELAY_MS',
    // Agents
    'AGENT_COD_THRESHOLD_MAX', 'AGENT_COD_THRESHOLD_MIN',
    'AGENCY_AGENT_COD_THRESHOLD_MAX', 'AGENCY_AGENT_COD_THRESHOLD_MIN',
    'AGENT_MAX_ACTIVE_SHIPMENTS_MAX', 'AGENT_MAX_ACTIVE_SHIPMENTS_MIN',
    'AGENT_MAX_ACTIVE_SHIPMENTS_DEFAULT', 'AGENT_MAX_AGENCY_RELATIONSHIPS',
    'AGENT_TRUST_WEIGHT_COD', 'AGENT_TRUST_WEIGHT_ACTIVITY', 'AGENT_TRUST_WEIGHT_CUSTOMER',
    'AGENT_TRUST_WEIGHT_AGENCY', 'AGENT_TRUST_WEIGHT_VENDOR',
    'AGENT_TRUST_SCORE_SEED', 'AGENT_TRUST_MIN_OBSERVATIONS',
    'AGENT_TRUST_COD_VOLUME_FULL_CREDIT', 'AGENT_TRACKING_STATE_STALE_AFTER_SECONDS',
    // COD
    'COD_OTP_MAX_ATTEMPTS', 'COD_OTP_RESEND_MIN_SECONDS', 'COD_AGENT_MAX_EXPOSURE_DEFAULT',
    'COD_TRUST_FULL_THRESHOLD', 'COD_TRUST_REDUCED_THRESHOLD',
    'COD_TRUST_PENALTY_LATE_DEPOSIT', 'COD_TRUST_PENALTY_SHORTFALL',
    'COD_DEPOSIT_DEADLINE_DAYS', 'COD_DEPOSIT_CONFIRM_DEADLINE_DAYS',
    'COD_RESERVE_PERCENT', 'COD_RESERVE_DAYS', 'COD_BATCH_SIZE',
    // Earnings
    'EARNINGS_HOLD_DAYS', 'EARNINGS_AUTO_CONFIRM_DAYS', 'EARNINGS_SHIPMENT_AUTO_CONFIRM_DAYS',
    'EARNINGS_DELIVERY_FLAT_FEE', 'EARNINGS_BATCH_SIZE',
    'EARNINGS_MIN_PAYOUT_AMOUNT', 'EARNINGS_AUTO_PAYOUT_THRESHOLD',
    // Assignment
    'SHIPMENT_OFFER_TIMEOUT_SECONDS', 'SHIPMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS',
    'SHIPMENT_OFFER_EXPIRY_SWEEP_BATCH', 'SHIPMENT_ASSIGNMENT_MAX_CANDIDATES',
    'SHIPMENT_ASSIGNMENT_MAX_ROUNDS', 'SHIPMENT_ASSIGNMENT_POSITION_FRESHNESS_SECONDS',
    'SHIPMENT_ASSIGNMENT_GEO_TIMEOUT_MS', 'SHIPMENT_ASSIGNMENT_GEO_TOKEN_TTL_SECONDS',
    // Bookings & calendar
    'BOOKING_SLOT_HOLD_TTL_SECONDS', 'BOOKING_UNPAID_EXPIRY_AFTER_MINUTES',
    'BOOKING_UNPAID_EXPIRY_INTERVAL_MS', 'BOOKING_UNPAID_EXPIRY_BATCH_SIZE',
    'BOOKING_REMINDER_LEAD_MINUTES', 'BOOKING_REMINDER_INTERVAL_MS', 'BOOKING_REMINDER_BATCH_SIZE',
    'CALENDAR_SYNC_NEAR_INTERVAL_MS', 'CALENDAR_SYNC_NEAR_WINDOW_DAYS',
    'CALENDAR_SYNC_FAR_INTERVAL_MS', 'CALENDAR_SYNC_FAR_WINDOW_DAYS', 'CALENDAR_SYNC_BATCH_SIZE',
    // geo-tracker dispatch
    'GEO_TRACKER_DISPATCH_INTERVAL_MS', 'GEO_TRACKER_DISPATCH_BATCH_SIZE',
    'GEO_TRACKER_MAX_ATTEMPTS', 'GEO_TRACKER_REQUEST_TIMEOUT_MS', 'TRACKING_BOARD_MAX_SHIPMENTS',
    // File cleanup
    'FILE_CLEANUP_BATCH_SIZE', 'FILE_CLEANUP_PRODUCT_DAYS', 'FILE_CLEANUP_TICKET_DAYS',
    'FILE_CLEANUP_LONELY_DAYS', 'FILE_CLEANUP_DEFAULT_STORAGE_BYTES',
    // Uploads
    'UPLOAD_MAX_FILES_PER_REQUEST', 'UPLOAD_MAX_TOTAL_SIZE_BYTES',
    'UPLOAD_USER_QUOTA_MAX_FILES', 'UPLOAD_USER_QUOTA_MAX_BYTES',
    // System operations
    'HEALTH_PROBE_TIMEOUT_MS', 'SYSTEM_INTEGRATION_PROBE_TIMEOUT_MS', 'MAINTENANCE_CACHE_TTL_MS',
    'CACHE_FLUSH_MAX_KEYS', 'CACHE_FLUSH_BUDGET_MS', 'CACHE_INSPECT_MAX_KEYS',
    'DB_INSPECT_BUDGET_MS', 'METRICS_COLLECT_CACHE_MS', 'METRICS_COLLECT_TIMEOUT_MS',
    // Logging
    'LOG_MAX_MESSAGE_BYTES', 'LOG_MAX_STACK_BYTES', 'LOG_RING_SIZE', 'LOG_RING_MAX_BYTES',
    'LOG_MONGO_CAP_BYTES', 'LOG_MONGO_CAP_MAX_DOCS', 'LOG_MONGO_MAX_INFLIGHT',
    'LOG_SINK_FAILURE_STREAK', 'LOG_SINK_COOLDOWN_MS', 'LOG_SINK_ERROR_THROTTLE_MS',
    'LOG_SINK_FLUSH_BUDGET_MS',
    // Rate limiting
    'RATE_LIMIT_GLOBAL_PER_MIN', 'RATE_LIMIT_ADMIN_PER_MIN', 'RATE_LIMIT_AGENT_PER_MIN',
    'RATE_LIMIT_VENDOR_PER_MIN', 'RATE_LIMIT_AGENCY_PER_MIN', 'RATE_LIMIT_CUSTOMER_PER_MIN',
    'RATE_LIMIT_ANON_PER_MIN', 'RATE_LIMIT_AUTH_PER_MIN',
    // Orders
    'UNPAID_ORDER_CANCEL_BATCH_SIZE',
]);

/** Variables read as a float (weights, scores, distances). */
const NUMBER_VARS: readonly string[] = Object.freeze([
    'SHIPMENT_ASSIGNMENT_MIN_TRUST_SCORE',
    'SHIPMENT_ASSIGNMENT_WEIGHT_DISTANCE', 'SHIPMENT_ASSIGNMENT_WEIGHT_CAPACITY',
    'SHIPMENT_ASSIGNMENT_WEIGHT_TRUST',
    'SHIPMENT_ASSIGNMENT_DISTANCE_FULL_KM', 'SHIPMENT_ASSIGNMENT_DISTANCE_ZERO_KM',
    'SHIPMENT_ASSIGNMENT_UNKNOWN_DISTANCE_SCORE',
]);

/**
 * Variables compared against `'true'` / `'1'` / `'false'` / `'0'` downstream.
 *
 * The three helper shapes in this repository disagree about what an unrecognised value means —
 * `system.config.ts` reads anything-but-true as false, `agent.config.ts`'s
 * `TRACKING_ALLOWED_BY_DEFAULT` reads anything-but-false as true — so `ENABLED=yes` lands on a
 * different answer depending on which module reads it. Rejecting the input is the only way to
 * make that unambiguous without changing eleven helpers.
 */
const BOOLEAN_VARS: readonly string[] = Object.freeze([
    'FCM_ENABLED', 'ALLOW_EMAIL_CHANGE',
    'STORAGE_FIREBASE_PUBLIC',
    'AGENT_REQUIRE_DEVICE_LOCATION', 'AGENT_TRACKING_ALLOWED_BY_DEFAULT',
    'AGENT_TRUST_RECOMPUTE_ENABLED',
    'SHIPMENT_ASSIGNMENT_REQUIRE_LIVE_POSITION',
    'BOOKING_UNPAID_EXPIRY_ENABLED', 'BOOKING_REMINDER_ENABLED', 'CALENDAR_SYNC_ENABLED',
    'FILE_CLEANUP_ENABLED', 'FILE_CLEANUP_DRY_RUN', 'FILE_CLEANUP_PROTECT_ENTITLEMENTS',
    'FILE_CLEANUP_STAGE_DETACH_ENABLED', 'FILE_CLEANUP_STAGE_TICKET_ENABLED',
    'FILE_CLEANUP_STAGE_DELETE_ENABLED', 'FILE_CLEANUP_STAGE_ALERT_ENABLED',
    'UNPAID_ORDER_CANCEL_ENABLED', 'UNPAID_ORDER_CANCEL_DRY_RUN',
    'UPLOAD_VIRUS_SCAN_ENABLED', 'UPLOAD_VIRUS_SCAN_BLOCK_ON_FAILURE',
    'UPLOAD_USER_QUOTAS_ENABLED', 'UPLOAD_FINGERPRINTING_ENABLED',
    'UPLOAD_DUPLICATE_DETECTION_ENABLED', 'UPLOAD_DUPLICATE_BLOCK',
    'UPLOAD_OBSERVABILITY_ENABLED',
    'HEALTH_READY_REQUIRE_REDIS', 'METRICS_ENABLED',
    'LOG_CONSOLE_BRIDGE', 'LOG_STDOUT', 'LOG_HTTP_ACCESS', 'LOG_PERSIST_ENABLED',
]);

const BOOLEAN_LITERALS = new Set(['true', 'false', '1', '0']);

/** Variables restricted to a closed set of values. */
const ENUM_VARS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    NODE_ENV: ['development', 'test', 'production'],
    STORAGE_PROVIDER: ['local', 'firebase', 'cloudinary'],
    GEO_PROVIDER: ['nominatim', 'google', 'mapbox', 'here', 'geoapify'],
    MAIL_PROVIDER: ['console', 'smtp'],
    LOG_LEVEL: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    LOG_PERSIST_LEVEL: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    UPLOAD_LOG_LEVEL: ['debug', 'info', 'warn', 'error'],
    UPLOAD_FINGERPRINT_ALGORITHM: ['md5', 'sha1', 'sha256', 'sha512'],
    AGENT_UNKNOWN_DEVICE_LOCATION_POLICY: ['allow', 'deny'],
    SHIPMENT_ASSIGNMENT_OFFER_PII_REVEAL: ['on_accept', 'on_offer'],
});

/**
 * Variable names the OLD `.env.example` documented that **nothing in `src/` reads**, mapped to
 * the name that is actually read.
 *
 * An operator who deployed from the previous template configured Cloudinary under
 * `CLOUDINARY_CLOUD_NAME`, `storage.instance.ts` looked for `STORAGE_CLOUDINARY_CLOUD_NAME`,
 * found nothing, and every upload went to a container-local disk that vanishes on restart —
 * with a clean boot and a `[Storage] Initialized local storage provider` line as the only trace.
 *
 * ── Why this is a WARNING and not an error ───────────────────────────────────
 * Whether an ignored variable matters depends on whether its subsystem is selected. A
 * `.env` carrying `CLOUDINARY_*` under `STORAGE_PROVIDER=local` is stale leftovers: dead and
 * worth removing, but nothing is broken and refusing the boot over it is how a validator gets
 * switched off by the first person it annoys — after which it protects nothing.
 *
 * The dangerous case is caught independently and harder: `STORAGE_PROVIDER=cloudinary` with no
 * `STORAGE_CLOUDINARY_CLOUD_NAME` is a hard error from the storage block below, whichever
 * spelling the operator used. So the severity here tracks the actual blast radius rather than
 * the tidiness of the file.
 *
 * `FATAL_RENAMES` is the exception: a name with no "is this subsystem selected" nuance, where
 * the wrong spelling always means the service is silently using something other than what the
 * operator configured.
 */
const RENAMED_VARS: Readonly<Record<string, string>> = Object.freeze({
    LOCAL_STORAGE_BASE_PATH: 'STORAGE_LOCAL_PATH',
    LOCAL_STORAGE_BASE_URL: 'STORAGE_LOCAL_URL',
    FIREBASE_PROJECT_ID: 'STORAGE_FIREBASE_PROJECT_ID',
    FIREBASE_CLIENT_EMAIL: 'STORAGE_FIREBASE_CLIENT_EMAIL',
    FIREBASE_PRIVATE_KEY: 'STORAGE_FIREBASE_PRIVATE_KEY',
    FIREBASE_BUCKET: 'STORAGE_FIREBASE_BUCKET',
    FIREBASE_PUBLIC: 'STORAGE_FIREBASE_PUBLIC',
    CLOUDINARY_CLOUD_NAME: 'STORAGE_CLOUDINARY_CLOUD_NAME',
    CLOUDINARY_API_KEY: 'STORAGE_CLOUDINARY_API_KEY',
    CLOUDINARY_API_SECRET: 'STORAGE_CLOUDINARY_API_SECRET',
    CLOUDINARY_FOLDER_PREFIX: 'STORAGE_CLOUDINARY_FOLDER_PREFIX',
    // `server.ts` connects with MONGO_URI. MONGODB_URI is read only by `src/scripts/**` and by
    // the `/system/config` wiring probe, so setting it alone yields a clean boot against
    // localhost — the emptiest possible production database.
    MONGODB_URI: 'MONGO_URI',
});

/**
 * Renames that refuse the boot rather than warning.
 *
 * `MONGODB_URI` qualifies because there is no configuration under which it is harmless: the
 * server connects with `MONGO_URI` unconditionally, so the wrong spelling always means the
 * process is talking to a different database than the one the operator wrote down — and it
 * says so nowhere, because connecting to localhost succeeds.
 */
const FATAL_RENAMES = new Set(['MONGODB_URI']);

/** Secrets whose length and non-placeholder-ness are enforced in production. */
const PRODUCTION_SECRETS: readonly string[] = Object.freeze([
    'GEO_TRACKER_WEBHOOK_SECRET',
    'INTERNAL_SERVICE_TOKEN',
    'OAUTH_STATE_SECRET',
    'GOOGLE_TOKEN_ENCRYPTION_KEY',
    'METRICS_SCRAPE_TOKEN',
    'STRIPE_WEBHOOK_SECRET',
]);

// ─────────────────────────────────────────────────────────────────────────────
// The validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check an environment. Pure — takes the source rather than reading `process.env`, so the
 * test suite can exercise it against synthetic environments.
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): EnvProblem[] {
    const problems: EnvProblem[] = [];
    const err = (variable: string, message: string) => problems.push({ level: 'error', variable, message });
    const warn = (variable: string, message: string) => problems.push({ level: 'warning', variable, message });

    const get = (name: string) => raw(source, name);
    const has = (name: string) => isSet(source, name);
    const isProduction = get('NODE_ENV') === 'production';

    // ── Shape ────────────────────────────────────────────────────────────────
    for (const name of INTEGER_VARS) {
        const value = get(name);
        if (value === undefined) continue;
        if (!/^-?\d+$/.test(value)) {
            err(name, `must be an integer, got "${value}". It is parsed with parseInt and would silently fall back to the compiled-in default.`);
        } else if (Number(value) < 0) {
            err(name, `must not be negative, got "${value}". Negative values are discarded by the parser and the default applies instead.`);
        }
    }

    for (const name of NUMBER_VARS) {
        const value = get(name);
        if (value === undefined) continue;
        if (!Number.isFinite(Number(value))) {
            err(name, `must be a number, got "${value}". It would silently fall back to the compiled-in default.`);
        }
    }

    for (const name of BOOLEAN_VARS) {
        const value = get(name);
        if (value === undefined) continue;
        if (!BOOLEAN_LITERALS.has(value.toLowerCase())) {
            err(name, `must be true, false, 1 or 0 — got "${value}". Different modules disagree on how to read an unrecognised value, so this is ambiguous rather than merely wrong.`);
        }
    }

    for (const [name, allowed] of Object.entries(ENUM_VARS)) {
        const value = get(name);
        if (value === undefined) continue;
        if (!allowed.includes(value.toLowerCase())) {
            err(name, `must be one of ${allowed.join(' | ')} — got "${value}".`);
        }
    }

    // ── Variables that were renamed, and whose old spelling reads as nothing ──
    for (const [legacy, current] of Object.entries(RENAMED_VARS)) {
        if (!has(legacy) || has(current)) continue;
        const message = `is not read anywhere in src/. The value is being ignored. Rename it to ${current}.`;
        if (FATAL_RENAMES.has(legacy)) err(legacy, message);
        else warn(legacy, message);
    }

    // ── Database ─────────────────────────────────────────────────────────────
    if (!has('MONGO_URI')) {
        const message = 'is not set. server.ts falls back to mongodb://localhost:27017/jovi-mall.';
        if (isProduction) err('MONGO_URI', `${message} A production instance would boot cleanly against an empty local database.`);
        else warn('MONGO_URI', message);
    }

    // ── CORS ─────────────────────────────────────────────────────────────────
    // Fails closed, which is right, but silently: the browser reports a CORS error and the
    // server logs a successful request, so the fault looks like it is in the frontend.
    if (!has('ALLOWED_ORIGINS')) {
        const message = 'is not set, so NO browser origin may make a credentialed cross-origin request. Every browser client will fail CORS while this service logs the requests as successful.';
        if (isProduction) err('ALLOWED_ORIGINS', message);
        else warn('ALLOWED_ORIGINS', message);
    } else {
        for (const origin of (get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean)) {
            if (!/^https?:\/\/[^/]+$/.test(origin)) {
                err('ALLOWED_ORIGINS', `contains "${origin}", which is not a bare scheme://host[:port] origin. Matching is exact, so a trailing path or slash never matches anything.`);
            } else if (isProduction && origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
                warn('ALLOWED_ORIGINS', `contains the plain-http origin "${origin}". This API is credentialed; cookies sent to it would cross the network in clear text.`);
            }
        }
    }

    // ── Proxy ────────────────────────────────────────────────────────────────
    // Cannot be an error: a service reached directly is a valid deployment and this process
    // has no way to tell. Stated with its consequence so the choice is at least a choice.
    if (!has('TRUST_PROXY')) {
        warn('TRUST_PROXY', 'is not set, so req.ip is the socket address. If anything (ingress, load balancer, CDN) sits in front of this service, every request reports the proxy\'s address: the anonymous rate-limit bucket becomes one bucket for the whole internet, and the audit trail records the proxy for every actor.');
    } else if (isProduction && get('TRUST_PROXY') === 'true') {
        warn('TRUST_PROXY', 'is "true", which trusts the entire X-Forwarded-For chain. Any caller can then spoof req.ip per request and never be rate limited. Prefer a hop count matching the number of proxies you actually run.');
    }

    // ── Storage ──────────────────────────────────────────────────────────────
    // `loadStorageConfig` attaches a provider block only when its first credential is present,
    // so a provider named without credentials reaches the factory with nothing to build from.
    const storageProvider = (get('STORAGE_PROVIDER') ?? 'local').toLowerCase();
    if (storageProvider === 'firebase') {
        for (const name of ['STORAGE_FIREBASE_PROJECT_ID', 'STORAGE_FIREBASE_CLIENT_EMAIL', 'STORAGE_FIREBASE_PRIVATE_KEY', 'STORAGE_FIREBASE_BUCKET']) {
            if (!has(name)) err(name, 'is required when STORAGE_PROVIDER=firebase.');
        }
    } else if (storageProvider === 'cloudinary') {
        for (const name of ['STORAGE_CLOUDINARY_CLOUD_NAME', 'STORAGE_CLOUDINARY_API_KEY', 'STORAGE_CLOUDINARY_API_SECRET']) {
            if (!has(name)) err(name, 'is required when STORAGE_PROVIDER=cloudinary.');
        }
    } else if (storageProvider === 'local' && isProduction) {
        warn('STORAGE_PROVIDER', 'is "local" in production. Uploads are written to the container filesystem and are lost on every restart or redeploy.');
    }

    // ── Geocoding ────────────────────────────────────────────────────────────
    // Only Nominatim has an adapter in this build; the factory throws for the rest. Catching
    // it here means the failure lands at boot rather than on a customer's address search.
    const geoProvider = (get('GEO_PROVIDER') ?? 'nominatim').toLowerCase();
    if (geoProvider === 'google' && !has('GEO_GOOGLE_API_KEY')) {
        err('GEO_GOOGLE_API_KEY', 'is required when GEO_PROVIDER=google.');
    }
    if (geoProvider === 'mapbox' && !has('GEO_MAPBOX_TOKEN')) {
        err('GEO_MAPBOX_TOKEN', 'is required when GEO_PROVIDER=mapbox.');
    }
    if (['google', 'mapbox', 'here', 'geoapify'].includes(geoProvider)) {
        err('GEO_PROVIDER', `is "${geoProvider}", which has no adapter in this build — getGeocodingProvider() throws GEO_PROVIDER_NOT_CONFIGURED on first use. Only "nominatim" is implemented.`);
    }
    if (geoProvider === 'nominatim' && !has('GEO_NOMINATIM_USER_AGENT')) {
        warn('GEO_NOMINATIM_USER_AGENT', 'is not set, so the compiled-in default identifies every deployment identically. The OSM Nominatim usage policy requires an identifying User-Agent and blocks non-compliant callers.');
    }

    // ── Mail ─────────────────────────────────────────────────────────────────
    const mailProvider = (get('MAIL_PROVIDER') ?? 'console').toLowerCase();
    if (mailProvider === 'smtp') {
        if (!has('SMTP_HOST')) err('SMTP_HOST', 'is required when MAIL_PROVIDER=smtp. Nodemailer builds a transport with an undefined host and every send fails at delivery time, not at boot.');
        if (!has('SMTP_USER') || !has('SMTP_PASS')) {
            warn('SMTP_USER/SMTP_PASS', 'are not both set while MAIL_PROVIDER=smtp. Unauthenticated relays exist, but most providers reject on AUTH.');
        }
    } else if (isProduction && mailProvider === 'console') {
        warn('MAIL_PROVIDER', 'is "console" in production. Verification links, password resets and order mail are printed to stdout and never delivered.');
    }

    // ── Payments ─────────────────────────────────────────────────────────────
    if (has('STRIPE_SECRET_KEY') && !has('STRIPE_WEBHOOK_SECRET')) {
        err('STRIPE_WEBHOOK_SECRET', 'is required whenever STRIPE_SECRET_KEY is set. Without it the webhook route cannot verify a signature, so no Stripe payment is ever confirmed — customers are charged and their orders stay unpaid.');
    }
    if (isProduction && get('STRIPE_SECRET_KEY')?.startsWith('sk_test_')) {
        warn('STRIPE_SECRET_KEY', 'is a test-mode key in production. No card will actually be charged.');
    }
    for (const gateway of ['NOTCHPAY', 'MYCOOLPAY'] as const) {
        if (has(`${gateway}_API_KEY`) && !has(`${gateway}_WEBHOOK_SECRET`)) {
            warn(`${gateway}_WEBHOOK_SECRET`, `is not set while ${gateway}_API_KEY is. Signature verification on that gateway's webhook is commented out in webhook.routes.ts, so the callback is currently accepted unverified.`);
        }
    }

    // ── geo-tracker ──────────────────────────────────────────────────────────
    // Inert when the base URL is unset — the documented local default, not a fault.
    if (has('GEO_TRACKER_BASE_URL')) {
        if (!has('GEO_TRACKER_WEBHOOK_SECRET')) {
            err('GEO_TRACKER_WEBHOOK_SECRET', 'is required whenever GEO_TRACKER_BASE_URL is set. It must equal geo-tracker\'s WEBHOOK_HMAC_SECRET; unset, every dispatched event is rejected and the outbox fills with failed rows.');
        }
        if (!has('INTERNAL_SERVICE_TOKEN')) {
            warn('INTERNAL_SERVICE_TOKEN', 'is not set while GEO_TRACKER_BASE_URL is. The inbound half of the contract is disabled (fail-closed), so geo-tracker cannot call GET /api/tracking/visible-agents and every live subscription fails authorization.');
        }
    }

    // ── Frontend URLs used to build notification deep links ──────────────────
    // Each handler omits the button when its URL is unset — a notification arrives with no
    // way to act on it, which reads as a broken template rather than a missing variable.
    for (const [name, audience] of [
        ['VENDOR_APP_URL', 'vendor'],
        ['AGENCY_APP_URL', 'agency'],
        ['AGENT_APP_URL', 'agent'],
        ['STOREFRONT_URL', 'customer'],
    ] as const) {
        if (!has(name)) {
            warn(name, `is not set, so every ${audience} notification is delivered without its action button (email, push and WhatsApp alike).`);
        }
    }

    // ── Metrics ──────────────────────────────────────────────────────────────
    const metricsEnabled = (get('METRICS_ENABLED') ?? 'true').toLowerCase() !== 'false';
    if (metricsEnabled && isProduction && !has('METRICS_SCRAPE_TOKEN') && !has('METRICS_ALLOWED_IPS')) {
        warn('METRICS_SCRAPE_TOKEN', 'is not set in production, so /metrics refuses to serve at all rather than serving openly. Prometheus will scrape 403s. Set a token, set METRICS_ALLOWED_IPS, or set METRICS_ENABLED=false.');
    }

    // ── Secret quality (production only) ─────────────────────────────────────
    // JWT_SECRET and JWT_REFRESH_SECRET are covered by assertSigningSecrets(), which has
    // already run by this point. These are the ones nothing checked.
    if (isProduction) {
        for (const name of PRODUCTION_SECRETS) {
            const value = get(name);
            if (value === undefined) continue;
            if (value.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
                err(name, `is a placeholder or shorter than ${MIN_SECRET_LENGTH} characters.`);
            }
        }

        // This one is not merely weak when unset — `google-token.vault.ts` falls back to a
        // 64-character literal committed to this repository, so every stored Google refresh
        // token would be encrypted with a key that is public.
        if (!has('GOOGLE_TOKEN_ENCRYPTION_KEY') && has('GOOGLE_CLIENT_ID')) {
            err('GOOGLE_TOKEN_ENCRYPTION_KEY', 'is not set while Google Calendar is configured. google-token.vault.ts falls back to a literal key committed to this repository, so the OAuth token vault would be encrypted with a publicly known key.');
        }

        // Same shape: the client id and secret have real-looking hardcoded fallbacks in
        // `google-calendar.client.ts`, so an unset variable silently uses someone's account.
        if (has('GOOGLE_CLIENT_ID') !== has('GOOGLE_CLIENT_SECRET')) {
            err('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET', 'must be set together. google-calendar.client.ts substitutes a hardcoded credential for whichever is missing.');
        }

        if (has('JWT_REFRESH_SECRET') && get('JWT_REFRESH_SECRET') === get('JWT_SECRET')) {
            warn('JWT_REFRESH_SECRET', 'is identical to JWT_SECRET, which provides none of the separation the two were split for: a stolen access token could be replayed as a refresh token. Leaving it unset is equivalent and at least honest about it.');
        }
    }

    // ── Cross-field sanity ───────────────────────────────────────────────────
    const sweepInterval = Number(get('SHIPMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS') ?? 30_000);
    const offerTimeout = Number(get('SHIPMENT_OFFER_TIMEOUT_SECONDS') ?? 120) * 1000;
    if (Number.isFinite(sweepInterval) && Number.isFinite(offerTimeout) && sweepInterval > offerTimeout) {
        warn('SHIPMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS', `(${sweepInterval}ms) is longer than SHIPMENT_OFFER_TIMEOUT_SECONDS (${offerTimeout}ms). An ignored offer then survives a full extra sweep cycle before the next candidate is tried.`);
    }

    const confirmDeadline = Number(get('COD_DEPOSIT_CONFIRM_DEADLINE_DAYS') ?? 2);
    const depositDeadline = Number(get('COD_DEPOSIT_DEADLINE_DAYS') ?? 2);
    if (Number.isFinite(confirmDeadline) && Number.isFinite(depositDeadline) && confirmDeadline > depositDeadline) {
        err('COD_DEPOSIT_CONFIRM_DEADLINE_DAYS', `(${confirmDeadline}) must not exceed COD_DEPOSIT_DEADLINE_DAYS (${depositDeadline}). A declaration suppresses the agent's own late-deposit penalty, so a longer confirmation window is a free way for an agent to park an unfalsifiable claim and stop the clock.`);
    }

    const codFull = Number(get('COD_TRUST_FULL_THRESHOLD') ?? 80);
    const codReduced = Number(get('COD_TRUST_REDUCED_THRESHOLD') ?? 50);
    if (Number.isFinite(codFull) && Number.isFinite(codReduced) && codReduced > codFull) {
        err('COD_TRUST_REDUCED_THRESHOLD', `(${codReduced}) must not exceed COD_TRUST_FULL_THRESHOLD (${codFull}) — the reduced band would be empty and no agent could ever reach the reduced multiplier.`);
    }

    const shipmentsMin = Number(get('AGENT_MAX_ACTIVE_SHIPMENTS_MIN') ?? 1);
    const shipmentsMax = Number(get('AGENT_MAX_ACTIVE_SHIPMENTS_MAX') ?? 100);
    if (Number.isFinite(shipmentsMin) && Number.isFinite(shipmentsMax) && shipmentsMin > shipmentsMax) {
        err('AGENT_MAX_ACTIVE_SHIPMENTS_MIN', `(${shipmentsMin}) must not exceed AGENT_MAX_ACTIVE_SHIPMENTS_MAX (${shipmentsMax}).`);
    }

    // `LOG_PERSIST_LEVEL` below `info` is clamped rather than honoured — say so, because the
    // symptom otherwise is a capped collection that turns over in minutes.
    const persistLevel = get('LOG_PERSIST_LEVEL')?.toLowerCase();
    if (persistLevel === 'trace' || persistLevel === 'debug') {
        warn('LOG_PERSIST_LEVEL', `is "${persistLevel}", which is below the enforced floor of "info" and will be clamped. Persisting debug turns the capped collection over in minutes and evicts exactly the errors it exists to keep.`);
    }

    return problems;
}

/** Format problems into one operator-readable block. */
export function formatEnvProblems(problems: EnvProblem[]): string {
    const errors = problems.filter((p) => p.level === 'error');
    const warnings = problems.filter((p) => p.level === 'warning');
    const lines: string[] = [];

    if (errors.length > 0) {
        lines.push(`Invalid environment configuration — ${errors.length} problem(s) must be fixed:`);
        lines.push(...errors.map((p) => `  ✖ ${p.variable} ${p.message}`));
    }
    if (warnings.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`Environment warnings — ${warnings.length} item(s), the service will still start:`);
        lines.push(...warnings.map((p) => `  ⚠ ${p.variable} ${p.message}`));
    }
    return lines.join('\n');
}

/**
 * Boot guard. Called from `server.ts` beside `assertSigningSecrets()`.
 *
 * Warnings are printed and the boot continues; errors kill the process. Deliberately plain
 * text on stderr in addition to the logger — a configuration failure should be readable
 * without a JSON decoder, and this is exactly the class of failure an operator reads over
 * SSH at three in the morning.
 */
export function assertEnvironment(source: NodeJS.ProcessEnv = process.env): void {
    const problems = validateEnv(source);
    if (problems.length === 0) return;

    const report = formatEnvProblems(problems);
    process.stderr.write(`\n${report}\n\n`);

    const errors = problems.filter((p) => p.level === 'error');
    if (errors.length === 0) return;

    throw createAppError(
        ERROR_CODES.CONFIG_INVALID_ENV,
        500,
        `Invalid environment configuration: ${errors.length} problem(s). See the report above.`,
        { errorCount: errors.length, warningCount: problems.length - errors.length },
    );
}

/** Every variable this validator knows how to check, for the drift test. */
export const VALIDATED_VARS: readonly string[] = Object.freeze([
    ...INTEGER_VARS,
    ...NUMBER_VARS,
    ...BOOLEAN_VARS,
    ...Object.keys(ENUM_VARS),
]);
