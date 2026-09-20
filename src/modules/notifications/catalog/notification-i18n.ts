/**
 * Notification i18n
 *
 * Language types and resolution shared by the notification catalog and handlers.
 * We serve users across countries, so every notification is rendered in the
 * recipient's preferred language and (for WhatsApp templates) sent with the
 * matching Meta language code.
 */

import { SUPPORTED_LANGUAGES, Language, DEFAULT_LANGUAGE } from '../../../core/constants/languages';

export { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE };
export type { Language };

/**
 * Map our ISO 639-1 language to the WhatsApp/Meta template language code.
 * These codes must match the languages the templates are approved in.
 */
export const META_LANGUAGE_CODE: Record<Language, string> = {
    en: 'en',
    fr: 'fr',
    pt: 'pt_PT',
    es: 'es',
    ar: 'ar'
};

/**
 * ⛔ **The languages our WhatsApp templates are actually APPROVED in — two, not five.**
 *
 * The platform speaks five languages and Meta has cleared our templates in two. That gap is
 * not a bug to be fixed here; it is a deliberate choice, taken by the project owner for a
 * faster approval round. What WAS a bug is what happened when the two disagreed.
 *
 * ── ⚠ Why this constant has to exist at all ─────────────────────────────────
 *
 * The send path asked Meta for `META_LANGUAGE_CODE[lang]` with no fallback. For a customer
 * whose language is `pt`, `es` or `ar` that names a template Meta has never approved, so the
 * **send is refused and the customer is told nothing** — outside the 24-hour window, which is
 * exactly when a template is the only way to reach them. It fails silently: the refusal is
 * caught and written to the notification row as a delivery error, and nothing alerts.
 *
 * It was invisible for a second reason worth knowing: `template-registry.ts` registers every
 * template in all FIVE languages, so the code's own model of the world said the template
 * existed. ⚠ **That registry is still wrong** — it lives in the WhatsApp module rather than
 * here, and correcting it is a separate change.
 *
 * ⚠ **KEEP THIS IN STEP WITH WHAT IS SUBMITTED.** The generator writes its language list into
 * `api-doc/notifications/whatsapp-template-payloads.json` (`languages`), and
 * `test:customer-notifications` asserts the two agree — so adding a third approved language
 * means changing this line, and forgetting to fails the suite rather than the customer.
 */
export const TEMPLATE_LANGUAGES: readonly Language[] = Object.freeze(['en', 'fr'] as const);

/**
 * The Meta language code to send a template in, for a recipient who reads `lang`.
 *
 * ⛔ **An unapproved language falls back to ENGLISH, explicitly and by name.** Never to "the
 * first approved language", never to whatever a lookup happens to return, and never to
 * nothing — each of those turns a deliberate degradation into an accident, and the last one
 * is the silence this function exists to end.
 *
 * The trade, stated so nobody re-litigates it by accident: an Arabic-reading customer gets an
 * English delivery notice. That is the accepted cost. Getting **no** notice is not.
 *
 * ⚠ **This is about the pre-approved templates only.** In-chat copy, email, Telegram and the
 * in-app inbox are all five languages and stay that way — they need nobody's approval.
 *
 * ⚠ **The literal `'en'`, deliberately NOT `DEFAULT_LANGUAGE`.** They are the same value
 * today and they are not the same idea: `DEFAULT_LANGUAGE` is "what this platform speaks when
 * it knows nothing about you", and this is "the one language our templates are certainly
 * approved in". Routing through the constant would mean that changing the platform default to
 * French silently moves this fallback too — and because French IS approved, nothing would
 * break loudly; the rule would just quietly stop being the rule. Named, so it cannot drift.
 */
const TEMPLATE_FALLBACK_LANGUAGE: Language = 'en';

export function templateLanguage(lang: Language): string {
    const approved = TEMPLATE_LANGUAGES.includes(lang) ? lang : TEMPLATE_FALLBACK_LANGUAGE;
    return META_LANGUAGE_CODE[approved];
}

/** Type guard for a supported language. */
export function isSupportedLanguage(value: unknown): value is Language {
    return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Resolve the preferred language of any role entity.
 *
 * Reads `preferred_language` (vendor/agency/agent) or `preferences.language`
 * (customer), normalizing anything unknown/missing to the default.
 */
export function resolveLanguage(entity: unknown): Language {
    if (!entity || typeof entity !== 'object') return DEFAULT_LANGUAGE;

    const e = entity as {
        preferred_language?: unknown;
        preferences?: { language?: unknown };
    };

    const candidate = e.preferred_language ?? e.preferences?.language;
    return isSupportedLanguage(candidate) ? candidate : DEFAULT_LANGUAGE;
}
