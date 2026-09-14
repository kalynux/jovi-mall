import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';
import { ApiKeyMailProviderConfig } from '../mail.config';
import { IMailProvider, ProviderSendOptions } from '../mail.interface';
import { parseMailAddress } from '../domain/mail-address';

/** The subset of Brevo's error envelope this adapter reads. Every error shares this shape. */
interface BrevoErrorBody {
    code?: string;
    message?: string;
}

/**
 * Brevo's own error-code vocabulary that means **the allowance is spent**.
 *
 * A closed list, deliberately short, and matched on the `code` field rather than on the prose —
 * `message` is human copy that Brevo is free to reword, and a platform that latches its primary
 * provider out for a day on a substring match will eventually do so because somebody fixed a
 * typo in an error message.
 */
const BREVO_QUOTA_CODES: ReadonlySet<string> = new Set(['not_enough_credits']);

/**
 * Codes that mean **this credential is not acceptable**, as opposed to this request.
 *
 * `account_under_validation` is in here rather than with the quota codes and that is a judgement
 * worth stating: a Brevo account awaiting review sends nothing at all, so it is closer to a bad
 * key than to an exhausted one — and unlike an exhausted allowance it does not come back at
 * midnight, so latching it to a reset boundary would be a lie about when to retry.
 */
const BREVO_AUTH_CODES: ReadonlySet<string> = new Set([
    'unauthorized',
    'permission_denied',
    'account_under_validation',
]);

/**
 * Brevo adapter — `POST /v3/smtp/email`, authenticated with the `api-key` header.
 *
 * The chain's FRONT LINE by default, and the reason is the free tier: **300 emails/day**, which
 * is a genuinely useful allowance to spend first and a small enough one that exhausting it is an
 * ordinary daily event rather than an incident. Resend's free tier is 100/day (3 000/month), so
 * putting Brevo first spends the larger daily bucket before touching the smaller one.
 *
 * ── What it reports running out, and why that needed research ────────────────
 * Brevo does **not** have a dedicated "daily send limit reached" code. Exhaustion surfaces as
 * either a `402 Payment Required` ("account requires activation or additional credits") or a
 * body carrying `code: "not_enough_credits"`, which is documented at `400` as well. So this
 * adapter treats the STATUS and the CODE as independent evidence and accepts either — a
 * status-only rule would miss the 400 form, and a code-only rule would miss a 402 whose body did
 * not parse.
 *
 * ⚠ **A `429` here is NOT exhaustion.** Brevo's rate limit on this endpoint is 1 000 requests
 * per second — nothing this platform will reach — so a 429 means something transient and gets a
 * cooldown, never a latch until midnight. Mapping it to quota would take the primary provider
 * out for a day over a blip.
 */
export class BrevoMailProvider implements IMailProvider {
    readonly name = 'brevo' as const;

    private readonly baseUrl: string;

    constructor(
        private readonly config: ApiKeyMailProviderConfig,
        private readonly requestTimeoutMs: number,
    ) {
        this.baseUrl = (config.baseUrl || 'https://api.brevo.com/v3').replace(/\/+$/, '');
    }

    async sendEmail(options: ProviderSendOptions): Promise<void> {
        const sender = parseMailAddress(options.from);
        const recipient = parseMailAddress(options.to);

        await this.request('/smtp/email', {
            sender: sender.name ? { email: sender.email, name: sender.name } : { email: sender.email },
            to: [recipient.name ? { email: recipient.email, name: recipient.name } : { email: recipient.email }],
            subject: options.subject,
            htmlContent: options.html,
            // Omitted rather than sent empty: Brevo rejects a blank `textContent`, and it derives
            // a plain-text part from the HTML when the field is absent.
            ...(options.text ? { textContent: options.text } : {}),
        });
    }

    /**
     * `GET /v3/account` — reads the account this key belongs to and sends nothing.
     *
     * The cheapest call Brevo offers that actually exercises the credential, which is what the
     * probe is for. It does not consume a sending credit, so it satisfies ADR-014 D-2's rule that
     * a diagnostics read may not spend a quota a real request needs.
     */
    async verify(): Promise<void> {
        await this.request('/account', undefined, 'GET');
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private async request(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        const observedAt = Date.now();
        let observedError: unknown;

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    'api-key': this.config.apiKey,
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });

            if (response.ok) return;

            // Read the body BEFORE branching on the status: `not_enough_credits` can arrive at a
            // 400, which the status rule alone would classify as a malformed request and refuse
            // to latch. The parse is defensive — a gateway between us and Brevo may answer HTML.
            const parsed = await this.readError(response);
            throw this.toAppError(response.status, parsed);
        } catch (err) {
            observedError = err;
            // Already classified by `toAppError` — pass it through untouched, or the code the
            // chain reads is replaced by the catch-all below.
            if (err && typeof err === 'object' && 'code' in err) throw err;
            throw createAppError(
                ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE,
                503,
                `Mail provider 'brevo' is unreachable: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            clearTimeout(timer);
            recordIntegrationCall('smtp', observedAt, observedError);
        }
    }

    private async readError(response: Response): Promise<BrevoErrorBody> {
        try {
            const parsed = (await response.json()) as unknown;
            if (parsed && typeof parsed === 'object') return parsed as BrevoErrorBody;
            return {};
        } catch {
            return {};
        }
    }

    private toAppError(status: number, body: BrevoErrorBody): Error {
        const providerCode = typeof body.code === 'string' ? body.code : null;
        const detail = `HTTP ${status}${providerCode ? ` (${providerCode})` : ''}${body.message ? `: ${body.message}` : ''}`;

        // Exhaustion first, and on EITHER piece of evidence — see the class header.
        if (status === 402 || (providerCode && BREVO_QUOTA_CODES.has(providerCode))) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED,
                429,
                `Mail provider 'brevo' has no sending allowance left — ${detail}`,
                // No `quotaPeriod`: Brevo does not say which window it is, so the chain applies
                // `MAIL_QUOTA_RESET_PERIOD`. Guessing `daily` here because the free tier is daily
                // would be wrong on every paid plan and invisible when it was.
                { provider: 'brevo', status, providerCode },
            );
        }

        if (status === 429) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED,
                429,
                `Mail provider 'brevo' is rate limiting — ${detail}`,
                { provider: 'brevo', status, providerCode },
            );
        }

        if (status === 401 || (providerCode && BREVO_AUTH_CODES.has(providerCode))) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED,
                502,
                `Mail provider 'brevo' refused the credential — ${detail}`,
                { provider: 'brevo', status, providerCode },
            );
        }

        if (status >= 500) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE,
                503,
                `Mail provider 'brevo' responded with ${detail}`,
                { provider: 'brevo', status, providerCode },
            );
        }

        return createAppError(
            ERROR_CODES.MAIL_SEND_REJECTED,
            502,
            `Mail provider 'brevo' rejected the message — ${detail}`,
            { provider: 'brevo', status, providerCode },
        );
    }
}
