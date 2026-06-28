/**
 * Supported user-facing languages (ISO 639-1).
 *
 * Canonical list shared by role models/validators (preferred_language) and the
 * notification i18n layer. Keep in sync with the WhatsApp template languages in
 * api-doc/notifications/whatsapp-templates.md.
 */
export const SUPPORTED_LANGUAGES = ['en', 'fr', 'pt', 'es', 'ar'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';
