import { ERROR_CATEGORIES, ErrorCategory } from '../../../core/error-category';
import { ERROR_CODES, ErrorCode } from '../../../core/error-codes';

/**
 * What the CUSTOMER is told when a bot call fails — a sentence, in their language.
 *
 * ── WHY THE ERROR ENVELOPE WAS NOT ENOUGH ────────────────────────────────────
 * Phase 16's envelope carries `code`, `category` and a `message`, and that `message` is
 * written for the AUTOMATION LAYER — `DEFAULT_ERROR_MESSAGES`' own bot block says so in as
 * many words, on the grounds that n8n turns an outcome into copy and a second English
 * sentence here would be an un-localised duplicate of one it already owns.
 *
 * **That premise was wrong, and the product owner corrected it on 2026-08-26.** The
 * automation layer has no copy table and no translator: what it can do is relay a string.
 * So an error whose only human-readable half is *"No platform account is bound to this
 * messaging identity"* reaches a customer as either that sentence — which means nothing to
 * them and leaks the shape of our data model — or as nothing at all. The backend is the
 * only place that knows the code, the category AND the customer's language, so it is the
 * only place that can produce the sentence.
 *
 * ── TWO MESSAGES, NOT ONE, AND THEY ARE NOT INTERCHANGEABLE ─────────────────
 *
 *   `error.message`         — for the operator and the automation layer. Unchanged, still
 *                             English, still what `/system/errors` shows and what a
 *                             developer greps for.
 *   `error.customerMessage` — for the person in the chat. Localised, non-technical, never
 *                             names a code, a field, a collection or an internal concept.
 *
 * Replacing the first with the second was the tempting simplification and it would have
 * been a bad trade: an operator reading *"Something went wrong. Please try again."* in an
 * incident has been told nothing, and the code alone does not say which of a code's several
 * call sites fired.
 *
 * ── THE FALLBACK IS THE DESIGN, NOT THE GAP ─────────────────────────────────
 * There are 541 error codes and any of them can surface through a delegated call. Localising
 * all of them in five languages is 2 705 strings that would go stale the week after they
 * were written. So the catalogue below is **specific where being specific changes what the
 * customer does**, and everything else falls back to a sentence keyed on the nine-value
 * CATEGORY — which is always present, is derived rather than annotated, and already means
 * exactly "what kind of thing went wrong".
 *
 * The result: every error reaches the customer as a real sentence in a language they read,
 * a specific one where we have written it, and an honest general one where we have not.
 * There is no path to a raw code reaching a chat window.
 *
 * ⚠ **A missing translation falls back to ENGLISH, never to the code.** The completeness
 * assert below runs at import and refuses to boot on a half-translated entry, which is the
 * same discipline every notification catalog follows — but the runtime lookup is defensive
 * anyway, because a boot-time guarantee is worth nothing to a customer if it is ever
 * loosened.
 */

/** The five languages every notification catalog in this service has copy for. */
export const BOT_COPY_LANGUAGES = Object.freeze(['en', 'fr', 'pt', 'es', 'ar'] as const);
export type BotCopyLanguage = (typeof BOT_COPY_LANGUAGES)[number];

const DEFAULT_LANGUAGE: BotCopyLanguage = 'en';

type Copy = Record<BotCopyLanguage, string>;

/**
 * Resolve any language-ish string onto one we have copy for.
 *
 * Matches the PRIMARY SUBTAG, so Telegram's `pt-BR` and `en-GB` land on `pt` and `en`
 * rather than falling through to English by accident — a Brazilian customer reading English
 * because of a region suffix is a bug nobody would ever report.
 */
export function toBotCopyLanguage(raw: string | null | undefined): BotCopyLanguage {
    const primary = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0];
    return (BOT_COPY_LANGUAGES as readonly string[]).includes(primary)
        ? (primary as BotCopyLanguage)
        : DEFAULT_LANGUAGE;
}

// ─────────────────────────────────────────────────────────────────────────────
// The category fallback — nine sentences, and they cover all 541 codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **These are written to be TRUE OF EVERY CODE in their category**, which is why they say
 * so little. A category sentence that guessed at specifics would be confidently wrong on
 * most of the codes it has to cover — and a customer acting on a wrong specific is worse
 * off than one told honestly that something did not work.
 *
 * `internal` and `external_service` deliberately do not distinguish themselves to the
 * customer: "our fault" and "our supplier's fault" are the same fact from a chat window,
 * and the boundary already masks both on the operator side for the same reason.
 */
const CATEGORY_COPY: Readonly<Record<ErrorCategory, Copy>> = Object.freeze({
    [ERROR_CATEGORIES.AUTHENTICATION]: {
        en: 'I could not confirm who you are. Please try again.',
        fr: "Je n'ai pas pu confirmer votre identité. Veuillez réessayer.",
        pt: 'Não consegui confirmar quem você é. Tente novamente.',
        es: 'No pude confirmar quién eres. Inténtalo de nuevo.',
        ar: 'لم أتمكن من التحقق من هويتك. يرجى المحاولة مرة أخرى.',
    },
    [ERROR_CATEGORIES.AUTHORIZATION]: {
        en: 'You do not have access to that.',
        fr: "Vous n'avez pas accès à cela.",
        pt: 'Você não tem acesso a isso.',
        es: 'No tienes acceso a eso.',
        ar: 'ليس لديك حق الوصول إلى ذلك.',
    },
    [ERROR_CATEGORIES.VALIDATION]: {
        en: "That does not look right. Could you send it again?",
        fr: "Cela ne semble pas correct. Pouvez-vous le renvoyer ?",
        pt: 'Isso não parece certo. Pode enviar novamente?',
        es: 'Eso no parece correcto. ¿Puedes enviarlo de nuevo?',
        ar: 'لا يبدو ذلك صحيحًا. هل يمكنك إرساله مرة أخرى؟',
    },
    [ERROR_CATEGORIES.NOT_FOUND]: {
        en: "I could not find that.",
        fr: "Je n'ai pas trouvé cela.",
        pt: 'Não consegui encontrar isso.',
        es: 'No pude encontrar eso.',
        ar: 'لم أتمكن من العثور على ذلك.',
    },
    [ERROR_CATEGORIES.CONFLICT]: {
        en: 'That has already changed. Let me check where things stand and try again.',
        fr: "Cela a déjà changé. Je vérifie la situation et réessaie.",
        pt: 'Isso já mudou. Vou verificar a situação e tentar de novo.',
        es: 'Eso ya ha cambiado. Voy a comprobarlo e intentarlo de nuevo.',
        ar: 'لقد تغيّر ذلك بالفعل. سأتحقق من الوضع وأحاول مرة أخرى.',
    },
    [ERROR_CATEGORIES.BUSINESS_RULE]: {
        en: 'That is not possible right now.',
        fr: "Ce n'est pas possible pour le moment.",
        pt: 'Isso não é possível neste momento.',
        es: 'Eso no es posible en este momento.',
        ar: 'هذا غير ممكن في الوقت الحالي.',
    },
    [ERROR_CATEGORIES.RATE_LIMIT]: {
        en: 'That was a lot at once. Give me a moment and try again.',
        fr: "Cela fait beaucoup d'un coup. Laissez-moi un instant et réessayez.",
        pt: 'Foi muita coisa de uma vez. Aguarde um momento e tente de novo.',
        es: 'Eso fue mucho de golpe. Dame un momento e inténtalo de nuevo.',
        ar: 'كان ذلك كثيرًا دفعة واحدة. امهلني لحظة ثم حاول مرة أخرى.',
    },
    [ERROR_CATEGORIES.EXTERNAL_SERVICE]: {
        en: 'Something went wrong on our side. Please try again in a moment.',
        fr: "Un problème est survenu de notre côté. Réessayez dans un instant.",
        pt: 'Algo deu errado do nosso lado. Tente novamente em instantes.',
        es: 'Algo salió mal por nuestra parte. Inténtalo de nuevo en un momento.',
        ar: 'حدث خطأ من جانبنا. يرجى المحاولة مرة أخرى بعد قليل.',
    },
    [ERROR_CATEGORIES.INTERNAL]: {
        en: 'Something went wrong on our side. Please try again in a moment.',
        fr: "Un problème est survenu de notre côté. Réessayez dans un instant.",
        pt: 'Algo deu errado do nosso lado. Tente novamente em instantes.',
        es: 'Algo salió mal por nuestra parte. Inténtalo de nuevo en un momento.',
        ar: 'حدث خطأ من جانبنا. يرجى المحاولة مرة أخرى بعد قليل.',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-code copy — only where being specific changes what the customer does
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **The test for adding an entry here is "does the customer do something different?"**
 *
 * `BOT_GEO_CANDIDATE_EXPIRED` earns one because the customer must search again rather than
 * wait. `MESSAGING_IDENTITY_ALREADY_LINKED` earns one because the remedy is a different
 * conversation entirely. A code whose only honest customer-facing sentence is "that did not
 * work" does NOT earn one — its category already says exactly that, in five languages, and
 * a near-duplicate entry is one more string to keep in step for no gain.
 *
 * ⚠ **Nothing here may name an internal concept.** No "customer profile", no "identity", no
 * "token", no field name, no collection. A sentence a customer cannot act on is a sentence
 * that should have been left to the category fallback.
 */
const CODE_COPY: Partial<Record<ErrorCode, Copy>> = Object.freeze({
    // ── Registration and onboarding (GAP-002) ────────────────────────────────
    [ERROR_CODES.BOT_IDENTITY_UNRESOLVED]: {
        en: "I do not have an account for you yet. Send me a message and I will set one up.",
        fr: "Je n'ai pas encore de compte pour vous. Écrivez-moi et je vais en créer un.",
        pt: 'Ainda não tenho uma conta para você. Escreva-me e eu crio uma.',
        es: 'Todavía no tengo una cuenta para ti. Escríbeme y te creo una.',
        ar: 'ليس لديّ حساب لك بعد. راسلني وسأنشئ لك حسابًا.',
    },
    [ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT]: {
        en: 'I need your phone number first. Tap the button below to share it.',
        fr: "J'ai d'abord besoin de votre numéro de téléphone. Appuyez sur le bouton ci-dessous pour le partager.",
        pt: 'Preciso primeiro do seu número de telefone. Toque no botão abaixo para compartilhá-lo.',
        es: 'Primero necesito tu número de teléfono. Toca el botón de abajo para compartirlo.',
        ar: 'أحتاج أولًا إلى رقم هاتفك. اضغط على الزر أدناه لمشاركته.',
    },
    [ERROR_CODES.MAGIC_CONTACT_UNVERIFIED]: {
        en: 'That contact is not yours. Please use the button to share your own number.',
        fr: "Ce contact n'est pas le vôtre. Utilisez le bouton pour partager votre propre numéro.",
        pt: 'Esse contato não é seu. Use o botão para compartilhar o seu próprio número.',
        es: 'Ese contacto no es tuyo. Usa el botón para compartir tu propio número.',
        ar: 'جهة الاتصال هذه ليست لك. استخدم الزر لمشاركة رقمك الخاص.',
    },
    [ERROR_CODES.BOT_REGISTRATION_IDENTITY_TAKEN]: {
        en: 'This chat is already connected to a different account. Please contact support.',
        fr: "Cette conversation est déjà liée à un autre compte. Veuillez contacter le support.",
        pt: 'Esta conversa já está ligada a outra conta. Entre em contato com o suporte.',
        es: 'Este chat ya está vinculado a otra cuenta. Ponte en contacto con soporte.',
        ar: 'هذه المحادثة مرتبطة بالفعل بحساب آخر. يرجى التواصل مع الدعم.',
    },
    [ERROR_CODES.AUTH_ACCOUNT_SUSPENDED]: {
        en: 'Your account is not active at the moment. Please contact support.',
        fr: "Votre compte n'est pas actif pour le moment. Veuillez contacter le support.",
        pt: 'Sua conta não está ativa no momento. Entre em contato com o suporte.',
        es: 'Tu cuenta no está activa en este momento. Ponte en contacto con soporte.',
        ar: 'حسابك غير نشط في الوقت الحالي. يرجى التواصل مع الدعم.',
    },

    // ── The address flow (GAP-005) ───────────────────────────────────────────
    // Earns an entry because the remedy is an ACTION — search again — and the category
    // sentence ("that does not look right") would have the customer re-send the same thing.
    [ERROR_CODES.BOT_GEO_CANDIDATE_EXPIRED]: {
        en: 'That address search has expired. Tell me the address again and I will look it up.',
        fr: "Cette recherche d'adresse a expiré. Redonnez-moi l'adresse et je la rechercherai.",
        pt: 'Essa busca de endereço expirou. Diga-me o endereço novamente e eu procuro.',
        es: 'Esa búsqueda de dirección ha caducado. Dime la dirección otra vez y la busco.',
        ar: 'انتهت صلاحية البحث عن هذا العنوان. أخبرني بالعنوان مرة أخرى وسأبحث عنه.',
    },

    // ── Support routing (GAP-004) ────────────────────────────────────────────
    // Both earn an entry because both remedies are ACTIONS the customer takes,
    // and both category sentences ("I could not find that" / "that has already
    // changed") would send them back to repeat the same question.
    [ERROR_CODES.BOT_SUPPORT_NO_CONTEXT]: {
        en: 'Tell me which order or item this is about and I will point you to the right person — or I can pass you to our support team.',
        fr: "Dites-moi de quelle commande ou de quel article il s'agit et je vous orienterai vers la bonne personne — ou je peux vous mettre en relation avec notre support.",
        pt: 'Diga-me a que encomenda ou artigo se refere e eu indico a pessoa certa — ou posso encaminhá-lo para o nosso apoio ao cliente.',
        es: 'Dime a qué pedido o artículo se refiere y te indicaré con quién hablar — o puedo pasarte con nuestro soporte.',
        ar: 'أخبرني بالطلب أو المنتج المقصود وسأرشدك إلى الشخص المناسب، أو يمكنني تحويلك إلى فريق الدعم.',
    },
    [ERROR_CODES.BOT_SUPPORT_SCOPE_UNAVAILABLE]: {
        en: 'I do not have those contact details for this one yet. I can share the contacts I do have, or pass you to our support team.',
        fr: "Je n'ai pas encore ces coordonnées pour celui-ci. Je peux vous donner celles que j'ai, ou vous mettre en relation avec notre support.",
        pt: 'Ainda não tenho esses contactos para este caso. Posso partilhar os que tenho, ou encaminhá-lo para o nosso apoio ao cliente.',
        es: 'Todavía no tengo esos datos de contacto para este caso. Puedo darte los que sí tengo, o pasarte con nuestro soporte.',
        ar: 'لا تتوفر لديّ بيانات التواصل هذه بعد لهذه الحالة. يمكنني إعطاؤك ما لديّ، أو تحويلك إلى فريق الدعم.',
    },

    // ── Retryable machinery ──────────────────────────────────────────────────
    // The three idempotency refusals are the automation layer's business, not the
    // customer's — but if one does reach a chat window it must not read as a rejection of
    // something they did. "Still working on it" is true of all three.
    [ERROR_CODES.BOT_IDEMPOTENCY_IN_PROGRESS]: {
        en: 'I am still working on that. Give me a moment.',
        fr: "Je m'en occupe encore. Un instant.",
        pt: 'Ainda estou tratando disso. Um momento.',
        es: 'Todavía estoy con eso. Un momento.',
        ar: 'ما زلت أعمل على ذلك. لحظة من فضلك.',
    },
    [ERROR_CODES.BOT_IDEMPOTENCY_STORE_UNAVAILABLE]: {
        en: 'I could not complete that just now. Please try again in a moment.',
        fr: "Je n'ai pas pu terminer cela maintenant. Réessayez dans un instant.",
        pt: 'Não consegui concluir isso agora. Tente novamente em instantes.',
        es: 'No he podido completar eso ahora. Inténtalo de nuevo en un momento.',
        ar: 'لم أتمكن من إتمام ذلك الآن. يرجى المحاولة مرة أخرى بعد قليل.',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sentence to relay to the customer, for any code, in any language. Never empty.
 *
 * Three tiers, first match wins: the per-code entry in the requested language, that entry
 * in English, then the category sentence. There is deliberately no fourth tier and no path
 * that returns the code — a raw `BOT_IDENTITY_UNRESOLVED` in a chat window is the exact
 * failure this function exists to make impossible.
 */
export function customerMessageFor(
    code: string,
    category: ErrorCategory,
    language: string | null | undefined,
): string {
    const lang = toBotCopyLanguage(language);
    const specific = CODE_COPY[code as ErrorCode];

    if (specific) return specific[lang] ?? specific[DEFAULT_LANGUAGE];

    const fallback = CATEGORY_COPY[category] ?? CATEGORY_COPY[ERROR_CATEGORIES.INTERNAL];
    return fallback[lang] ?? fallback[DEFAULT_LANGUAGE];
}

/**
 * Refuse to boot on a half-translated entry.
 *
 * The same startup completeness assert all four notification stacks run, and for the same
 * reason: a missing language is invisible until a customer who reads it hits that exact
 * error, at which point they get English and nobody finds out. Called from `lifecycle.ts`
 * beside the other boot assertions.
 *
 * A bare `Error` — this runs before any request exists and the only correct outcome is that
 * the process does not start.
 */
export function assertBotErrorCopyComplete(): void {
    const gaps: string[] = [];

    const check = (label: string, copy: Copy): void => {
        for (const lang of BOT_COPY_LANGUAGES) {
            if (typeof copy[lang] !== 'string' || copy[lang].trim().length === 0) {
                gaps.push(`${label}:${lang}`);
            }
        }
    };

    for (const [category, copy] of Object.entries(CATEGORY_COPY)) check(`category ${category}`, copy);
    for (const [code, copy] of Object.entries(CODE_COPY)) check(`code ${code}`, copy as Copy);

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] bot error copy is missing translations: ${gaps.join(', ')}`);
    }
}

/** Exported for `test:bot-surface`, which asserts coverage and the no-code-leaks rule. */
export const __BOT_ERROR_COPY = Object.freeze({ CATEGORY_COPY, CODE_COPY });
