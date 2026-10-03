import { SUPPORTED_LANGUAGES, type Language } from '../../../core/constants/languages';
import { languageActionId } from './bot-action-id';
import { botChrome } from './bot-chrome-copy';
import type { BotReplyIntent } from './channel-reply';

/**
 * The language picker — one control, drawn by two doors.
 *
 * `acct:lang` (the account menu) and the onboarding `language` step (the FIRST question a new
 * customer is asked, owner 2026-10-02) both ask "which language?", and both are answered by the
 * same `lang:<code>` tap. One function draws it so the two cannot drift: a picker that gained a
 * sixth language in one door and not the other would be a customer offered a language they
 * cannot then choose.
 */

/**
 * Each language, written in itself.
 *
 * ⚠ **NOT copy, and it must never become copy.** These are endonyms: the French option says
 * *Français* to an Arabic speaker and to an English one, because the person who needs it is
 * precisely the person who cannot read the current language. A copy key would give five
 * translations of five names — twenty-five strings, twenty of them wrong to show anybody — and
 * would let a translator turn *Português* into *Portuguese*, which is the one word a Portuguese
 * speaker scanning the list is not looking for.
 *
 * Derived from `SUPPORTED_LANGUAGES` by a lookup rather than by a parallel array, so a sixth
 * language is a compile error here instead of a silently missing row.
 */
export const LANGUAGE_ENDONYM: Readonly<Record<Language, string>> = Object.freeze({
    en: 'English',
    fr: 'Français',
    pt: 'Português',
    es: 'Español',
    ar: 'العربية',
});

/**
 * The languages the chat OFFERS — English and French (owner, 2026-10-02: the market is
 * Cameroon, "just ask 2 languages, either French or English").
 *
 * ⚠ **Offered, not supported.** Every copy table still carries all five, a stored `pt` keeps
 * working, and a typed "Español" is still understood — this list only decides which buttons
 * are drawn. Adding a market's language back is one entry here.
 */
export const CHAT_LANGUAGES: readonly Language[] = Object.freeze(['en', 'fr'] as const);

/** The picker: one row per offered language, labelled in itself, answered by `lang:<code>`. */
export function languageChoiceIntent(text: string, language: string | null): BotReplyIntent {
    return {
        kind: 'choice',
        text,
        options: CHAT_LANGUAGES.map((code) => ({
            id: languageActionId(code),
            label: LANGUAGE_ENDONYM[code],
        })),
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    };
}

/**
 * What a customer may TYPE instead of tapping, per language code.
 *
 * ⚠ **Not a translation table — a recogniser.** The picker is the designed answer; this exists
 * because a chat keeps its keyboard open and somebody will type "français" rather than tap it.
 * Each language is recognised by its code, its endonym and its name in the other four, so the
 * typed answer works whatever language the question happened to be written in.
 */
const TYPED_NAMES: Readonly<Record<Language, readonly string[]>> = Object.freeze({
    en: ['en', 'english', 'anglais', 'inglês', 'ingles', 'inglés', 'الإنجليزية', 'الانجليزية', 'انجليزي'],
    fr: ['fr', 'français', 'francais', 'french', 'francês', 'frances', 'francés', 'الفرنسية', 'فرنسي'],
    pt: ['pt', 'português', 'portugues', 'portuguese', 'portugais', 'portugués', 'البرتغالية'],
    es: ['es', 'español', 'espanol', 'spanish', 'espagnol', 'espanhol', 'الإسبانية', 'الاسبانية'],
    ar: ['ar', 'العربية', 'عربي', 'arabic', 'arabe', 'árabe'],
});

/**
 * A typed language answer → its code, or null when it names none of the five.
 *
 * Case- and edge-punctuation-insensitive. Deliberately exact otherwise: "I speak a bit of
 * French" is a sentence, not an answer, and guessing from it would set a preference the customer
 * did not choose — the one thing this step exists to prevent.
 */
export function parseLanguageAnswer(raw: string | null | undefined): Language | null {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.trim().toLowerCase().replace(/^[\s.!?,;:'"«»]+|[\s.!?,;:'"«»]+$/g, '');
    if (cleaned.length === 0) return null;

    for (const code of SUPPORTED_LANGUAGES) {
        if (TYPED_NAMES[code].includes(cleaned)) return code;
    }
    return null;
}
