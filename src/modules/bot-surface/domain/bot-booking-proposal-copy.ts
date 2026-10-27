import { DEFAULT_LANGUAGE, Language, SUPPORTED_LANGUAGES } from '../../notifications/catalog/notification-i18n';

/**
 * The chat's answer when a customer taps **Accept new time** / **Keep my time** on the vendor's
 * proposal of a new time (owner decision D-9, 2026-10-26).
 *
 * Kept apart from `bot-booking-copy.ts` because it belongs to one decision with its own buttons
 * (`yes:bkprop:` / `no:bkprop:`), and that file is shared by several streams.
 *
 * ⚠ **Every sentence says what is TRUE NOW**, because a tap can arrive long after the message it
 * sits under: the proposal may have been answered already, withdrawn, or have lapsed when the
 * original time passed. `gone` covers all three without guessing which one it was.
 */
export interface ProposalAnswerCopy {
    /** Accepted — the appointment moved. `{when}` is the new time in the shop's timezone. */
    accepted: (when: string) => string;
    /** Declined — the original time stays, and cancelling now refunds in full. */
    declined: (when: string) => string;
    /** Nothing open to answer: answered, withdrawn or lapsed. */
    gone: string;
}

const COPY: Record<Language, ProposalAnswerCopy> = {
    en: {
        accepted: (when) => `Done — your appointment is now ${when}.`,
        declined: (when) => `Got it — your appointment stays ${when}. If that no longer works for you, you can cancel it with a full refund.`,
        gone: 'That new time is no longer waiting for an answer — your appointment is as shown in your bookings.',
    },
    fr: {
        accepted: (when) => `C'est fait — votre rendez-vous est maintenant le ${when}.`,
        declined: (when) => `C'est noté — votre rendez-vous reste le ${when}. S'il ne vous convient plus, vous pouvez l'annuler avec un remboursement intégral.`,
        gone: 'Ce nouvel horaire n\'attend plus de réponse — votre rendez-vous est celui affiché dans vos réservations.',
    },
    pt: {
        accepted: (when) => `Feito — a sua marcação passa a ser ${when}.`,
        declined: (when) => `Entendido — a sua marcação mantém-se em ${when}. Se já não lhe der jeito, pode cancelá-la com reembolso total.`,
        gone: 'Essa nova hora já não aguarda resposta — a sua marcação é a que aparece nas suas reservas.',
    },
    es: {
        accepted: (when) => `Listo — tu cita ahora es el ${when}.`,
        declined: (when) => `Entendido — tu cita sigue el ${when}. Si ya no te viene bien, puedes cancelarla con reembolso completo.`,
        gone: 'Esa nueva hora ya no espera respuesta — tu cita es la que aparece en tus reservas.',
    },
    ar: {
        accepted: (when) => `تم — موعدك الآن ${when}.`,
        declined: (when) => `حسنًا — يبقى موعدك ${when}. إذا لم يعد يناسبك، يمكنك إلغاؤه مع استرداد كامل.`,
        gone: 'لم يعد هذا الموعد الجديد بانتظار رد — موعدك هو المعروض في حجوزاتك.',
    },
};

function languageOf(language: string | null | undefined): Language {
    const lang = (language ?? '').slice(0, 2) as Language;
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang) ? lang : DEFAULT_LANGUAGE;
}

export function proposalAnswerCopy(language: string | null | undefined): ProposalAnswerCopy {
    return COPY[languageOf(language)];
}

/**
 * "Tue 3 Nov, 09:00" in the customer's language, on the SHOP's clock — the same wall clock the
 * shop booked against. An unknown zone falls back to the platform default rather than failing the
 * answer the customer is waiting for.
 */
export function proposalMoment(at: Date, timezone: string | null | undefined, language: string | null | undefined): string {
    const options: Intl.DateTimeFormatOptions = {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    };
    try {
        return new Intl.DateTimeFormat(languageOf(language), { ...options, timeZone: timezone || 'Africa/Douala' }).format(at);
    } catch {
        return new Intl.DateTimeFormat(languageOf(language), { ...options, timeZone: 'Africa/Douala' }).format(at);
    }
}
