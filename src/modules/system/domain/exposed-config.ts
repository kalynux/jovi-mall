import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { SENSITIVE_FIELD_NAMES } from '../../../core/audit/redact';
import { isFcmConfigured } from '../../../config/fcm.config';
import { internalAdminApiEnabled } from '../../../config/internal-admin.config';
import { getGeocodingProviderType } from '../../../core/geocoding/geocoding.instance';
import { getStorageProviderType } from '../../../core/storage/storage.instance';
import { internalApiEnabled } from '../../agents/config/agent.config';
import { trackingIntegrationEnabled } from '../../tracking-integration/config/tracking-integration.config';

/**
 * Which runtime configuration `GET /api/internal/admin/system/config` may reveal.
 *
 * The jovi-mall counterpart of `admin/src/modules/system/domain/exposed-config.ts`, deliberately
 * kept diffable against it. ADR-014 named this read as the natural follow-up it did not build,
 * and named the reason it is not trivial: the discipline has to be reproduced here, not assumed.
 *
 * ── Built by NAMING keys, never by spreading process.env ──────────────────────
 * The obvious implementation — return everything and delete the secrets — is the wrong way
 * round: it is open by default, and the day somebody adds a `*_API_KEY` to a config module it
 * appears on this endpoint without anyone touching this file. This service reads **144 distinct
 * environment variables**, at least 28 of which are credentials. A whitelist is the same choice
 * the platform read repositories make about projections, for the same reason.
 *
 * ── And then checked again, because a whitelist is only as good as its author ──
 * `assertExposedConfigSafe()` runs at boot and refuses a key that LOOKS credential-shaped even
 * if it is listed here. That is belt-and-braces on purpose: this list gets edited by hand, under
 * time pressure, by somebody who wants to see one more value on a dashboard.
 *
 * ── `SMTP_USER` is the deliberate omission the assertion CANNOT catch ─────────
 * It matches no forbidden token and is no sensitive leaf name, yet it is half a credential. It
 * is absent because a human decided so, which is the honest demonstration that the whitelist is
 * the primary control and the regex is the backstop. `SMTP_HOST` and `SMTP_PORT` are absent for
 * a second-order reason worth stating: they are not sensitive, but listing them puts an obvious
 * blank line next to `SMTP_USER` and invites the next author to "complete the set". What an
 * operator actually needs — is mail configured at all — is on `/system/integrations` already.
 *
 * ── No URLs or URIs, and a derived `wiring` block instead ─────────────────────
 * The token rule refuses every `*_URL` / `*_URI`, which is correct: `MONGO_URI` and `REDIS_URL`
 * carry a password in userinfo in every real deployment, and `GEO_TRACKER_BASE_URL` is internal
 * topology. That would leave a real gap — "is the dispatcher pointed at anything" — so the gap
 * is filled by DERIVING the answer rather than by weakening the rule. See `configWiring()`.
 */
export const EXPOSED_CONFIG_KEYS = Object.freeze([
    // ── Identity ─────────────────────────────────────────────────────────────
    'NODE_ENV',
    'PORT',
    'LOG_LEVEL',

    // ── The operations surface's own behaviour ───────────────────────────────
    'HEALTH_PROBE_TIMEOUT_MS',
    'HEALTH_READY_REQUIRE_REDIS',
    'SYSTEM_INTEGRATION_PROBE_TIMEOUT_MS',
    'MAINTENANCE_CACHE_TTL_MS',
    'METRICS_ENABLED',
    'CACHE_FLUSH_MAX_KEYS',
    'CACHE_FLUSH_BUDGET_MS',

    // ── Logging (Phase 15) ───────────────────────────────────────────────────
    'LOG_CONSOLE_BRIDGE',
    'LOG_HTTP_ACCESS',
    'LOG_RING_SIZE',
    'LOG_RING_MAX_BYTES',
    'LOG_PERSIST_ENABLED',
    'LOG_PERSIST_LEVEL',
    'LOG_MONGO_CAP_BYTES',
    'LOG_MONGO_CAP_MAX_DOCS',

    /**
     * ── Worker cadences — the highest-value block on this endpoint ────────────
     * "Why hasn't the sweep run" is the commonest operational question here, and
     * `/system/workers` answers what the schedule IS without saying which variable changes it.
     * These two reads are complementary: `/workers` reports the schedule in force (derived from
     * the worker itself), this reports what has been configured.
     */
    'EARNINGS_CRON',
    'FILE_CLEANUP_CRON',
    'FILE_CLEANUP_ENABLED',
    'FILE_CLEANUP_DRY_RUN',
    'UNPAID_ORDER_CANCEL_CRON',
    'UNPAID_ORDER_CANCEL_ENABLED',
    'UNPAID_ORDER_CANCEL_DRY_RUN',
    'COD_DEPOSIT_SWEEP_CRON',
    'AGENT_CAPACITY_RECONCILE_CRON',
    'AGENT_TRUST_RECOMPUTE_CRON',
    'AGENT_TRUST_RECOMPUTE_ENABLED',
    'ANALYTICS_AGGREGATION_CRON',
    'GEO_TRACKER_DISPATCH_INTERVAL_MS',
    'GEO_TRACKER_DISPATCH_BATCH_SIZE',
    'GEO_TRACKER_MAX_ATTEMPTS',
    'GEO_TRACKER_REQUEST_TIMEOUT_MS',
    'BOOKING_REMINDER_ENABLED',
    'BOOKING_REMINDER_INTERVAL_MS',
    'BOOKING_REMINDER_LEAD_MINUTES',
    'BOOKING_UNPAID_EXPIRY_ENABLED',
    'BOOKING_UNPAID_EXPIRY_INTERVAL_MS',
    'BOOKING_UNPAID_EXPIRY_AFTER_MINUTES',
    'CALENDAR_SYNC_ENABLED',
    'CALENDAR_SYNC_NEAR_INTERVAL_MS',
    'CALENDAR_SYNC_FAR_INTERVAL_MS',
    'SHIPMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS',
    'SHIPMENT_OFFER_TIMEOUT_SECONDS',
    'SHIPMENT_ASSIGNMENT_MAX_ROUNDS',
    'SHIPMENT_ASSIGNMENT_MAX_CANDIDATES',

    // ── Which adapter is live ────────────────────────────────────────────────
    'STORAGE_PROVIDER',
    'GEO_PROVIDER',
    'MAIL_PROVIDER',
    'FCM_ENABLED',

    /**
     * ── The policy that decides eligibility ──────────────────────────────────
     * The source of "why is every agent undispatchable", which is otherwise a code read.
     */
    'AGENT_REQUIRE_DEVICE_LOCATION',
    'AGENT_UNKNOWN_DEVICE_LOCATION_POLICY',
    'AGENT_TRACKING_ALLOWED_BY_DEFAULT',

    // ── Upload governance ────────────────────────────────────────────────────
    'UPLOAD_MAX_FILES_PER_REQUEST',
    'UPLOAD_MAX_TOTAL_SIZE_BYTES',
    'UPLOAD_USER_QUOTAS_ENABLED',
    'UPLOAD_USER_QUOTA_MAX_BYTES',
    'UPLOAD_USER_QUOTA_MAX_FILES',
    'UPLOAD_VIRUS_SCAN_ENABLED',
    'UPLOAD_DUPLICATE_DETECTION_ENABLED',

    // ── Money display ────────────────────────────────────────────────────────
    'STRIPE_CHARGE_CURRENCY',
    'STRIPE_XAF_PER_USD',
    'EARNINGS_CURRENCY',
    'EARNINGS_HOLD_DAYS',
    'CREDIT_COST_VECTORISATION',
    'CREDIT_COST_WHATSAPP_TEMPLATE',
] as const);

export type ExposedConfigKey = (typeof EXPOSED_CONFIG_KEYS)[number];

/**
 * Names that may never be exposed, whatever the list above says.
 *
 * **Byte-identical to wi-admin's**, and that is a decision rather than laziness: two regexes for
 * one job is how one of them ends up weaker. `test:system` asserts both that the source string
 * matches and — more usefully — that it rejects every one of this service's real credential
 * variable names.
 *
 * ── Why the token may appear ANYWHERE, not only at the end ────────────────────
 * The obvious version anchors to the end (`_SECRET$`), which reads naturally and is wrong for
 * the most important case in this service: `MONGO_URI` is fine but `MONGODB_URI` is too, and
 * wi-admin's `MONGO_URI_ADMIN` / `MONGO_URI_PLATFORM` carry the password while ending in
 * `_ADMIN` / `_PLATFORM`. A suffix rule waves those through.
 *
 * So the check is "does any underscore-separated segment name a credential", which catches
 * `STRIPE_SECRET_KEY`, `GEO_MAPBOX_TOKEN` and `WHATSAPP_API_URL` alike. `SHIPMENT_OFFER_TIMEOUT_SECONDS`
 * is deliberately NOT a false positive — `TIMEOUT` is not `TOKEN`.
 */
export const FORBIDDEN_CONFIG_TOKEN = /(^|_)(URI|URL|SECRET|TOKEN|KEY|PASSWORD|PASS|DSN|CREDENTIALS|CREDENTIAL)(_|$)/;

/**
 * Refuse to start if the whitelist names something credential-shaped.
 *
 * Called from `startServer()` beside `assertSigningSecrets()` and `assertInternalAdminToken()`,
 * before `mongoose.connect`. It is a pure function of code, so it costs nothing to run first —
 * and a whitelist naming a secret must kill the process before anything can serve it.
 */
export function assertExposedConfigSafe(): void {
    const problems: string[] = [];

    for (const key of EXPOSED_CONFIG_KEYS) {
        if (FORBIDDEN_CONFIG_TOKEN.test(key)) {
            problems.push(`${key} — contains a segment reserved for credentials`);
            continue;
        }

        const leaf = key.toLowerCase().split('_').pop() ?? '';
        if (SENSITIVE_FIELD_NAMES.has(leaf) || SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
            problems.push(`${key} — matches a redacted field name`);
        }
    }

    if (problems.length > 0) {
        throw createAppError(
            ERROR_CODES.SYSTEM_CONFIG_EXPOSURE_UNSAFE,
            500,
            `EXPOSED_CONFIG_KEYS names values that must not be served:\n  ${problems.join('\n  ')}`,
            { problems },
        );
    }
}

export interface ExposedConfigEntry {
    key: ExposedConfigKey;
    value: string | number | boolean | null;
    /**
     * Whether the variable is actually set in this process's environment.
     *
     * The distinction matters and is not pedantry: this service has no central validated config
     * object, so almost every one of these has a compiled-in default applied by its own
     * `*.config.ts`. Reporting a bare `null` for an unset key would read as "this feature has no
     * schedule" when it means "the default applies". `set: false` says which, and
     * `/system/workers` reports the value actually in force.
     */
    set: boolean;
}

/** The whitelisted configuration, as the endpoint serves it. */
export function exposedConfig(): ExposedConfigEntry[] {
    return EXPOSED_CONFIG_KEYS.map((key) => {
        const raw = process.env[key];
        return {
            key,
            value: raw === undefined || raw === '' ? null : raw,
            set: raw !== undefined && raw !== '',
        };
    });
}

/**
 * The derived answers that the no-URLs rule would otherwise cost an operator.
 *
 * Every entry here is a predicate that already existed and, before Phase 14, sat on no route at
 * all. None of them can carry a password by construction — that is what makes this better than
 * exposing the base URLs it replaces, not merely safer. The Stripe key MODE is the same
 * leak-free fact ADR-014 D-2 already decided to report on `/system/integrations`.
 */
export function configWiring(): Record<string, unknown> {
    const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';

    return {
        geoTrackerConfigured: trackingIntegrationEnabled(),
        internalAdminApiEnabled: internalAdminApiEnabled(),
        internalAgentsApiEnabled: internalApiEnabled(),
        storageProvider: getStorageProviderType(),
        geoProvider: getGeocodingProviderType(),
        fcmConfigured: isFcmConfigured(),
        stripeKeyMode: stripeKey.startsWith('sk_live_') ? 'live' : stripeKey.startsWith('sk_test_') ? 'test' : null,
        mongoConfigured: Boolean(process.env.MONGO_URI ?? process.env.MONGODB_URI),
        redisConfigured: Boolean(process.env.REDIS_URL),
    };
}
