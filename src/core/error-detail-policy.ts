import { SENSITIVE_FIELD_NAMES } from './audit/redact';
import { ERROR_CATEGORIES, ErrorCategory } from './error-category';

/**
 * What of an error's `details` a CLIENT is allowed to see (Phase 16).
 *
 * ── The rule this file exists to enforce ──────────────────────────────────────
 * Filtering happens at the BOUNDARY, keyed on category — never at the throw site. That is
 * the whole design. `payment-orchestrator.service.ts` raises five errors carrying
 * `{ cause: error.message }`, which is raw axios/gateway prose, and
 * `google-calendar.client.ts:246` carries Google's own error body. Not one of those files
 * is edited by Phase 16: they are `external_service`, and this module drops their details
 * on the way out. A rule enforced at 1362 call sites is a rule enforced at 1361 of them.
 *
 * ── And it is not environment-gated ───────────────────────────────────────────
 * `internal` and `external_service` are filtered in development exactly as in production.
 * A masking rule that only runs in prod is a rule nobody has ever seen work; `test:errors`
 * asserts the two environments produce identical output for those categories.
 *
 * Everything here is pure. No I/O, no logger, no request.
 */

/** Serialised ceiling for anything that reaches a client. `details` is not a payload channel. */
export const MAX_DETAILS_BYTES = 8 * 1024;

/** Nesting ceiling. `details.blockers[].details` is the deepest legitimate shape at 4. */
export const MAX_DETAILS_DEPTH = 4;

/**
 * Keys an `authorization` failure may carry, and no others.
 *
 * The exclusion is the point: `requireRole` currently sends `{ required, actual }`, echoing
 * the caller's own role back. wi-admin's `authorize.middleware.ts` deliberately sends only
 * `required` and its ADR calls the pair a leak. Matching it here is the cheaper half of that
 * fix — the call site keeps its shape, and `actual` never leaves the process.
 */
const AUTHORIZATION_DETAIL_KEYS: ReadonlySet<string> = Object.freeze(
    new Set(['required', 'requiredany', 'resource', 'hint']),
);

/** Keys a `rate_limit` refusal may carry. */
const RATE_LIMIT_DETAIL_KEYS: ReadonlySet<string> = Object.freeze(
    new Set(['retryafterseconds', 'limit', 'windowseconds']),
);

/**
 * Key names that carry an internal narrative rather than a fact about the caller's request.
 *
 * These are dropped from EVERY category, including the client-safe ones — a `cause` on a
 * 422 is as much our prose as a `cause` on a 502, it just happens to be attached to an
 * error the caller may otherwise read in full.
 *
 * Compared lower-cased with separators stripped, so `originalError`, `original_error` and
 * `ORIGINALERROR` all match. Unioned with `SENSITIVE_FIELD_NAMES` from `audit/redact.ts`
 * rather than restating it: that file's own header says a copy nothing checks is a copy
 * that rots.
 */
const INTERNAL_DETAIL_KEYS: ReadonlySet<string> = Object.freeze(
    new Set([
        'cause',
        'causemessage',
        'stack',
        'originalerror',
        'originalcode',
        'originalmessage',
        'upstream',
        'upstreamerror',
        'upstreambody',
        'response',
        'responsebody',
        'rawresponse',
        'raw',
        'sql',
        'query',
        'command',
        'dsn',
        'connectionstring',
        'env',
        'config',
        'hostname',
    ]),
);

/** `originalCode` → `originalcode`, `retry_after_seconds` → `retryafterseconds`. */
function normaliseKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDroppedKey(key: string): boolean {
    const normalised = normaliseKey(key);
    return INTERNAL_DETAIL_KEYS.has(normalised) || SENSITIVE_FIELD_NAMES.has(normalised);
}

/**
 * Recursively drop internal keys, bounding depth.
 *
 * Arrays are walked, because `details.violations[]`, `details.fields[]` and
 * `details.blockers[]` are all real client-facing shapes that nest objects. Beyond
 * `MAX_DETAILS_DEPTH` a value is replaced rather than truncated silently — a client seeing
 * `'[TRUNCATED]'` can at least tell that something was there.
 */
function scrubValue(value: unknown, depth: number): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DETAILS_DEPTH) return '[TRUNCATED]';

    if (Array.isArray(value)) {
        return value.map((entry) => scrubValue(entry, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (isDroppedKey(key)) continue;
        output[key] = scrubValue(entry, depth + 1);
    }
    return output;
}

/** Keep only an allowlisted set of top-level keys, then scrub what survives. */
function pickKeys(
    details: Record<string, unknown>,
    allowed: ReadonlySet<string>,
): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (!allowed.has(normaliseKey(key))) continue;
        output[key] = scrubValue(value, 1);
    }
    return output;
}

/**
 * The client's copy of `details`, or `undefined` when there is none to give.
 *
 * `undefined` rather than `{}` or `null` — the global handler spreads it conditionally, and
 * ADR-005 D-9 requires `details` to be **omitted entirely** when absent. An empty object on
 * the wire is a promise that something might arrive there later.
 */
export function projectDetails(
    category: ErrorCategory,
    details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (details === undefined || details === null) return undefined;

    // The two masked categories. Nothing survives — not one key, in any environment.
    if (category === ERROR_CATEGORIES.INTERNAL || category === ERROR_CATEGORIES.EXTERNAL_SERVICE) {
        return undefined;
    }

    let projected: Record<string, unknown>;
    if (category === ERROR_CATEGORIES.AUTHORIZATION) {
        projected = pickKeys(details, AUTHORIZATION_DETAIL_KEYS);
    } else if (category === ERROR_CATEGORIES.RATE_LIMIT) {
        projected = pickKeys(details, RATE_LIMIT_DETAIL_KEYS);
    } else {
        projected = scrubValue(details, 0) as Record<string, unknown>;
    }

    if (Object.keys(projected).length === 0) return undefined;

    // Size is checked last, on the projected copy, because scrubbing is what usually brings
    // an oversized payload back under the ceiling.
    let serialised: string;
    try {
        serialised = JSON.stringify(projected);
    } catch {
        // A cycle. `redact.ts` tolerates one by marking it; here the safe answer is to send
        // nothing, since a client has no use for a self-referential object anyway.
        return { truncated: true };
    }

    if (serialised.length > MAX_DETAILS_BYTES) {
        return { truncated: true, bytes: serialised.length };
    }

    return projected;
}

/**
 * The client's copy of an error `message`.
 *
 * For the masked categories the registry's default for that code is used — never the thrown
 * message, which may name a collection, a variable or a third party's failure mode. When
 * the code has no default the caller gets the generic one, which is the correct outcome:
 * "we do not have a sentence for this yet" and "here is our internal sentence" are very
 * different things to say to a customer.
 */
export function projectMessage(
    category: ErrorCategory,
    thrownMessage: string,
    registryDefault: string | undefined,
): string {
    if (category === ERROR_CATEGORIES.INTERNAL || category === ERROR_CATEGORIES.EXTERNAL_SERVICE) {
        return registryDefault ?? 'Something went wrong';
    }
    return thrownMessage;
}
