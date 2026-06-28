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
