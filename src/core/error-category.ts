import { ErrorCode, ERROR_CODES } from './error-codes';

/**
 * The nine-value error taxonomy (Phase 16).
 *
 * ── Why this file is a SIBLING of `error-codes.ts` and not `errors/category.ts` ──
 * `src/core/errors.ts` already exists as a FILE. Adding `src/core/errors/` beside it would
 * make `import … from './core/errors'` ambiguous — TypeScript resolves the file over the
 * directory, so the directory's `index.ts` would be silently unreachable and the mistake
 * would be invisible in a diff. Flat siblings, deliberately.
 *
 * ── What a category is FOR ────────────────────────────────────────────────────
 * Exposure and telemetry. Nothing branches business logic on it, and nothing ever should:
 * that property is what makes a wrong derivation a degraded diagnostic rather than a
 * behaviour change, which is the only reason deriving 623 codes' categories from a table
 * is a safe thing to do at all.
 *
 * The same nine strings exist in wi-admin (`src/core/errors/error-category.ts`) and in
 * geo-tracker (`internal/platform/apperror/category.go`). There is no shared package
 * between the three services, so **each service's test asserts the exact nine sorted names
 * against a hardcoded literal** — that assertion is the contract copy.
 */
export const ERROR_CATEGORIES = Object.freeze({
    /** Who are you? — no credential, a bad one, an expired one, a disabled account. */
    AUTHENTICATION: 'authentication',
    /** May you? — a known caller reaching something that is not theirs. */
    AUTHORIZATION: 'authorization',
    /** The request could not be read, or failed a schema rule. */
    VALIDATION: 'validation',
    /** No such thing — including "exists, but not yours", where 404 hides existence. */
    NOT_FOUND: 'not_found',
    /** The state moved under the caller: a compare-and-set miss, a duplicate key. */
    CONFLICT: 'conflict',
    /** Well-formed, permitted, and refused by a rule of the domain. */
    BUSINESS_RULE: 'business_rule',
    /** Too many requests. */
    RATE_LIMIT: 'rate_limit',
    /** Somebody else's fault: a gateway, a provider, a sibling service. */
    EXTERNAL_SERVICE: 'external_service',
    /** Ours. A bug, a broken invariant, a misconfiguration. */
    INTERNAL: 'internal',
} as const);

export type ErrorCategory = (typeof ERROR_CATEGORIES)[keyof typeof ERROR_CATEGORIES];

/** Sorted, for the cross-service contract assertion. Do not reorder — sort at the call site. */
export const ERROR_CATEGORY_VALUES: readonly ErrorCategory[] = Object.freeze(
    Object.values(ERROR_CATEGORIES),
);

export function isErrorCategory(value: unknown): value is ErrorCategory {
    return typeof value === 'string' && (ERROR_CATEGORY_VALUES as readonly string[]).includes(value);
}

/**
 * The categories whose `message` and `details` may reach a client unchanged.
 *
 * The two absentees are the whole point of Phase 16: `external_service` carries a third
 * party's prose and `internal` carries ours, and neither is written for the person holding
 * the browser. See `error-detail-policy.ts`.
 */
export const CLIENT_SAFE_CATEGORIES: ReadonlySet<ErrorCategory> = Object.freeze(
    new Set<ErrorCategory>([
        ERROR_CATEGORIES.AUTHENTICATION,
        ERROR_CATEGORIES.AUTHORIZATION,
        ERROR_CATEGORIES.VALIDATION,
        ERROR_CATEGORIES.NOT_FOUND,
        ERROR_CATEGORIES.CONFLICT,
        ERROR_CATEGORIES.BUSINESS_RULE,
        ERROR_CATEGORIES.RATE_LIMIT,
    ]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — the override table
// ─────────────────────────────────────────────────────────────────────────────

interface CategoryOverride {
    category: ErrorCategory;
    /**
     * Why the status number is the wrong answer here. Asserted non-empty by `test:errors`.
     *
     * An override with no reason is a category somebody nudged until a test passed, and the
     * next person cannot tell it from a decision.
     */
    reason: string;
}

/**
 * Codes whose category the status rule gets wrong.
 *
 * Kept SMALL on purpose. Every entry here is a place where the HTTP status is a poor
 * summary of what happened, and the honest fix for most of them would be a different
 * status — which ADR-005 D-1 makes a breaking change. So the category corrects the
 * *classification* while the wire keeps its promise.
 *
 * `test:errors` refuses an entry that agrees with what the rules already derive: a dead
 * override is dead policy, the same argument `tier-grants.ts` makes about a permission
 * granted to no tier.
 */
export const CATEGORY_OVERRIDES: Partial<Record<ErrorCode, CategoryOverride>> = Object.freeze({
    // `STORAGE_UPLOAD_FAILED` and `STORAGE_DELETE_FAILED` were here and have been REMOVED:
    // the `STORAGE_` entry in `INTEGRATION_PREFIXES` already resolves them to
    // `external_service` at 5xx, so the overrides agreed with the rules and said nothing.
    // `test:errors` refuses that — see the dead-override assertion.

    // ── Statuses that describe a DECISION, not a fault ───────────────────────
    [ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE]: {
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        reason:
            'A 503, but nothing is broken — an operator closed the platform deliberately. Filing it '
            + 'as external_service would mask its message, and that message is written FOR the shopper',
    },
    [ERROR_CODES.REFUND_GATEWAY_NOT_SUPPORTED]: {
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        reason:
            'A 501, but api-doc documents it as an expected outcome callers must handle: NotchPay and '
            + 'MyCoolPay have no refund API. Nothing failed and nothing is coming',
    },
    [ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED]: {
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        reason: 'A 501 that means "that gateway is not on offer", which is a rule, not a fault',
    },

    // ── Config faults wearing a 503 ──────────────────────────────────────────
    // These fire when a secret is unset. That is our deployment, not a third party being
    // down, and an operator reading `external_service` would go looking at the wrong system.
    [ERROR_CODES.AUTH_ADMIN_CALLER_NOT_CONFIGURED]: {
        category: ERROR_CATEGORIES.INTERNAL,
        reason: 'A 503 raised because INTERNAL_ADMIN_SERVICE_TOKEN is unset — our config, not an outage',
    },
    [ERROR_CODES.AGENT_SERVICE_TOKEN_NOT_CONFIGURED]: {
        category: ERROR_CATEGORIES.INTERNAL,
        reason: 'A 503 raised because INTERNAL_SERVICE_TOKEN is unset — our config, not an outage',
    },
    [ERROR_CODES.GEO_PROVIDER_NOT_CONFIGURED]: {
        category: ERROR_CATEGORIES.INTERNAL,
        reason: 'GEO_PROVIDER names an adapter this build does not ship — a config fault, not a provider outage',
    },

    // ── Suspension is "you may not be here at all", not "not this resource" ──
    // Both are 403s, so the status rule says authorization. But an authorization failure is
    // survivable by asking for something else, and these are not: the session is over. A
    // client that treats them as authorization keeps the user on a page they can no longer
    // use. Categorising them as authentication is what makes "sign out" the obvious handler.
    [ERROR_CODES.AUTH_ACCOUNT_SUSPENDED]: {
        category: ERROR_CATEGORIES.AUTHENTICATION,
        reason: 'A 403 by wire contract, but the account cannot authenticate at all — not a per-resource denial',
    },
    [ERROR_CODES.AUTH_VENDOR_SUSPENDED]: {
        category: ERROR_CATEGORIES.AUTHENTICATION,
        reason: 'Same as AUTH_ACCOUNT_SUSPENDED, one axis down: the vendor role entity is switched off',
    },
    [ERROR_CODES.AUTH_ACCOUNT_CLOSED]: {
        category: ERROR_CATEGORIES.AUTHENTICATION,
        reason:
            'Same 403-but-the-session-is-over shape as AUTH_ACCOUNT_SUSPENDED, and more final: the '
            + 'account was anonymised by its owner and no other resource will authorize either',
    },

    // ── 400s that are really state errors ────────────────────────────────────
    // The 400 is historical (`connection.service.ts:234,390` predate the 422 convention) and
    // ADR-005 D-1 makes changing it breaking. The category records what it actually is.
    [ERROR_CODES.CONNECTION_INVALID_STATUS_TRANSITION]: {
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        reason: 'A 400 for wire-compat, but the payload was fine — the connection was in the wrong state',
    },
    [ERROR_CODES.DELIVERY_ONBOARDING_STEP_INVALID]: {
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        reason: 'A 400, but the request parsed — the agency is not at that onboarding step',
    },
    [ERROR_CODES.AUTH_ROLE_REQUIRED]: {
        category: ERROR_CATEGORIES.BUSINESS_RULE,
        reason: 'A 400 meaning "pick which of your roles you are acting as" — a flow step, not a bad payload',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — the integration-prefix rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Code prefixes owned by a third party. At `status >= 500` they are that party's failure.
 *
 * A prefix rule rather than ~40 override rows, and it covers codes added later by
 * construction. It is deliberately gated on 5xx: `GOOGLE_CALENDAR_NOT_CONNECTED` at 404 is
 * a fact about our data, not about Google being down.
 */
const INTEGRATION_PREFIXES: readonly string[] = Object.freeze([
    'STRIPE_',
    'GOOGLE_',
    'WHATSAPP_',
    'TELEGRAM_',
    'STORAGE_',
    'GEO_',
    'MAIL_',
    'NOTCHPAY_',
    'MYCOOLPAY_',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — the status rule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exact-status answers. Anything not listed falls to the band rule below, which is total.
 *
 * ── 400 vs 422 is the load-bearing row, and this service already decided it ────
 * 400 means the payload was wrong; 422 means the payload was fine and a RULE refused it.
 * That split is not aspirational here — it is what 136 and 139 call sites respectively
 * already do, and `api-doc/errors/README.md` documents it endpoint by endpoint
 * (`COD_NOT_AVAILABLE_FOR_DIGITAL` 422 "COD checkout on a digital cart",
 * `AGENT_MEMBERSHIP_LIMIT_REACHED` 422 "the agent is at their agency cap"). So 422 is
 * `business_rule`, not `validation`. Filing it as validation would tell a frontend to
 * highlight a form field for "this agency does not handle cash on delivery".
 *
 * 423 goes the same way: both users of it — `COD_CODE_ATTEMPTS_EXCEEDED` and
 * `ORDER_DISPUTE_HOLD` — are the platform refusing on purpose, not a state race.
 */
const STATUS_CATEGORY: Readonly<Record<number, ErrorCategory>> = Object.freeze({
    400: ERROR_CATEGORIES.VALIDATION,
    401: ERROR_CATEGORIES.AUTHENTICATION,
    403: ERROR_CATEGORIES.AUTHORIZATION,
    404: ERROR_CATEGORIES.NOT_FOUND,
    409: ERROR_CATEGORIES.CONFLICT,
    410: ERROR_CATEGORIES.NOT_FOUND,
    413: ERROR_CATEGORIES.VALIDATION,
    415: ERROR_CATEGORIES.VALIDATION,
    422: ERROR_CATEGORIES.BUSINESS_RULE,
    423: ERROR_CATEGORIES.BUSINESS_RULE,
    429: ERROR_CATEGORIES.RATE_LIMIT,
    502: ERROR_CATEGORIES.EXTERNAL_SERVICE,
    503: ERROR_CATEGORIES.EXTERNAL_SERVICE,
    504: ERROR_CATEGORIES.EXTERNAL_SERVICE,
});

/**
 * The category of an error, from its code and the status it is being raised at.
 *
 * Three tiers, first match wins: the override table, then the integration-prefix rule for
 * 5xx, then the status. Total over every integer — an unrecognised status is `internal`,
 * because a status we cannot classify is a bug in us.
 *
 * Note it takes BOTH arguments. Category is not a property of a code: `INTERNAL_SERVER_ERROR`
 * is raised at 500 by the global handler and at 502 by `google-calendar.client.ts`, and those
 * are genuinely different situations. `test:errors` censuses every call site and fails if any
 * code yields two categories — that scan is what found the calendar client.
 */
export function categoryFor(code: string, statusCode: number): ErrorCategory {
    const override = CATEGORY_OVERRIDES[code as ErrorCode];
    if (override) return override.category;

    if (statusCode >= 500 && INTEGRATION_PREFIXES.some((prefix) => code.startsWith(prefix))) {
        return ERROR_CATEGORIES.EXTERNAL_SERVICE;
    }

    const exact = STATUS_CATEGORY[statusCode];
    if (exact) return exact;

    // 402, 405, 406, 428, 451 and anything else in the 4xx band: the request was
    // intelligible and we refused it, which is what business_rule means.
    if (statusCode >= 400 && statusCode < 500) return ERROR_CATEGORIES.BUSINESS_RULE;

    // 500, 501, and every other 5xx not named above.
    return ERROR_CATEGORIES.INTERNAL;
}

/**
 * The one-line explanation a support agent reads instead of the internal message.
 *
 * Per category rather than per code — 623 hints would be 623 chances to write one that is
 * wrong, and the category is what actually determines what Support can DO about it.
 */
export const SUPPORT_HINTS: Readonly<Record<ErrorCategory, string>> = Object.freeze({
    [ERROR_CATEGORIES.AUTHENTICATION]:
        'The caller was not signed in, or their session had ended. Ask them to sign in again.',
    [ERROR_CATEGORIES.AUTHORIZATION]:
        'The caller is signed in but reached something that is not theirs. Check which account and role they are using.',
    [ERROR_CATEGORIES.VALIDATION]:
        'The request was malformed or failed a field rule. Usually a client-side problem — ask what they entered.',
    [ERROR_CATEGORIES.NOT_FOUND]:
        'The record does not exist, or does not belong to that caller. Confirm the reference they used.',
    [ERROR_CATEGORIES.CONFLICT]:
        'Something changed underneath them — often another person acting at the same moment. Ask them to reload and retry.',
    [ERROR_CATEGORIES.BUSINESS_RULE]:
        'The platform refused this on purpose. The message explains which rule; it is not a fault.',
    [ERROR_CATEGORIES.RATE_LIMIT]:
        'Too many requests in a short window. It clears itself — ask them to wait a minute before retrying.',
    [ERROR_CATEGORIES.EXTERNAL_SERVICE]:
        'A third-party service (payment gateway, maps, messaging) did not respond. Not the caller’s fault and not fixable by them — escalate with the reference.',
    [ERROR_CATEGORIES.INTERNAL]:
        'A fault on our side. Nothing the caller can do. Escalate with the reference.',
});
