import { SENSITIVE_FIELD_NAMES } from '../audit/redact';

/**
 * Credential scrubbing for FREE-TEXT log messages.
 *
 * ── This is a net, not a boundary ─────────────────────────────────────────────
 * The same sentence `core/audit/redact.ts` opens with, and it means the same thing here.
 * The boundary is the structured logger plus pino's `redact` paths, which operate on object
 * KEYS and are exact. This file operates on rendered strings and is a set of heuristics: it
 * reduces the blast radius of a careless `console.error('token ' + tok)`, and it cannot prove
 * absence. Do not let its existence justify logging a credential "because the scrubber will
 * catch it".
 *
 * It exists because ~565 `console.*` call sites in this repo pass free text, and path-based
 * redaction structurally cannot see inside a string that was already concatenated.
 *
 * ── Two properties the tests pin ──────────────────────────────────────────────
 * 1. **Idempotent.** `scrubText(scrubText(x)) === scrubText(x)`. Every replacement below emits
 *    a marker that its own pattern cannot re-match, because a line can pass through the hook
 *    and the bridge and be re-rendered.
 * 2. **Quiet on ordinary text.** A log line with no credential shape comes back byte-identical.
 *    A scrubber that mangles normal output is one an author works around.
 *
 * ── What is deliberately NOT matched ──────────────────────────────────────────
 * **Bare long hex.** A 24-char hex string is a Mongo ObjectId and appears in a large share of
 * this service's log lines; a 64-char one is a sha-256 upload fingerprint, which the file
 * subsystem logs legitimately. Redacting either would make the scrubber untrustworthy — and a
 * scrubber nobody trusts gets disabled, which costs more than the gap. Credentials in this
 * codebase are JWTs, prefixed provider keys, URI userinfo or named fields, and all four are
 * matched precisely.
 */

/** Replaces a whole matched credential. */
const MARK = '[REDACTED]';

/**
 * Field names whose VALUE is scrubbed when they appear as `name=value` or `"name": "value"`.
 *
 * Derived from the audit sanitiser's set rather than retyped, so the two cannot drift — the
 * same reason `redact.ts` is itself kept honest by wi-admin's drift test. The filter drops the
 * two bracketed PATH FRAGMENTS that set carries (`headers["x-service-token`): they exist only
 * so the cross-service name comparison lines up, they can never be a real object key, and as
 * regex alternatives they would be nonsense.
 */
export const SCRUBBED_FIELD_NAMES: readonly string[] = Object.freeze(
    [...SENSITIVE_FIELD_NAMES]
        .filter((name) => /^[a-z0-9_]+$/.test(name))
        .sort((a, b) => b.length - a.length),
);

const FIELD_ALTERNATION = SCRUBBED_FIELD_NAMES.join('|');

/**
 * Cheap gate. Regex passes only run on strings that contain a trigger substring, because the
 * bridge renders every `console.*` call in the process through here and most of them are
 * ordinary prose.
 */
const TRIGGER = new RegExp(
    ['eyJ', 'Bearer', 'Basic', 'sk_', 'rk_', 'pk_', 'whsec_', '://', 'PRIVATE KEY', FIELD_ALTERNATION].join('|'),
    'i',
);

interface Rule {
    readonly pattern: RegExp;
    readonly replacement: string;
}

const RULES: readonly Rule[] = Object.freeze([
    /**
     * PEM private keys. `FCM_PRIVATE_KEY` and `STORAGE_FIREBASE_PRIVATE_KEY` are real variables
     * here, and a config dump prints them across many lines — hence the multi-line body match.
     * Runs first so a key containing base64 that looks JWT-ish is taken whole.
     */
    {
        pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        replacement: '[REDACTED:private-key]',
    },

    /**
     * JWTs — the single highest-value pattern. wi-admin's logger header records that this
     * service wrote a **refresh token** to stdout on every silent refresh; this is the shape.
     * The third segment may be empty (an unsigned token is still a token).
     */
    {
        pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
        replacement: '[REDACTED:jwt]',
    },

    /**
     * `Authorization`-style values. The marker contains `[` and `]`, which are outside the
     * value character class, so a second pass cannot re-match — that is the idempotence.
     */
    {
        pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
        replacement: `$1 ${MARK}`,
    },

    /**
     * Prefixed provider keys, **prefix preserved**.
     *
     * ADR-014 D-2 already decided that `sk_live_` vs `sk_test_` is the operationally useful
     * fact and leaks nothing — `/system/integrations` reports exactly that for Stripe. Keeping
     * it here means a scrubbed log line still answers "was that the live account".
     */
    {
        pattern: /\b((?:sk|rk|pk|whsec)_(?:live|test)_)[A-Za-z0-9]{6,}/g,
        replacement: `$1${MARK}`,
    },
    {
        pattern: /\b((?:sk|rk|pk|whsec)_)[A-Za-z0-9]{16,}/g,
        replacement: `$1${MARK}`,
    },

    /**
     * URI userinfo — `mongodb://user:pass@host`, `redis://user:pass@host`.
     *
     * The USERNAME goes too, not just the password: it is half a credential and naming it buys
     * an operator nothing the host does not already tell them. Idempotent because the marker
     * contains no colon and the pattern requires one.
     */
    {
        pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/g,
        replacement: `$1${MARK}@`,
    },

    /**
     * `name=value` and `"name": "value"` for the derived field names.
     *
     * The key is matched without a trailing `\b` on purpose, then the separator is required
     * immediately after — so `tokenId: 5` and `token refreshed` do not match, while
     * `"token": "abc"` and `password=hunter2` do.
     *
     * ── The two subtleties, both found by the test rather than by reading ─────
     * **The negative lookahead is what makes this idempotent**, and it must sit BEFORE the
     * optional scheme group. `[` and `]` are excluded from the value class, so a second pass
     * over `password=[REDACTED]` would otherwise match `[REDACTED` (stopping at the `]`),
     * re-append a bracket, and grow `]]]` one character per pass.
     *
     * **The optional `Bearer`/`Basic` group keeps the scheme.** Without it this rule treats
     * the word `Bearer` as the value and emits `Authorization: [REDACTED] [REDACTED]` —
     * correct, but noise. It cannot be left to backtracking: the lookahead has to cover the
     * scheme too, or the engine simply retries without the optional group and matches anyway.
     */
    {
        pattern: new RegExp(
            `\\b(${FIELD_ALTERNATION})(["']?\\s*[:=]\\s*["']?)(?!(?:Bearer|Basic)?\\s*\\[REDACTED)((?:Bearer|Basic)\\s+)?[^\\s"',;&}\\[\\]]+`,
            'gi',
        ),
        replacement: `$1$2$3${MARK}`,
    },
]);

/** Scrub credential shapes out of a rendered message. Never throws; returns the input on error. */
export function scrubText(input: string): string {
    if (!input || !TRIGGER.test(input)) return input;

    try {
        let out = input;
        for (const rule of RULES) {
            // Each `pattern` is a module-level literal with /g; reset lastIndex so a previous
            // call cannot leave state that makes this one skip the start of the string.
            rule.pattern.lastIndex = 0;
            out = out.replace(rule.pattern, rule.replacement);
        }
        return out;
    } catch {
        return input;
    }
}

/**
 * Bound a message before it reaches the scrubber and the sinks.
 *
 * Applied BEFORE scrubbing deliberately: an accidental 2 MB payload dump should not run seven
 * regexes over 2 MB. The suffix states the original size, because a silently shortened line
 * reads as a complete one.
 */
export function truncateMessage(input: string, maxBytes: number): string {
    if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
    return `${Buffer.from(input, 'utf8').subarray(0, maxBytes).toString('utf8')}… [truncated, ${Buffer.byteLength(input, 'utf8')} bytes]`;
}
