import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { MAIL_PROVIDERS, MailConfig, MailProviderName } from './mail.config';
import { IMailProvider } from './mail.interface';
import { ChainedMailProvider } from './mail.chain';
import { BrevoMailProvider } from './providers/brevo.provider';
import { ResendMailProvider } from './providers/resend.provider';
import { SmtpMailProvider } from './providers/smtp.provider';
import { ConsoleMailProvider } from './providers/console.provider';

/**
 * Mail Provider Factory
 *
 * The ONLY place where mail provider selection happens — mirroring
 * `core/storage/storage.factory.ts` and `core/geocoding/geocoding.factory.ts`, right down to the
 * `required: true | false` asymmetry that lets one setting serve a keyless laptop and a
 * two-key production host.
 *
 * ── `MAIL_PROVIDER=chain` is the intended production setting ─────────────────
 *
 * Every provider with a usable free tier here caps out in the **hundreds of messages a day**,
 * and this platform's four notification stacks spend them on ordinary traffic. The chain adds
 * the allowances together and latches a provider out once it says it has none left — see
 * {@link ChainedMailProvider} for what it does and does not latch on.
 */
export function createMailProvider(config: MailConfig): IMailProvider {
    const { provider } = config;

    if (provider === 'chain') return buildChain(config);
    return buildOne(provider, config, { required: true })!;
}

/**
 * Build one named provider.
 *
 * `required: false` is the chain's mode: a provider whose credentials are absent returns `null`
 * to be skipped, instead of throwing. See {@link MailConfig.chain}.
 */
function buildOne(
    name: MailProviderName,
    config: MailConfig,
    opts: { required: boolean },
): IMailProvider | null {
    const missing = (what: string): never | null => {
        if (!opts.required) {
            console.warn(`[Mail] '${name}' skipped — ${what}`);
            return null;
        }
        throw createAppError(ERROR_CODES.MAIL_PROVIDER_NOT_CONFIGURED, 500, what);
    };

    switch (name) {
        case 'brevo':
            if (!config.brevo) {
                return missing("BREVO_API_KEY is not set, so the 'brevo' adapter cannot be built");
            }
            return new BrevoMailProvider(config.brevo, config.requestTimeoutMs);

        case 'resend':
            if (!config.resend) {
                return missing("RESEND_API_KEY is not set, so the 'resend' adapter cannot be built");
            }
            return new ResendMailProvider(config.resend, config.requestTimeoutMs);

        case 'smtp':
            if (!config.smtp) {
                return missing("SMTP_HOST is not set, so the 'smtp' adapter cannot be built");
            }
            return new SmtpMailProvider(config.smtp);

        case 'console':
            return new ConsoleMailProvider();

        default:
            /**
             * Unknown even as a NAME — a typo in `MAIL_PROVIDER` or `MAIL_PROVIDER_CHAIN`.
             *
             * Always fatal, even inside the chain, and the argument is the geocoding factory's
             * with one extra turn: silently skipping a misspelt provider is how a deployment
             * runs on its fallback believing it runs on its primary — and here the fallback is
             * frequently `console`, which delivers nothing and reports success. Same posture as
             * `assertUploadScannerSafe`.
             */
            throw createAppError(
                ERROR_CODES.CONFIG_INVALID_MAIL_PROVIDER,
                500,
                `Unknown mail provider: ${String(name)}. Supported: ${MAIL_PROVIDERS.join(', ')}`,
            );
    }
}

/**
 * Build the failover chain named by `MAIL_PROVIDER_CHAIN`.
 *
 * Default order `brevo,resend,smtp`, and each position is a decision:
 *
 *  - **brevo** first — the largest daily free allowance of the three (300/day against Resend's
 *    100), so it is the bucket worth spending before the others are touched.
 *  - **resend** second — the reserve. It reports *which* window it exhausted, so its latch
 *    releases at the right boundary without configuration.
 *  - **smtp** last — no API quota, which argues for first until you notice that the relay behind
 *    it is usually a personal mailbox whose limits are enforced by silently dropping mail. A
 *    provider whose ceiling cannot be observed is the wrong one to spend first.
 *
 * ⚠ **`console` is appended ONLY when the chain would otherwise be EMPTY**, and never beside a
 * real provider. This is the one place this file departs from `buildChain` in the geocoding
 * factory, where keyless Nominatim is *always* appended as a last resort. The reason is that the
 * two last resorts are not alike: Nominatim genuinely resolves addresses, while `console` cannot
 * fail — so a chain containing it would absorb every message every other member refused and
 * report success, producing exactly the silent non-delivery this module was built to end. An
 * empty chain, meanwhile, must still not crash a developer machine with no keys, so the
 * degenerate case keeps today's behaviour and says so loudly.
 */
function buildChain(config: MailConfig): IMailProvider {
    const requested = config.chain && config.chain.length > 0
        ? [...config.chain]
        : (['brevo', 'resend', 'smtp'] as MailProviderName[]);

    const built = requested
        // A `console` named explicitly inside a chain is dropped rather than honoured — see the
        // header. Naming it is almost certainly a misunderstanding, and honouring it would make
        // every member after it unreachable.
        .filter(name => {
            if (name !== 'console') return true;
            console.warn("[Mail] 'console' cannot be a chain member — it absorbs every message and reports success. Ignored.");
            return false;
        })
        .map(name => buildOne(name, config, { required: false }))
        .filter((p): p is IMailProvider => p !== null);

    if (built.length === 0) {
        console.warn(
            '[Mail] ⚠ MAIL_PROVIDER=chain but no member could be built — no BREVO_API_KEY, no '
            + 'RESEND_API_KEY and no SMTP_HOST. Falling back to the console provider: every '
            + 'message will be PRINTED AND NOT DELIVERED.',
        );
        return new ConsoleMailProvider();
    }

    console.log(`[Mail] chain: ${built.map(p => p.name).join(' → ')}`);
    return new ChainedMailProvider(built, config.latch);
}
