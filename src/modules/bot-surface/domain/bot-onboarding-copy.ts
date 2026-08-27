import { MessagingChannel } from '../../channel-connections';
import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';
import { BOT_ONBOARDING_STEPS, BotOnboardingStep, isRequiredStep } from './bot-onboarding';

/**
 * What the bot SAYS when it asks for an onboarding field — a sentence, in the customer's
 * language.
 *
 * ── THIS FILE EXISTS BECAUSE THE FIRST VERSION OF `next` WAS WRONG ───────────
 * `bot-onboarding.ts` originally described the next step as a pure DESCRIPTOR — step,
 * required, skippable, field, kind — on the stated grounds that *"the sentence the customer
 * reads is the automation layer's to write, in the customer's own language"*.
 *
 * **That premise is false and was already known to be false.** The automation layer has no
 * copy table and no translator; what it can do is relay a string. It is the same premise
 * `bot-error-copy.ts` was written to correct for failures — and leaving it standing on the
 * SUCCESS path produced exactly the reported symptom: a Telegram sender is told
 * `next.step: 'phone'` and there is nothing to send them. A response that says what is
 * needed and cannot say it to the person needing it is only half an answer.
 *
 * So the rule is now uniform across this surface: **every response, success or failure,
 * carries a customer-ready string.** Errors carry `error.customerMessage`; prompts carry
 * `onboarding.next.prompt`.
 *
 * ── `requestContact` IS AN EXISTING PLATFORM CONVENTION, NOT A NEW ONE ───────
 * `/login` and `/reset-password` already answer a Telegram first contact with
 * `{ message, requestContact: true }`, and `api-doc/auth/magic-login.md` already tells n8n
 * to attach a `request_contact` keyboard when it sees that marker — so the handler exists on
 * the automation side. Reusing the exact key means the Telegram phone step needs no new n8n
 * branch. Inventing `ui: { keyboard: 'contact' }` here would have been a second spelling of
 * one instruction.
 *
 * It is **present only where it applies and absent — not `false` — everywhere else**, which
 * is the convention `LoginCommandResult.requestContact` documents: a client branches on
 * presence.
 *
 * ── WHAT THE COPY MAY AND MAY NOT DO ────────────────────────────────────────
 * It is written for a chat window: short, second person, no field names, no internal
 * concepts, no error codes.
 *
 * ⚠ **It also does not describe the interface**, and this paragraph used to say the
 * opposite: *"A skippable step SAYS SO in its own sentence — the customer cannot see
 * `skippable: true`, and a question they do not know they may decline is not really
 * optional."* The observation stands; the remedy was wrong, because it made the customer
 * TYPE a magic word in their own language. A skippable step now ships a **Skip button**
 * (see the `PROMPTS.email` note and `bot-action-id.ts`), so the sentence goes back to being
 * a plain question and the interface explains itself.
 *
 * ⚠ It must never name the platform, a shop or a product. This is the one prompt set shared
 * by every conversation on the platform, and a sentence that mentions a specific store is
 * wrong in most of them.
 */

/** One sentence per supported language. */
type Copy = Record<BotCopyLanguage, string>;

/**
 * ⚠ **The phone prompt is CHANNEL-SPECIFIC and the WhatsApp half is nearly unreachable.**
 *
 * On WhatsApp the sender id IS the number, so the step is `provided` before anybody could be
 * asked — the only way to reach that copy is a legacy account whose `users` row carries no
 * `login_phone` at all. It is written honestly for that case (asking them to type it) rather
 * than left to fall back to the Telegram wording, which would tell them to tap a button no
 * WhatsApp client renders.
 */
const PHONE_TELEGRAM: Copy = {
    en: 'First, I need your phone number so I can set up your account. Tap the button below to share it.',
    fr: "D'abord, j'ai besoin de votre numéro de téléphone pour créer votre compte. Appuyez sur le bouton ci-dessous pour le partager.",
    pt: 'Primeiro, preciso do seu número de telefone para criar a sua conta. Toque no botão abaixo para partilhá-lo.',
    es: 'Primero necesito tu número de teléfono para crear tu cuenta. Toca el botón de abajo para compartirlo.',
    ar: 'أولًا، أحتاج إلى رقم هاتفك لإنشاء حسابك. اضغط على الزر أدناه لمشاركته.',
};

const PHONE_TYPED: Copy = {
    en: 'First, what is your phone number? Please send it with the country code, like +237600000000.',
    fr: "D'abord, quel est votre numéro de téléphone ? Envoyez-le avec l'indicatif du pays, par exemple +237600000000.",
    pt: 'Primeiro, qual é o seu número de telefone? Envie-o com o indicativo do país, por exemplo +237600000000.',
    es: 'Primero, ¿cuál es tu número de teléfono? Envíalo con el código del país, por ejemplo +237600000000.',
    ar: 'أولًا، ما هو رقم هاتفك؟ أرسله مع رمز الدولة، مثل ‎+237600000000.',
};

const PROMPTS: Readonly<Record<Exclude<BotOnboardingStep, 'phone'>, Copy>> = Object.freeze({
    name: {
        en: 'What name should I use for you? This is the name that goes on your deliveries.',
        fr: 'Quel nom dois-je utiliser pour vous ? C\'est le nom qui figurera sur vos livraisons.',
        pt: 'Que nome devo usar para si? É o nome que aparece nas suas entregas.',
        es: '¿Qué nombre debo usar para ti? Es el nombre que aparecerá en tus entregas.',
        ar: 'ما الاسم الذي أستخدمه لك؟ هذا هو الاسم الذي سيظهر على طلباتك.',
    },
    /**
     * ⚠ **A skippable step's copy DOES NOT mention skipping, and that REVERSES a rule this
     * file used to state.** It read: *"A skippable step SAYS SO in its own sentence — the
     * customer cannot see `skippable: true`, and a question they do not know they may
     * decline is not really optional."* The premise was right and the remedy was wrong.
     *
     * The old copy asked the customer to TYPE a magic word — *« passer »*, `saltar`,
     * `omitir`, `تخطٍّ`. That put a translation table somewhere on the path back (in the one
     * layer with no copy table), and put a quoted token inside an otherwise ordinary
     * sentence. The refusal is a **button** now (`skipActionId`), so the option is visible
     * without being explained, the label is translated for the human, and what comes back is
     * an untranslated machine token.
     *
     * The corollary, and it is the part to keep: **these sentences must stay QUESTIONS.** A
     * sentence describing the interface — "tap Skip if you would rather not" — re-creates
     * the problem one layer up, and is wrong on any channel that draws the control
     * differently or cannot draw it at all.
     */
    email: {
        en: 'Would you like to add an email address?',
        fr: 'Souhaitez-vous ajouter une adresse e-mail ?',
        pt: 'Quer adicionar um endereço de e-mail?',
        es: '¿Quieres añadir un correo electrónico?',
        ar: 'هل تودّ إضافة بريد إلكتروني؟',
    },
    address: {
        en: 'Last one: where should I deliver to?',
        fr: 'Dernière question : où dois-je livrer ?',
        pt: 'Última pergunta: onde devo entregar?',
        es: 'Última pregunta: ¿dónde te entrego?',
        ar: 'السؤال الأخير: إلى أين أوصل طلبك؟',
    },
});

/** What a caller needs in order to actually ASK for a step. */
export interface BotOnboardingPrompt {
    /** The verbatim text to relay. Never empty. */
    prompt: string;
    /**
     * Attach a Telegram `request_contact` keyboard to this reply.
     *
     * Present only on the Telegram phone step. **Absent, not `false`, everywhere else** —
     * the same convention `LoginCommandResult.requestContact` documents, so a client
     * branches on presence and an older handler that does not know the key is unaffected.
     */
    requestContact?: true;
}

/**
 * The prompt for one step, on one channel, in one language.
 *
 * Falls back to English on a language with no entry, and never to the step name: a customer
 * shown the word `address` has been shown an internal identifier, which is the failure this
 * whole file exists to prevent.
 */
export function onboardingPromptFor(
    step: BotOnboardingStep,
    channel: MessagingChannel,
    language: string | null | undefined,
): BotOnboardingPrompt {
    const lang = toBotCopyLanguage(language);

    if (step === 'phone') {
        // Telegram is the only channel with a verified-contact mechanism, and it is the only
        // channel on which this step is normally pending at all.
        if (channel === 'telegram') {
            return { prompt: PHONE_TELEGRAM[lang] ?? PHONE_TELEGRAM.en, requestContact: true };
        }
        return { prompt: PHONE_TYPED[lang] ?? PHONE_TYPED.en };
    }

    const copy = PROMPTS[step];
    return { prompt: copy[lang] ?? copy.en };
}

/**
 * Refuse to boot on a missing prompt.
 *
 * A step added to `BOT_ONBOARDING_STEPS` with no copy here would produce a `next` the caller
 * cannot voice — the reported symptom, arriving again by a different door. Covering the step
 * list rather than this file's own keys is what makes that impossible: the assert is driven
 * by the checklist, so the checklist is what it fails on.
 *
 * A bare `Error` — this runs before any request exists, beside the other boot assertions.
 */
export function assertBotOnboardingCopyComplete(): void {
    const gaps: string[] = [];

    for (const { step } of BOT_ONBOARDING_STEPS) {
        for (const lang of BOT_COPY_LANGUAGES) {
            for (const channel of ['whatsapp', 'telegram'] as const) {
                const { prompt } = onboardingPromptFor(step, channel, lang);
                if (typeof prompt !== 'string' || prompt.trim().length === 0) {
                    gaps.push(`${step}/${channel}:${lang}`);
                }
            }
        }
    }

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(
            `[BotSurface] onboarding prompt copy is missing: ${gaps.join(', ')}`,
        );
    }
}

/**
 * ⚠ Exported for `test:bot-surface`, which asserts a skippable step's copy does **NOT**
 * mention skipping — the one property of this table a reader cannot check from the types.
 *
 * That assertion is INVERTED from what it used to be, and the inversion is the point: the
 * old copy taught the customer a magic word to type, so the test insisted on finding it.
 * The refusal is a button now, so finding that word again would mean somebody had put the
 * interface back into the prose.
 */
export const __SKIPPABLE_STEPS: readonly BotOnboardingStep[] = Object.freeze(
    BOT_ONBOARDING_STEPS.filter(({ step }) => !isRequiredStep(step)).map(({ step }) => step),
);
