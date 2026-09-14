import {
    MailConfig,
    MailProviderName,
    MailProviderType,
    isMailQuotaPeriod,
} from './mail.config';
import { IMailProvider } from './mail.interface';
import { createMailProvider } from './mail.factory';
import { ChainedMailProvider } from './mail.chain';

/**
 * Centralized Mail Configuration
 *
 * Single source of truth for mail provider config, loaded once at startup from environment
 * variables — mirroring `core/storage/storage.instance.ts` and
 * `core/geocoding/geocoding.instance.ts`.
 *
 * ENVIRONMENT VARIABLES:
 * - MAIL_PROVIDER              : 'console' | 'smtp' | 'brevo' | 'resend' | 'chain'
 *                                (default 'console'). **'chain' is the intended production
 *                                setting** — see `mail.factory.ts`.
 * - MAIL_PROVIDER_CHAIN        : failover order for 'chain' (default 'brevo,resend,smtp')
 * - MAIL_REQUEST_TIMEOUT_MS    : per-request timeout for the HTTP providers (default 10000)
 * - MAIL_QUOTA_RESET_PERIOD    : 'daily' | 'monthly' — which boundary a quota latch runs to when
 *                                the provider does not say (default 'daily', because Brevo's
 *                                free tier is 300/DAY and Brevo is the one that does not say)
 * - MAIL_QUOTA_RESET_TIMEZONE  : IANA zone the boundary is computed in (default 'UTC' — the
 *                                zone both providers reckon their accounting day in, NOT the
 *                                platform's market)
 * - MAIL_QUOTA_COOLDOWN_MS     : how long a rate-limit / outage latch holds (default 300000)
 * - BREVO_API_KEY / BREVO_BASE_URL
 * - RESEND_API_KEY / RESEND_BASE_URL
 * - SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 */

/**
 * Parse `MAIL_PROVIDER_CHAIN`. Returns undefined for an unset/blank value so the factory applies
 * its own default order rather than being handed an empty array.
 *
 * ⚠ Names are **not** validated here — a typo must reach the factory, which refuses to boot on
 * it. Filtering unknown names out at parse time is how a deployment ends up silently running on
 * its fallback while believing it runs on its primary, and for mail that fallback prints to
 * stdout.
 */
function parseChain(raw: string | undefined): MailProviderName[] | undefined {
    if (raw == null || raw.trim() === '') return undefined;
    const names = raw.split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
    return names.length > 0 ? (names as MailProviderName[]) : undefined;
}

function loadMailConfig(): MailConfig {
    const provider = (process.env.MAIL_PROVIDER || 'console').toLowerCase() as MailProviderType;

    const rawPeriod = (process.env.MAIL_QUOTA_RESET_PERIOD || 'daily').toLowerCase();

    const config: MailConfig = {
        provider,
        requestTimeoutMs: Number(process.env.MAIL_REQUEST_TIMEOUT_MS) || 10_000,
        // The default order lives in `buildChain()` — NOT here: an unset value must reach the
        // factory as `undefined` so one default is applied in one place.
        chain: parseChain(process.env.MAIL_PROVIDER_CHAIN),
        latch: {
            // An unrecognised value falls back to 'daily' rather than refusing, because
            // `config/env.ts` already refuses it at boot with a message naming both options —
            // and a second, quieter refusal here would fire on a machine that never ran the
            // validator (a script, a test) for a variable with a safe default.
            quotaResetPeriod: isMailQuotaPeriod(rawPeriod) ? rawPeriod : 'daily',
            quotaResetTimezone: process.env.MAIL_QUOTA_RESET_TIMEZONE || 'UTC',
            cooldownMs: Number(process.env.MAIL_QUOTA_COOLDOWN_MS) || 300_000,
        },
    };

    /**
     * ⚠ A block is populated ONLY when its credential is present, and the factory reads that
     * absence as "skip this provider" when building a chain. So the presence of a key IS the
     * switch — there is deliberately no separate `*_ENABLED` flag to disagree with it, exactly
     * as in `geocoding.instance.ts`.
     */
    if (process.env.BREVO_API_KEY) {
        config.brevo = {
            apiKey: process.env.BREVO_API_KEY,
            baseUrl: process.env.BREVO_BASE_URL,
        };
    }
    if (process.env.RESEND_API_KEY) {
        config.resend = {
            apiKey: process.env.RESEND_API_KEY,
            baseUrl: process.env.RESEND_BASE_URL,
        };
    }
    if (process.env.SMTP_HOST) {
        config.smtp = {
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        };
    }

    return config;
}

/** Global mail configuration (loaded once at startup). */
export const mailConfig = loadMailConfig();

/** Singleton mail provider instance (lazy-initialized). */
let mailProviderInstance: IMailProvider | null = null;

/**
 * Get the singleton mail provider. **The only supported way to reach a provider** — never
 * construct one directly, the rule `core/storage` states for the same reason.
 *
 * ⚠ For this module the singleton is not merely a convention, it is what makes the feature
 * work. The latch is per-process in-memory state (`domain/mail-latch.ts`), so it is only shared
 * if the chain holding it is shared. `MailService` is constructed with `new MailService()` at
 * eight call sites — four notification handlers, auth, password reset, contact change, admin
 * credential delivery — and before this change each of those built its own provider. Under a
 * per-instance chain, Brevo running out of allowance would be re-discovered eight times over,
 * once per subsystem, every send.
 */
export function getMailProvider(): IMailProvider {
    if (!mailProviderInstance) {
        mailProviderInstance = createMailProvider(mailConfig);
        console.log(`[Mail] Initialized ${mailConfig.provider} mail provider`);
    }
    return mailProviderInstance;
}

/** Current active provider type — for debugging, `/system/config` and `/system/integrations`. */
export function getMailProviderType(): MailProviderType {
    return mailConfig.provider;
}

/**
 * The chain in force, or null when a single provider is configured.
 *
 * Used by `/system/integrations` to report the order and the live latches — the operator-facing
 * half of this feature, and the only place "Brevo is out of allowance until midnight, we are
 * running on Resend" is visible. A successful send through the reserve looks exactly like a
 * successful send through the primary from everywhere else.
 */
export function getMailChain(): ChainedMailProvider | null {
    const provider = getMailProvider();
    return provider instanceof ChainedMailProvider ? provider : null;
}

/** Reset the singleton (tests only). */
export function resetMailProvider(): void {
    mailProviderInstance = null;
}
