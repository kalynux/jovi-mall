import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';
import { LANGUAGE_ENDONYM } from './language-choice';

/**
 * The review at the end of setup — what the platform recorded, shown back before the welcome
 * (owner, 2026-10-03).
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * Setup asks its questions in a chat, and a chat does not stop the customer saying something
 * else. Asked for their name, a customer sometimes asks a question instead — "how much is
 * delivery?" — and that sentence is saved as their name, because nothing can tell a name from a
 * question. The review puts every recorded value in front of them once, so a wrong one is SEEN.
 *
 * ── HOW A WRONG VALUE GETS FIXED ─────────────────────────────────────────────
 * Not here. The customer just says what is wrong, and the assistant corrects it with the profile
 * tools it already has. This turn's reply is recorded in `recentlySent`, so the assistant can
 * see what the customer is correcting. There is deliberately no "edit" button: a button per
 * field would be five more controls on WhatsApp, which draws at most three.
 *
 * ── WHAT IT MAY NOT DO ───────────────────────────────────────────────────────
 * Pure, imports no model, and never names an internal concept. An absent value reads as
 * "not provided", never as an empty label or `null`: a skipped email is an answer the
 * customer gave, and the review must show it as one.
 */

/** What the review shows. Plain values, already read off the profile. */
export interface OnboardingReviewFacts {
    name: string | null;
    phone: string | null;
    email: string | null;
    /** One line, already composed (`address_line1, city`). */
    address: string | null;
    /** A language code; shown as the language's own name. */
    language: string | null;
}

interface ReviewCopy {
    title: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    language: string;
    notProvided: string;
    ask: string;
}

const REVIEW: Readonly<Record<BotCopyLanguage, ReviewCopy>> = Object.freeze({
    en: {
        title: 'Here is what I have saved for you:',
        name: 'Name',
        phone: 'Phone',
        email: 'Email',
        address: 'Delivery address',
        language: 'Language',
        notProvided: 'not provided',
        ask: 'Is everything correct? If anything is wrong, just tell me what to change.',
    },
    fr: {
        title: "Voici ce que j'ai enregistré pour vous :",
        name: 'Nom',
        phone: 'Téléphone',
        email: 'E-mail',
        address: 'Adresse de livraison',
        language: 'Langue',
        notProvided: 'non renseigné',
        ask: 'Tout est-il correct ? Si quelque chose ne va pas, dites-moi simplement quoi changer.',
    },
    pt: {
        title: 'Eis o que guardei para si:',
        name: 'Nome',
        phone: 'Telefone',
        email: 'E-mail',
        address: 'Morada de entrega',
        language: 'Idioma',
        notProvided: 'não indicado',
        ask: 'Está tudo correto? Se algo estiver errado, diga-me apenas o que mudar.',
    },
    es: {
        title: 'Esto es lo que he guardado para ti:',
        name: 'Nombre',
        phone: 'Teléfono',
        email: 'Correo',
        address: 'Dirección de entrega',
        language: 'Idioma',
        notProvided: 'no indicado',
        ask: '¿Está todo correcto? Si algo está mal, solo dime qué cambiar.',
    },
    ar: {
        title: 'هذه هي المعلومات التي حفظتها لك:',
        name: 'الاسم',
        phone: 'الهاتف',
        email: 'البريد الإلكتروني',
        address: 'عنوان التوصيل',
        language: 'اللغة',
        notProvided: 'غير مُحدَّد',
        ask: 'هل كل شيء صحيح؟ إذا كان هناك خطأ، أخبرني فقط بما يجب تغييره.',
    },
});

/**
 * ⚠ **Clamped**, because the review shares one message with the welcome and its buttons, and a
 * WhatsApp interactive body stops at 1024 characters — over it, Meta refuses the whole message.
 * A geocoded address is the one value long enough to matter.
 */
const VALUE_CAP = 120;

function shown(value: string | null, copy: ReviewCopy): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length === 0) return copy.notProvided;
    return trimmed.length > VALUE_CAP ? `${trimmed.slice(0, VALUE_CAP - 1)}…` : trimmed;
}

/** The review block: a title, one line per value, and the question. */
export function onboardingReviewFor(facts: OnboardingReviewFacts, language: string | null): string {
    const copy = REVIEW[toBotCopyLanguage(language)];
    const languageName = facts.language && facts.language in LANGUAGE_ENDONYM
        ? LANGUAGE_ENDONYM[facts.language as keyof typeof LANGUAGE_ENDONYM]
        : facts.language;

    return [
        copy.title,
        `• ${copy.name}: ${shown(facts.name, copy)}`,
        `• ${copy.phone}: ${shown(facts.phone, copy)}`,
        `• ${copy.email}: ${shown(facts.email, copy)}`,
        `• ${copy.address}: ${shown(facts.address, copy)}`,
        `• ${copy.language}: ${shown(languageName, copy)}`,
        '',
        copy.ask,
    ].join('\n');
}

/** Refuse to boot on a language with an empty review string — same rule as the prompts. */
export function assertOnboardingReviewCopyComplete(): void {
    const gaps = BOT_COPY_LANGUAGES.flatMap((lang) =>
        Object.entries(REVIEW[lang]).filter(([, v]) => !v || !v.trim()).map(([k]) => `${lang}.${k}`),
    );
    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] onboarding review copy is missing: ${gaps.join(', ')}`);
    }
}
