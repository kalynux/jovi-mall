import nodemailer from 'nodemailer';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';
import { SmtpMailConfig } from '../mail.config';
import { IMailProvider, ProviderSendOptions } from '../mail.interface';

/**
 * Nodemailer's own failure vocabulary, mapped onto this module's.
 *
 * Nodemailer puts a short symbolic string on `error.code` for everything that fails before or
 * around the SMTP conversation, and the numeric SMTP reply on `error.responseCode` for
 * everything the far end refused. Both are needed: an auth failure is `EAUTH` with no reply
 * code, and a mailbox-full bounce is a `452` with no nodemailer code.
 */
const NODEMAILER_CODE_KIND: Readonly<Record<string, 'auth' | 'unavailable' | 'rejected'>> = Object.freeze({
    EAUTH: 'auth',
    ECONNECTION: 'unavailable',
    ETIMEDOUT: 'unavailable',
    ESOCKET: 'unavailable',
    EDNS: 'unavailable',
    ECONNREFUSED: 'unavailable',
    // The recipient list was refused — the message is the problem, not the relay.
    EENVELOPE: 'rejected',
    EMESSAGE: 'rejected',
});

/**
 * SMTP adapter, over Nodemailer.
 *
 * ── Its place in the chain, and why it is LAST ───────────────────────────────
 * It is the one member with no API quota, so on paper it belongs first. It is last because the
 * relay behind it is typically a personal mailbox (`.env.example` documents the Gmail App
 * Password path), and those carry sending reputations and daily caps that are enforced by
 * *silently dropping* mail or by suspending the account rather than by returning an error a
 * chain can read. A provider whose limit cannot be observed is the wrong one to spend first.
 *
 * ⚠ **This adapter gained a classification in the chain change, and that was a real fix rather
 * than plumbing.** It previously let Nodemailer's error escape raw — which is a bare `Error`
 * with no `code` this module recognises, so a chain would have read it as `'unknown'` and
 * treated an expired App Password exactly like a transient socket failure. Both would have been
 * retried forever and neither would have been reported as what it was.
 */
export class SmtpMailProvider implements IMailProvider {
    readonly name = 'smtp' as const;

    private transporter: nodemailer.Transporter;

    constructor(config?: SmtpMailConfig) {
        this.transporter = nodemailer.createTransport({
            host: config?.host ?? process.env.SMTP_HOST,
            port: config?.port ?? (Number(process.env.SMTP_PORT) || 587),
            secure: false,
            auth: {
                user: config?.user ?? process.env.SMTP_USER,
                pass: config?.pass ?? process.env.SMTP_PASS,
            },
            tls: {
                rejectUnauthorized: false
            }
        });
    }

    /**
     * `transporter.verify()` — EHLO plus AUTH, and nothing sent.
     *
     * This is the one genuinely side-effect-free probe among the platform's integrations, and
     * until Phase 15 it did not exist: `probeSmtp` looked for it, did not find it, and reported
     * an error every time. The consequence was that a broken SMTP configuration was discovered
     * on a customer's verification email rather than on an operator's dashboard.
     */
    async verify(): Promise<void> {
        await this.transporter.verify();
    }

    async sendEmail(options: ProviderSendOptions): Promise<void> {
        const observedAt = Date.now();
        let observedError: unknown;

        try {
            await this.transporter.sendMail({
                from: options.from,
                to: options.to,
                subject: options.subject,
                html: options.html,
                text: options.text,
            });
        } catch (err) {
            observedError = err;
            throw this.toAppError(err);
        } finally {
            recordIntegrationCall('smtp', observedAt, observedError);
        }
    }

    private toAppError(err: unknown): Error {
        const code = readString(err, 'code');
        const responseCode = readNumber(err, 'responseCode');
        const message = err instanceof Error ? err.message : String(err);
        const detail = `${code ? `${code} ` : ''}${responseCode ? `(${responseCode}) ` : ''}${message}`;
        const base = { provider: 'smtp', code: code ?? null, responseCode: responseCode ?? null };

        const kind = code ? NODEMAILER_CODE_KIND[code] : undefined;

        if (kind === 'auth' || responseCode === 535 || responseCode === 534) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED,
                502,
                `Mail provider 'smtp' refused the credential — ${detail}`,
                base,
            );
        }

        /**
         * ⚠ `421` and `45x` are the closest SMTP gets to "you are sending too fast", and they are
         * mapped to a COOLDOWN rather than to quota. A relay never reports a daily cap as a
         * distinguishable reply code — it either accepts the message and drops it silently or it
         * suspends the account — so this adapter can never legitimately raise
         * `MAIL_PROVIDER_QUOTA_EXCEEDED`, and claiming otherwise would latch the last resort out
         * for a day on a temporary greylisting.
         */
        if (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452) {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED,
                429,
                `Mail provider 'smtp' deferred the message — ${detail}`,
                base,
            );
        }

        if (kind === 'unavailable') {
            return createAppError(
                ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE,
                503,
                `Mail provider 'smtp' is unreachable — ${detail}`,
                base,
            );
        }

        if (kind === 'rejected' || (responseCode !== undefined && responseCode >= 500)) {
            return createAppError(
                ERROR_CODES.MAIL_SEND_REJECTED,
                502,
                `Mail provider 'smtp' rejected the message — ${detail}`,
                base,
            );
        }

        // Unrecognised. `unavailable` rather than `rejected`, because the chain retries the first
        // and gives up on the second — and an unreadable SMTP failure is far more often a relay
        // problem than a bad message.
        return createAppError(
            ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE,
            503,
            `Mail provider 'smtp' failed — ${detail}`,
            base,
        );
    }
}

function readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const found = (value as Record<string, unknown>)[key];
    return typeof found === 'string' ? found : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const found = (value as Record<string, unknown>)[key];
    return typeof found === 'number' ? found : undefined;
}
