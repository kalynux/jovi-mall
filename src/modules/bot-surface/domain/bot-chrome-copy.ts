import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';

/**
 * The words that are BUTTONS rather than sentences — a keyboard label, a list header, the
 * text on a call-to-action.
 *
 * ── WHY THIS IS A THIRD COPY TABLE AND NOT A GROWTH OF THE OTHER TWO ────────
 * `bot-error-copy.ts` words a failure and `bot-onboarding-copy.ts` words a question. Both
 * produce a SENTENCE the customer reads in the message body. What is here is chrome: text
 * that is rendered by the messaging client as a control, is subject to that client's own
 * length caps (WhatsApp truncates a reply-button title at 20 characters and a list row at
 * 24 — `WA_LIMITS`), and has no meaning at all outside the widget it labels.
 *
 * Keeping it separate is what makes those caps checkable. A sentence has no cap and a
 * button does; mixing them means either a boot assert that cannot be written or a caption
 * that arrives cut in half on one channel and intact on the other.
 *
 * ── IT EXISTS BECAUSE THE WALKTHROUGH ADMITTED THE GAP IN WRITING ───────────
 * `api-doc/n8n/TELEGRAM-ONBOARDING-WALKTHROUGH.md` used to tell the automation layer:
 * *"The button's own label is the one string you must supply, because it is Telegram chrome
 * rather than a message. Key it off `identity.language` from a four-entry table in the
 * workflow."*
 *
 * That is the same premise `bot-error-copy.ts` was written to correct, arriving by a third
 * door: **the automation layer has no copy table.** One four-entry table in an n8n
 * expression is one table nobody translates, nobody reviews and nobody notices has gone
 * stale — and it sits on the single most important turn in the whole product, the one where
 * a stranger decides whether to hand over their phone number.
 *
 * The rule is now complete rather than nearly complete: **every character the customer
 * sees is written here, body and chrome alike.**
 */

type Copy = Record<BotCopyLanguage, string>;

/**
 * The Telegram `request_contact` button.
 *
 * The emoji is part of the label rather than prepended by the renderer: a button that
 * carries one on Telegram and not on WhatsApp would be two designs, and the renderer's job
 * is to place text, never to decorate it.
 */
const CONTACT_BUTTON: Copy = {
    en: '📱 Share my number',
    fr: '📱 Partager mon numéro',
    pt: '📱 Partilhar o meu número',
    es: '📱 Compartir mi número',
    ar: '📱 مشاركة رقمي',
};

/**
 * The question above a list of address candidates.
 *
 * ⚠ **Deliberately says nothing about addresses.** It labels a CHOICE, and the address
 * picker is simply the first thing that needed one. A payment-method picker and a
 * "which order did you mean" picker are the same widget with different rows, and a
 * sentence naming addresses would have to be replaced rather than reused on the day one of
 * those lands.
 */
const CHOOSE_PROMPT: Copy = {
    en: 'Which one is right?',
    fr: 'Laquelle est la bonne ?',
    pt: 'Qual é a correta?',
    es: '¿Cuál es la correcta?',
    ar: 'أيٌّ منها الصحيح؟',
};

/** WhatsApp's list-open button. `WA_LIMITS.LIST_BUTTON` is 20 characters. */
const CHOOSE_LIST_BUTTON: Copy = {
    en: 'Choose',
    fr: 'Choisir',
    pt: 'Escolher',
    es: 'Elegir',
    ar: 'اختر',
};

/** WhatsApp's list section heading. `WA_LIMITS.LIST_SECTION_TITLE` is 24 characters. */
const CHOOSE_SECTION_TITLE: Copy = {
    en: 'Options',
    fr: 'Options',
    pt: 'Opções',
    es: 'Opciones',
    ar: 'الخيارات',
};

/**
 * Decline an optional step.
 *
 * ⚠ **This label replaced a WORD THE CUSTOMER HAD TO TYPE.** The prompts used to end with
 * *"just say \"skip\" if you would rather not"*, which meant a French customer typed
 * *« passer »* and something downstream had to know that five spellings are one intent —
 * in the layer with no copy table. The label is translated; the id it carries
 * (`skipActionId`) is not. `WA_LIMITS.BUTTON_REPLY_TITLE` is 20 characters.
 */
const SKIP_BUTTON: Copy = {
    en: 'Skip',
    fr: 'Passer',
    pt: 'Saltar',
    es: 'Omitir',
    ar: 'تخطٍّ',
};

/** The body above a payment link. */
const PAY_PROMPT: Copy = {
    en: 'Tap below to pay securely.',
    fr: 'Appuyez ci-dessous pour payer en toute sécurité.',
    pt: 'Toque abaixo para pagar em segurança.',
    es: 'Toca abajo para pagar de forma segura.',
    ar: 'اضغط أدناه للدفع بأمان.',
};

/** The payment button. `WA_LIMITS.CTA_DISPLAY_TEXT` is 20 characters. */
const PAY_BUTTON: Copy = {
    en: 'Pay now',
    fr: 'Payer maintenant',
    pt: 'Pagar agora',
    es: 'Pagar ahora',
    ar: 'ادفع الآن',
};

/**
 * Every chrome string, and the cap each one has to satisfy.
 *
 * The cap travels WITH the string rather than being applied at the call site, which is what
 * lets `assertBotChromeCopyFits` check the whole table at boot instead of trusting five
 * renderers to remember five different numbers. `null` means the string is a body rather
 * than a control and has no meaningful cap short of the channel's message limit.
 */
const CHROME = Object.freeze({
    contactButton: { copy: CONTACT_BUTTON, cap: null },
    choosePrompt: { copy: CHOOSE_PROMPT, cap: null },
    chooseListButton: { copy: CHOOSE_LIST_BUTTON, cap: 20 },
    chooseSectionTitle: { copy: CHOOSE_SECTION_TITLE, cap: 24 },
    skipButton: { copy: SKIP_BUTTON, cap: 20 },
    payPrompt: { copy: PAY_PROMPT, cap: null },
    payButton: { copy: PAY_BUTTON, cap: 20 },
} as const);

export type BotChromeKey = keyof typeof CHROME;

/**
 * One chrome string, in the customer's language.
 *
 * Falls back to English on a language with no entry and never to the key — a customer shown
 * the word `payButton` has been shown an internal identifier, which is the failure the
 * whole copy layer exists to prevent.
 */
export function botChrome(key: BotChromeKey, language: string | null | undefined): string {
    const { copy } = CHROME[key];
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/**
 * Refuse to boot on a missing translation OR on one that a messaging client would truncate.
 *
 * The second half is the one worth having. A missing string is loud the first time anybody
 * reads that language; a string two characters over WhatsApp's button cap is silent
 * forever, arrives as `Pagar agor…` to exactly the customers who read Portuguese, and is
 * the kind of defect that is only ever reported as "the bot looks broken".
 *
 * A bare `Error` — this runs before any request exists, beside the other boot assertions.
 */
export function assertBotChromeCopyFits(): void {
    const gaps: string[] = [];

    for (const key of Object.keys(CHROME) as BotChromeKey[]) {
        const { copy, cap } = CHROME[key];
        for (const lang of BOT_COPY_LANGUAGES) {
            const value = copy[lang];
            if (typeof value !== 'string' || value.trim().length === 0) {
                gaps.push(`${key}:${lang} is missing`);
                continue;
            }
            if (cap !== null && value.length > cap) {
                gaps.push(`${key}:${lang} is ${value.length} chars, cap is ${cap}`);
            }
        }
    }

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] chrome copy is unusable: ${gaps.join('; ')}`);
    }
}

/** ⚠ Exported for `test:bot-surface`, which re-checks the caps the assert above enforces. */
export const __CHROME_TABLE = CHROME;
