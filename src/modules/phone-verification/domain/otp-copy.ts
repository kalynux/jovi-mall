import { Language } from '../../../core/constants/languages';

/**
 * The in-window message body, in all five platform languages.
 *
 * ── Why the copy is here and not in a notification catalog ───────────────────
 *
 * The four catalogs under `modules/notifications/catalog/` are *situation* copy driven by a
 * domain event, with preference gating, an in-app record and a `whatsapp`/`telegram`/`email`
 * fan-out. A verification code is none of those: it is the synchronous reply to a request the
 * person just made, it is never preference-gated, it writes no inbox row, and it must never be
 * retried. Putting it in a catalog would inherit machinery that is all wrong for it — most
 * dangerously the delivery retry, which would re-send a live credential.
 *
 * ⚠ **Complete in all five, and asserted.** The catalogs throw at boot on a missing language,
 * and this file is held to the same bar by `test:phone-verification`: a missing translation
 * here does not throw, it renders `undefined` into a message carrying a security code.
 */

/**
 * ⚠ **The code is NOT wrapped in `*bold*`.**
 *
 * That is deliberate and it is the one styling decision in this file. WhatsApp renders a
 * standalone line of digits with a tap-to-copy affordance on most clients; wrapping it in
 * asterisks defeats that, and a person then selects the code by hand and frequently catches an
 * asterisk with it. A verification code is the one string in the product where *copyability*
 * beats emphasis — which is the opposite of the "bold every parameter" rule that applies to
 * notification templates, and is why it is stated here rather than left to look like an
 * oversight.
 */
const COPY: Record<Language, (code: string, minutes: number) => string> = {
    en: (code, minutes) =>
        `Your Wi-Mall verification code is:\n\n${code}\n\n`
        + `It expires in ${minutes} minutes. If you did not ask to verify a number, ignore this message — nothing will change.`,
    fr: (code, minutes) =>
        `Votre code de vérification Wi-Mall est :\n\n${code}\n\n`
        + `Il expire dans ${minutes} minutes. Si vous n'avez pas demandé à vérifier un numéro, ignorez ce message — rien ne changera.`,
    pt: (code, minutes) =>
        `O seu código de verificação Wi-Mall é:\n\n${code}\n\n`
        + `Expira em ${minutes} minutos. Se não pediu para verificar um número, ignore esta mensagem — nada será alterado.`,
    es: (code, minutes) =>
        `Tu código de verificación de Wi-Mall es:\n\n${code}\n\n`
        + `Caduca en ${minutes} minutos. Si no has solicitado verificar un número, ignora este mensaje — no cambiará nada.`,
    ar: (code, minutes) =>
        `رمز التحقق الخاص بك في Wi-Mall هو:\n\n${code}\n\n`
        + `تنتهي صلاحيته خلال ${minutes} دقيقة. إذا لم تطلب التحقق من رقم، فتجاهل هذه الرسالة — لن يتغير شيء.`,
};

export function otpMessage(code: string, lang: Language, ttlSeconds: number): string {
    const minutes = Math.max(1, Math.round(ttlSeconds / 60));
    const render = COPY[lang] ?? COPY.en;
    return render(code, minutes);
}

/** Exposed for the completeness assertion in `test:phone-verification`. */
export const OTP_COPY_LANGUAGES = Object.keys(COPY) as Language[];

/**
 * The body of the UTILITY **fallback** template, used only when the AUTHENTICATION template
 * cannot be sent.
 *
 * ── Why a second template exists at all ──────────────────────────────────────
 *
 * Meta gates the AUTHENTICATION category behind business verification. Measured 2026-09-14:
 * this WABA is owned by a business whose verification is `rejected`, so
 * `wi_mall_phone_verification` cannot even be CREATED — Meta answers code 10 — while UTILITY
 * templates create normally on the same credential. Without a fallback the out-of-window path
 * is closed on this deployment for a reason no amount of code can fix.
 *
 * ⛔ **META REJECTED IT — `INCORRECT_CATEGORY`, both languages, minutes after creation
 * (2026-09-14). This copy is currently unsendable, and the file is kept because the
 * machinery around it is correct and the answer may change.**
 *
 * Do not "fix" it by rewording. The route is closed by Meta rather than by this text:
 * resubmitting with `allow_category_change: true` — which lets Meta assign whatever category it
 * judges correct instead of refusing — came back `REJECTED` **synchronously**. Meta classifies
 * one-time-password content as AUTHENTICATION and accepts it nowhere else, and AUTHENTICATION
 * is exactly what this WABA may not create. Rewording to read as something other than a
 * verification code would be evading that classifier, not satisfying it, and what is at risk is
 * the WABA carrying all 188 working templates.
 *
 * ✅ **The one real fix is resolving the business verification.** The AUTHENTICATION template
 * then creates, `deliver()` succeeds on its first attempt, and none of this is reached — with
 * no code change, because the order never changed.
 *
 * ── What the copy has to carry that the other one does not ───────────────────
 *
 * An AUTHENTICATION template gets three things from Meta for free: the localised body, the
 * "do not share this code" security line, and the expiry notice. A UTILITY template gets NONE
 * of them, so all three have to be written here — which is why this is a separate map rather
 * than `COPY` with the placeholders swapped in.
 *
 * ⚠ **`{{1}}` is the code and `{{2}}` is the number of MINUTES, in that order**, and the order
 * is the contract: Meta substitutes positionally, so swapping them puts the TTL where the code
 * belongs on every message, with no error anywhere. `test:phone-verification` pins it.
 *
 * ⚠ **Neither placeholder may sit at the start or end of the body.** Meta refuses a template
 * whose first or last element is a variable and counts neither bold markers nor a trailing full
 * stop as content — the rule that killed 38 of the first 190 submissions on this WABA.
 */
const FALLBACK_TEMPLATE_COPY: Record<Language, string> = {
    en:
        '*Wi-Mall verification*\n\n'
        + 'Your verification code is {{1}} and it expires in {{2}} minutes. Do not share it with anyone.\n\n'
        + 'If you did not ask to verify a number, ignore this message and nothing will change.',
    fr:
        '*Vérification Wi-Mall*\n\n'
        + 'Votre code de vérification est {{1}} et il expire dans {{2}} minutes. Ne le partagez avec personne.\n\n'
        + 'Si vous n\'avez pas demandé à vérifier un numéro, ignorez ce message et rien ne changera.',
    pt:
        '*Verificação Wi-Mall*\n\n'
        + 'O seu código de verificação é {{1}} e expira em {{2}} minutos. Não o partilhe com ninguém.\n\n'
        + 'Se não pediu para verificar um número, ignore esta mensagem e nada será alterado.',
    es:
        '*Verificación de Wi-Mall*\n\n'
        + 'Tu código de verificación es {{1}} y caduca en {{2}} minutos. No lo compartas con nadie.\n\n'
        + 'Si no has solicitado verificar un número, ignora este mensaje y no cambiará nada.',
    ar:
        '*التحقق من Wi-Mall*\n\n'
        + 'رمز التحقق الخاص بك هو {{1}} وتنتهي صلاحيته خلال {{2}} دقيقة. لا تشاركه مع أي شخص.\n\n'
        + 'إذا لم تطلب التحقق من رقم، فتجاهل هذه الرسالة ولن يتغير شيء.',
};

/** The approved body for one language, for `scripts/generate-whatsapp-templates.ts`. */
export function otpFallbackTemplateBody(lang: Language): string {
    return FALLBACK_TEMPLATE_COPY[lang] ?? FALLBACK_TEMPLATE_COPY.en;
}

/**
 * The body parameters the fallback send must supply, in Meta's positional order.
 *
 * Built here rather than at the send site so the ORDER lives in the same file as the copy it
 * has to agree with. A caller cannot get it wrong without editing this function.
 */
export function otpFallbackTemplateParams(code: string, ttlSeconds: number): string[] {
    return [code, String(Math.max(1, Math.round(ttlSeconds / 60)))];
}

/** Exposed for the completeness and ordering assertions in `test:phone-verification`. */
export const OTP_FALLBACK_COPY_LANGUAGES = Object.keys(FALLBACK_TEMPLATE_COPY) as Language[];
