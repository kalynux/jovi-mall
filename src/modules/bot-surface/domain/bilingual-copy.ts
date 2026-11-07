/**
 * English AND French in one message — for what the bot says BEFORE it knows the customer's language.
 *
 * The phone number comes first on Telegram (no account can exist without it) and the language is
 * asked only after it, so the very first message a new customer reads is written before anybody
 * knows which of the two they read. The platform's market is bilingual English/French (Cameroon),
 * and a guess from the client's settings is often wrong — a French speaker with an English phone
 * was greeted in English (owner, 2026-10-26). So these messages carry both, English first, with a
 * line between them so neither reads as one run-on paragraph.
 *
 * Only for that pre-language moment. Once the language step is answered, every message is in the
 * customer's own language as before.
 */

/** The line between the two texts. Plain characters both chats draw identically, no markup. */
export const BILINGUAL_SEPARATOR = '──────────';

/** `en`, a separator line, `fr`. */
export function bilingualText(copy: { en: string; fr: string }): string {
    return `${copy.en}\n${BILINGUAL_SEPARATOR}\n${copy.fr}`;
}

/**
 * One BUTTON in both languages — `📱 Share my number / Partager mon numéro`. A button holds one line,
 * so the two are joined by a slash, and a leading symbol both share (the 📱) is written once.
 *
 * ⚠ Deliberately imports nothing: the copy tables import each other, and this is called from both.
 */
export function bilingualLabel(en: string, fr: string): string {
    const a = Array.from(en);
    const b = Array.from(fr);
    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared] && !/[A-Za-zÀ-ÿ0-9]/.test(a[shared])) {
        shared += 1;
    }
    return `${en} / ${b.slice(shared).join('')}`;
}
