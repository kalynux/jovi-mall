/**
 * Redaction for the admin-action log.
 *
 * ── Why this is a copy rather than an import ──────────────────────────────────
 * The original is `admin/src/modules/audit/domain/audit-state.ts`, and the two services
 * share no package — the same reason `infra/platform/collections.ts` is a verbatim copy of
 * this repo's `core/database/collections.ts`. Importing across the boundary would drag
 * wi-admin's config, its logger and its Mongoose connections into this process.
 *
 * Kept honest by a drift test: wi-admin's `test-audit.ts` reads THIS file and fails if a
 * name in its `SENSITIVE_FIELD_NAMES` is missing here. A copy nothing checks is a copy that
 * rots.
 *
 * ── And it is the SECOND line of defence, not the first ───────────────────────
 * The middleware never stores a request body at all — only `Object.keys(req.body)`. So this
 * runs over hand-authored `changes` payloads from the explicit `auditLogger.log` call sites,
 * where the shape is known and small. Nothing here is load-bearing against an attacker
 * choosing field names; the body-keys-only rule is.
 */

export const REDACTED_MARKER = '[REDACTED]';

/**
 * Leaf field names whose VALUE is never stored.
 *
 * Lower-cased on comparison, so `passwordHash`, `password_hash` and `PASSWORD` all match
 * once normalised by `normalise` below.
 */
export const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
    'password',
    'passwordhash',
    'password_hash',
    'currentpassword',
    'newpassword',
    'onetimepassword',
    'token',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'secret',
    'authorization',
    'cookie',
    'setcookie',
    'mfasecret',
    'mfa_secret',
    'totpsecret',
    'totp',
    'otp',
    // wi-admin derives its set from the logger's pino paths, so two of its entries arrive
    // as bracketed path fragments (`headers["x-service-token`). The drift test compares
    // names, so both forms are listed — the bracketed ones can never match a real object
    // key, and are here so the two lists provably agree.
    'servicetoken',
    'headers["x-service-token',
    'headers["set-cookie',
    'code_plain',
    'codeplain',
    'pan',
    'cvv',
    'cardnumber',
    'accountnumber',
    'account_number',
    'x-service-token',
    'x-internal-token',
]);

/** How deep to walk before giving up. A cycle is caught separately; this bounds nesting. */
const MAX_DEPTH = 6;

function normalise(key: string): string {
    return key.toLowerCase().replace(/[-_]/g, '');
}

function isSensitive(key: string): boolean {
    return SENSITIVE_FIELD_NAMES.has(key.toLowerCase())
        || SENSITIVE_FIELD_NAMES.has(normalise(key));
}

export interface RedactedState {
    value: Record<string, unknown> | null;
    truncated: boolean;
}

/**
 * Deep-copy a value with credential-shaped fields replaced.
 *
 * Never throws. A cycle becomes `[CIRCULAR]` and over-deep nesting becomes `[TRUNCATED]`,
 * because this runs on the path of an action that already happened — a redaction failure
 * must not turn a successful administrative write into a 500.
 */
export function redact(input: unknown, maxBytes = 4096): RedactedState {
    if (input === null || input === undefined || typeof input !== 'object') {
        return { value: null, truncated: false };
    }

    const seen = new WeakSet<object>();
    const copied = walk(input, seen, 0) as Record<string, unknown>;

    const bytes = Buffer.byteLength(safeStringify(copied), 'utf8');
    if (bytes > maxBytes) {
        return {
            value: { truncated: true, bytes, keys: Object.keys(copied).slice(0, 50) },
            truncated: true,
        };
    }

    return { value: copied, truncated: false };
}

function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value.toISOString();
    if (depth >= MAX_DEPTH) return '[TRUNCATED]';

    if (seen.has(value as object)) return '[CIRCULAR]';
    seen.add(value as object);

    if (Array.isArray(value)) return value.map((entry) => walk(entry, seen, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isSensitive(key) ? REDACTED_MARKER : walk(nested, seen, depth + 1);
    }
    return out;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return '';
    }
}
