import { ERROR_CODES } from '../../../core/error-codes';
import { MailQuotaPeriod, isMailQuotaPeriod } from '../mail.config';

/**
 * What kind of "no" a provider just said — the single input to every decision
 * {@link ChainedMailProvider} makes.
 *
 * PURE. Nothing here reads a clock, a config or a provider; `classifyMailFailure` is a total
 * function from a thrown value to one of six verdicts, which is what makes the chain's policy
 * table testable with no network and no keys (`test:mail-chain`).
 *
 * ── Why a classification rather than a status code ───────────────────────────
 * The two providers disagree about statuses for the same condition, in both directions. Running
 * out of allowance is `402` at Brevo and `429` at Resend; `429` at Resend is *also* an ordinary
 * per-second rate limit, distinguished only by the `name` field in the body. A chain switching on
 * HTTP status would therefore latch Brevo's rate limit until midnight and Resend's exhausted
 * month for five minutes — wrong in both directions, in the expensive direction each time. So the
 * ADAPTERS own the vendor vocabulary and translate; this file owns the vocabulary they translate
 * into.
 */

export type MailFailureKind =
    /** The allowance is spent. Latches to the provider's own reset boundary. */
    | 'quota'
    /** Too fast right now. Short cooldown. */
    | 'rate_limit'
    /** 5xx, DNS, timeout, connection refused. Short cooldown. */
    | 'unavailable'
    /** The credential was refused. **Never latched** — see {@link shouldLatch}. */
    | 'auth'
    /** The provider read the message and refused IT (bad address, unverified sender). */
    | 'rejected'
    /** Something threw that no adapter classified. Treated as the most conservative case. */
    | 'unknown';

export interface MailFailure {
    kind: MailFailureKind;
    /** Present only on `kind: 'quota'`, and only when the provider said which window. */
    quotaPeriod: MailQuotaPeriod | null;
    /** The `ERROR_CODES` value, for the log line and the ops row. */
    code: string | null;
    message: string;
}

const KIND_BY_CODE: Readonly<Record<string, MailFailureKind>> = Object.freeze({
    [ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED]: 'quota',
    [ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED]: 'rate_limit',
    [ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE]: 'unavailable',
    [ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED]: 'auth',
    [ERROR_CODES.MAIL_SEND_REJECTED]: 'rejected',
    [ERROR_CODES.MAIL_PROVIDER_NOT_CONFIGURED]: 'rejected',
});

/**
 * Read an adapter's throw back into a verdict.
 *
 * ⚠ An unrecognised throw is `'unknown'`, **never** `'rejected'`. The difference is whether the
 * chain moves on: an unclassified error is most likely a bug in an adapter or an SDK, and
 * refusing to try the reserve provider on the strength of one would turn a small defect in one
 * adapter into a platform that sends no mail at all.
 */
export function classifyMailFailure(error: unknown): MailFailure {
    const code = readString(error, 'code');
    const message = error instanceof Error ? error.message : String(error);

    const kind = (code && KIND_BY_CODE[code]) || 'unknown';

    return {
        kind,
        quotaPeriod: kind === 'quota' ? readQuotaPeriod(error) : null,
        code: code ?? null,
        message,
    };
}

/**
 * Whether this verdict should stop the chain asking that provider again for a while.
 *
 * Three of the six do not latch, and each `false` is a decision:
 *
 *  - **`auth`** — a rejected key is a *configuration fault an operator must see*, and the whole
 *    way this platform surfaces one is that it keeps happening. Latching it would mean the
 *    deployment runs on its reserve for a day per failure with one log line to show for it,
 *    which is precisely the "runs for months on half its capacity with nobody aware" failure
 *    `ChainedGeocodingProvider` refuses to fail over on a 401 to avoid. The mail chain reaches
 *    the same outcome by the opposite route — it DOES fail over (a password reset is worth more
 *    than a clean signal) but refuses to go quiet about it, so every send logs and counts.
 *  - **`rejected`** — the message is the problem, not the provider. Latching would punish the
 *    provider for one bad recipient address and take it out for every other customer's mail.
 *  - **`unknown`** — never latch on a verdict we could not read.
 */
export function shouldLatch(kind: MailFailureKind): boolean {
    return kind === 'quota' || kind === 'rate_limit' || kind === 'unavailable';
}

/** Which of the two latch durations a verdict earns. */
export function latchKindFor(kind: MailFailureKind): 'quota' | 'cooldown' {
    return kind === 'quota' ? 'quota' : 'cooldown';
}

/**
 * The metric label for an attempt outcome. A closed set of seven, so
 * `jovimall_mail_sends_total` is bounded at 4 providers × 7 outcomes = 28 series — the rule
 * `domain/route-group.ts` states for every label in this service.
 */
export function outcomeLabel(kind: MailFailureKind): string {
    switch (kind) {
        case 'quota': return 'quota_exceeded';
        case 'rate_limit': return 'rate_limited';
        case 'unavailable': return 'unavailable';
        case 'auth': return 'auth_failed';
        case 'rejected': return 'rejected';
        default: return 'unknown';
    }
}

function readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const found = (value as Record<string, unknown>)[key];
    return typeof found === 'string' ? found : undefined;
}

/**
 * Resend names the window it exhausted (`daily_quota_exceeded` vs `monthly_quota_exceeded`) and
 * its adapter passes that through on `details.quotaPeriod`. Brevo does not, so its refusals
 * carry nothing here and the chain falls back to `MAIL_QUOTA_RESET_PERIOD`.
 *
 * `details` is read in-process, before this error has been anywhere near the boundary that drops
 * it for `external_service` — that filtering is the global handler's job on the way out, and
 * nothing here is on the way out.
 */
function readQuotaPeriod(error: unknown): MailQuotaPeriod | null {
    if (!error || typeof error !== 'object') return null;
    const details = (error as { details?: unknown }).details;
    if (!details || typeof details !== 'object') return null;
    const period = (details as Record<string, unknown>).quotaPeriod;
    return typeof period === 'string' && isMailQuotaPeriod(period) ? period : null;
}
