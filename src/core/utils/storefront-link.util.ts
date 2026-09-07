import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type Language } from '../constants/languages';

/**
 * Building an address into the customer storefront (`frontend/landing`).
 *
 * ── Why this is one file rather than a line at each call site ────────────────
 *
 * Three places in this repository compose a link a customer clicks: the
 * notification catalogue's action buttons, the bot surface's "see the rest"
 * links, and the pay link. They had two different ideas of what a storefront
 * address looks like, and the disagreement was invisible from either side:
 *
 *   - the bot built `/shop/account/orders/abc` and prefixed the locale;
 *   - the notification catalogue built `orders/abc` and prefixed nothing.
 *
 * The second is a 404 in every email, WhatsApp message and Telegram message
 * carrying a button, and it stayed that way for months because nothing on this
 * side can see the storefront's route tree. `bot-list-window.ts` had already
 * written the warning down — *"two copies of the `as-needed` rule is one copy
 * that gets it wrong, and the wrong one fails silently"* — and then the second
 * copy was written anyway, somewhere it could not see the first.
 *
 * So: one implementation, and both callers delegate.
 *
 * ── The locale rule, and why it is not decoration ────────────────────────────
 *
 * `frontend/landing` routes with next-intl's `localePrefix: "as-needed"`:
 * English owns the unprefixed tree (`/shop`), and every other language is
 * prefixed (`/fr/shop`). Getting it wrong does not 404 — it silently serves an
 * English page to a customer who was written to in French, which no error
 * anywhere will ever report.
 *
 * ⚠ **The storefront may ship a SUBSET of the five** (`APP_LOCALES`, env-driven
 * in that repository, and only for the native build). A prefix for a dropped
 * locale would 404 — but only for a customer whose language that build does not
 * serve, who would have been shown English anyway.
 *
 * ⚠ **`SUPPORTED_LANGUAGES` here and `LOCALE_CODES` there must stay equal.**
 * Both are `['en','fr','pt','es','ar']` today. They are two hand-maintained
 * lists in two repositories with nothing comparing them, so a language added on
 * one side and not the other produces links into a tree that does not exist.
 */

/**
 * Fold anything a profile might hold — `fr`, `fr-FR`, `FR_fr`, `de`, null — onto
 * one of the five, defaulting to English.
 *
 * English is the safe direction: the unprefixed tree always exists.
 */
export function toStorefrontLocale(raw: string | null | undefined): Language {
    const primary = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0];
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(primary)
        ? (primary as Language)
        : DEFAULT_LANGUAGE;
}

/** `''` for English, `/fr` for the rest. The whole of the `as-needed` rule. */
export function storefrontLocalePrefix(language: string | null | undefined): string {
    const locale = toStorefrontLocale(language);
    return locale === DEFAULT_LANGUAGE ? '' : `/${locale}`;
}

/**
 * A storefront path, locale-prefixed, with a leading slash and no host.
 *
 * ⚠ **Takes a path this repository composed, never one a caller supplied.**
 * Everything reaching it is a literal written in a catalogue here. It is not a
 * redirector: handed an absolute URL it would happily concatenate, so do not
 * start passing it one.
 */
export function storefrontPath(path: string, language: string | null | undefined): string {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${storefrontLocalePrefix(language)}${suffix}`;
}

/**
 * The same path, absolute.
 *
 * Returns **null when `STOREFRONT_URL` is unset**, which is a real deployment
 * state rather than a missing value — a local box with no storefront running.
 * A caller must treat null as "there is no link" and render nothing, never the
 * string.
 */
export function storefrontUrl(
    path: string,
    language: string | null | undefined,
    baseUrl: string | null | undefined = process.env.STOREFRONT_URL,
): string | null {
    const base = (baseUrl || '').replace(/\/+$/, '');
    if (!base) return null;
    return `${base}${storefrontPath(path, language)}`;
}
