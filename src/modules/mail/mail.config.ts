/**
 * Mail provider configuration.
 *
 * Same factory + strategy + singleton shape as `core/storage/` and `core/geocoding/` — and
 * deliberately the same *vocabulary*, so somebody who has read one of those can read this one.
 * The one structural difference is {@link MailProviderType}'s `'chain'`, which mirrors
 * `GeocodingProviderType` for the same reason: a free tier measured in a few hundred sends a day
 * is not a ceiling you raise by picking a different provider, it is one you raise by adding two
 * allowances together.
 */

/**
 * The providers with an adapter in this build.
 *
 * ⚠ `'chain'` is deliberately NOT one of these — see {@link MailProviderType}. Unlike
 * `GeoProviderName` no value here is ever persisted, so the argument is weaker than geocoding's;
 * it is kept anyway because `name` is what every log line, metric label and ops row reports, and
 * a row saying "chain" would name the *mechanism* that sent a message instead of the *service*
 * that did.
 */
export const MAIL_PROVIDERS = ['brevo', 'resend', 'smtp', 'console'] as const;

export type MailProviderName = (typeof MAIL_PROVIDERS)[number];

/** What `MAIL_PROVIDER` may be set to: any single provider, or `'chain'`. */
export type MailProviderType = MailProviderName | 'chain';

export function isMailProviderName(value: string): value is MailProviderName {
    return (MAIL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The period a provider's sending allowance is measured over, and therefore the boundary a
 * quota latch is released at.
 *
 * Both values occur in the wild on the two providers this build ships:
 *
 *  - **Brevo's** free tier is **300 emails/day** — a DAILY allowance. Its API does not say so on
 *    refusal (it answers `402` / `not_enough_credits` either way), which is why the period is
 *    configuration here rather than something the adapter can read off the response.
 *  - **Resend's** free tier is 100/day *and* 3 000/month, and its API DOES say which one you hit
 *    (`daily_quota_exceeded` vs `monthly_quota_exceeded`). That adapter therefore overrides the
 *    configured default per-refusal — see `providers/resend.provider.ts`.
 */
export type MailQuotaPeriod = 'daily' | 'monthly';

export const MAIL_QUOTA_PERIODS: readonly MailQuotaPeriod[] = Object.freeze(['daily', 'monthly']);

export function isMailQuotaPeriod(value: string): value is MailQuotaPeriod {
    return (MAIL_QUOTA_PERIODS as readonly string[]).includes(value);
}

/** Credentials + endpoint for one HTTP mail provider. */
export interface ApiKeyMailProviderConfig {
    apiKey: string;
    baseUrl?: string;
}

export interface SmtpMailConfig {
    host: string;
    port: number;
    user?: string;
    pass?: string;
}

/**
 * How a quota refusal is turned into a latch.
 *
 * Two durations, because two different things get called "we hit the limit" and treating them
 * alike is wrong in both directions:
 *
 *  - **quota** — the day's or month's *allowance* is spent. Nothing changes until the provider's
 *    own window rolls over, so the latch runs to that boundary. Re-asking sooner spends a round
 *    trip to be told the same thing.
 *  - **cooldown** — a per-second rate limit (`429 rate_limit_exceeded`), a 5xx, a timeout. The
 *    provider is expected back within seconds, so latching it out for the rest of the day would
 *    throw away the primary provider's whole remaining allowance over a transient blip.
 */
export interface MailLatchConfig {
    /** Which boundary a `quota` latch runs to, when the provider does not say. */
    quotaResetPeriod: MailQuotaPeriod;
    /**
     * The IANA zone the reset boundary is computed in.
     *
     * ⚠ Defaults to **UTC, not the platform's `Africa/Douala`**, and that is not an oversight:
     * the boundary being modelled is the *provider's* accounting day, and both providers reckon
     * theirs in UTC. Setting this to a local zone moves our guess away from the real rollover,
     * which shows up as the primary provider staying latched for an extra hour a day.
     */
    quotaResetTimezone: string;
    /** How long a rate-limit / outage latch holds. */
    cooldownMs: number;
}

export interface MailConfig {
    /** Active provider. Default `'console'`; `'chain'` is the intended production setting. */
    provider: MailProviderType;
    /** Per-request timeout (ms), enforced via AbortController. */
    requestTimeoutMs: number;
    /**
     * The failover order when `provider` is `'chain'`, from `MAIL_PROVIDER_CHAIN`.
     *
     * A provider named here with no credentials is **skipped with a warning**, not a boot failure
     * — the rule `GeocodingConfig.chain` states, for the same reason: one setting has to serve a
     * developer machine with no keys, a staging box with one, and production with both.
     */
    chain?: MailProviderName[];
    latch: MailLatchConfig;

    brevo?: ApiKeyMailProviderConfig;
    resend?: ApiKeyMailProviderConfig;
    smtp?: SmtpMailConfig;
}
