import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';
import { ApiKeyMailProviderConfig, MailQuotaPeriod } from '../mail.config';
import { IMailProvider, ProviderSendOptions } from '../mail.interface';

/**
 * Resend's error envelope: `{ statusCode, name, message }`.
 *
 * `name` is the machine-readable half and the reason this adapter can do something Brevo's
 * cannot — see {@link RESEND_QUOTA_PERIOD}.
 */
interface ResendErrorBody {
    name?: string;
    message?: string;
    statusCode?: number;
}

/**
 * ⭐ **Resend says WHICH allowance it exhausted, and that is worth more than it looks.**
 *
 * Its free tier has two ceilings at once — 100/day and 3 000/month — so "out of quota" has two
 * meanings with wildly different remedies. A monthly exhaustion latched to the next *daily*
 * boundary would have the chain re-ask every midnight for the rest of the month and be refused
 * every time; a daily exhaustion latched to the next *monthly* boundary would strand the
 * provider for up to thirty days with allowance sitting unused. Mapping the two names onto the
 * two periods is what makes the latch release at the moment the allowance genuinely returns,
 * and it is the only place in this module where the provider's own vocabulary is richer than
 * the configuration.
 */
const RESEND_QUOTA_PERIOD: Readonly<Record<string, MailQuotaPeriod>> = Object.freeze({
    daily_quota_exceeded: 'daily',
    monthly_quota_exceeded: 'monthly',
    // Documented at 403 with no period attached — "email content unavailable due to quota
    // limits". Left out of this table on purpose: absent means the chain applies the configured
    // default rather than this adapter inventing a window Resend did not name.
});

/** Names that mean the credential, not the message, was refused. */
const RESEND_AUTH_NAMES: ReadonlySet<string> = new Set([
    'missing_api_key',
    'restricted_api_key',
    'suspended_api_key',
    'invalid_permission',
]);

/**
 * Resend adapter — `POST https://api.resend.com/emails`, `Authorization: Bearer re_…`.
 *
 * The chain's RESERVE by default. Its free tier is the smaller of the two per day (100 vs
 * Brevo's 300), which is exactly why it sits second: the reserve is only asked once the primary
 * is spent, so the provider with the larger daily bucket belongs in front.
 *
 * ── The status this adapter must not read naively ────────────────────────────
 * **Three different conditions all arrive as `429`** — `daily_quota_exceeded`,
 * `monthly_quota_exceeded` and `rate_limit_exceeded` — and only the first two mean the allowance
 * is gone. A chain switching on status alone would latch Resend out until midnight every time it
 * sent two messages in the same second. So `name` is the discriminator here, and the status is
 * the fallback rather than the rule; that is the inverse of the Brevo adapter, where the status
 * carries more information than the code.
 *
 * ⚠ **`403 validation_error` is a SENDER-DOMAIN problem, not a bad message.** Resend refuses to
 * send from an unverified domain, and it is the single commonest first-run failure on this
 * provider. It is classified `MAIL_SEND_REJECTED` rather than `auth` deliberately: the key is
 * fine, the account is fine, and telling an operator their credential was refused would send
 * them to rotate a key that was never the problem. The thrown message carries Resend's own
 * prose, which names the domain.
 */
export class ResendMailProvider implements IMailProvider {
    readonly name = 'resend' as const;

    private readonly baseUrl: string;

    constructor(
        private readonly config: ApiKeyMailProviderConfig,
        private readonly requestTimeoutMs: number,
    ) {
        this.baseUrl = (config.baseUrl || 'https://api.resend.com').replace(/\/+$/, '');
    }

    async sendEmail(options: ProviderSendOptions): Promise<void> {
        await this.request('/emails', 'POST', {
            // Resend parses `Name <a@b.c>` itself, so the string goes through unsplit — unlike
            // Brevo, which needs the structured form.
            from: options.from,
            to: [options.to],
            subject: options.subject,
            html: options.html,
            ...(options.text ? { text: options.text } : {}),
        });
    }

    /**
     * `GET /domains` — lists the sending domains on the account and sends nothing.
     *
     * Chosen over the more obvious `GET /emails/:id` because it needs no prior message, and over
     * "send to a test address" because that would cost a quota unit on every probe, which
     * ADR-014 D-2 forbids.
     *
     * ⚠ A **restricted** (send-only) API key answers `401 restricted_api_key` here while being
     * perfectly able to send. That is reported honestly rather than swallowed: the probe's
     * contract is "can this credential reach the backend", and a key that cannot read is a
     * legitimate thing for an operator to know they have configured.
     */
    async verify(): Promise<void> {
        await this.request('/domains', 'GET');
    }

    // ── internals ──────────────────────────────────────────────────────────────

    private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        const observedAt = Date.now();
        let observedError: unknown;

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${this.config.apiKey}`,
                    'content-type': 'application/json',
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });

            if (response.ok) return;
            throw this.toAppError(response.status, await this.readError(response));
        } catch (err) {
            observedError = err;
            if (err && typeof err === 'object' && 'code' in err) throw err;
            throw createAppError(
                ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE,
                503,
                `Mail provider 'resend' is unreachable: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            clearTimeout(timer);
            recordIntegrationCall('smtp', observedAt, observedError);
        }
    }

    private async readError(response: Response): Promise<ResendErrorBody> {
        try {
            const parsed = (await response.json()) as unknown;
            if (parsed && typeof parsed === 'object') return parsed as ResendErrorBody;
            return {};
        } catch {
            return {};
        }
    }

    private toAppError(status: number, body: ResendErrorBody): Error {
        const providerCode = typeof body.name === 'string' ? body.name : null;
        const detail = `HTTP ${status}${providerCode ? ` (${providerCode})` : ''}${body.message ? `: ${body.message}` : ''}`;
        const base = { provider: 'resend', status, providerCode };

        // `name` first, status second — three conditions share the 429 and only `name` separates
        // an exhausted month from two messages in one second.
        const quotaPeriod = providerCode ? RESEND_QUOTA_PERIOD[providerCode] : undefined;
        const isQuota = Boolean(quotaPeriod) || providerCode === 'email_above_quota';

        if (isQuota) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED,
                429,
                `Mail provider 'resend' has no sending allowance left — ${detail}`,
                // `quotaPeriod` is read back by `classifyMailFailure` and overrides
                // MAIL_QUOTA_RESET_PERIOD for this latch. Absent when Resend did not say.
                quotaPeriod ? { ...base, quotaPeriod } : base,
            );
        }

        if (status === 429) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED,
                429,
                `Mail provider 'resend' is rate limiting — ${detail}`,
                base,
            );
        }

        if (providerCode && RESEND_AUTH_NAMES.has(providerCode)) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED,
                502,
                `Mail provider 'resend' refused the credential — ${detail}`,
                base,
            );
        }

        // Bare 401 with no name, or a name this adapter does not know. A 403 deliberately falls
        // THROUGH to the rejection below — see the class header on unverified sender domains.
        if (status === 401) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED,
                502,
                `Mail provider 'resend' refused the credential — ${detail}`,
                base,
            );
        }

        if (status >= 500) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE,
                503,
                `Mail provider 'resend' responded with ${detail}`,
                base,
            );
        }

        return createAppError(
            ERROR_CODES.MAIL_SEND_REJECTED,
            502,
            `Mail provider 'resend' rejected the message — ${detail}`,
            base,
        );
    }
}
