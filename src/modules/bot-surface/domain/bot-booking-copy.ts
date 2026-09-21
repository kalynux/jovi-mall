/**
 * What the CHAT says after a booking screen closes — five languages, no platform words.
 *
 * ── WHY THE CHAT SPEAKS AT ALL ──────────────────────────────────────────────
 * A screen that is about to close is the wrong place for a receipt, and the platform's own
 * booking message is not a substitute for one: it goes to a SINGLE secondary channel chosen in
 * the order Telegram → email → WhatsApp, so a WhatsApp customer with a verified email address
 * receives it by email; and it sits under the "booking updates" preference, so a customer who
 * muted those gets nothing at all. A receipt for something the customer just did in this
 * conversation must arrive in this conversation, and must not be silenceable by a setting about
 * updates.
 *
 * ⚠ **Booked and MOVED are different sentences.** Telling somebody their appointment is "booked"
 * when they moved one reads as a second appointment — the same error the reschedule notification
 * avoids by naming both times.
 *
 * ⚠ **Nothing here computes.** The reference and the time are produced by `booking.core.ts` in
 * the shop's timezone and placed as they arrive; a screen and a chat that format a time
 * separately disagree the first time one of them is changed.
 */
import { Language } from '../../notifications/catalog/notification-i18n';

/**
 * What a control can hold, and the rule that goes with it.
 *
 * ⚠ **A row title built from DATA must DISTINGUISH two rows, and the case to check is French or
 * Arabic — never English.** Three live lists were found on 2026-09-20 rendering two identical
 * rows to a French customer where the English read perfectly distinctly, including a downloads
 * picker where the customer then chose paid content at random. A booking row is built from a
 * service name and a time, both data, and Arabic is the longest of the five languages here.
 *
 * So the TIME goes in the row title rather than the description: two appointments for the same
 * service differ by nothing else, and a title truncated before the time makes them identical.
 */
export const BOOKING_TEXT_CAPS = Object.freeze({
    /** WhatsApp list row title. */
    rowTitle: 24,
    /** WhatsApp list row description. */
    rowDescription: 72,
    /** Reply/quick-reply button title. */
    button: 20,
    /** Flow option title. */
    option: 30,
});

/**
 * Cut to fit, keeping the END when the end is what distinguishes it.
 *
 * ⚠ Truncating a booking row from the right removes the time — the only thing telling two
 * appointments apart. So the SERVICE is shortened and the time kept whole.
 */
export function fitBookingRowTitle(service: string, when: string): string {
    const cap = BOOKING_TEXT_CAPS.rowTitle;
    const tail = ` · ${when}`;
    if (tail.length >= cap) return when.slice(0, cap);
    const room = cap - tail.length;
    const head = service.length > room ? `${service.slice(0, Math.max(1, room - 1))}…` : service;
    return `${head}${tail}`;
}

export interface BookingChatReceipt {
    /** `BKG-2026-000123`, or the id when a booking predates the reference. */
    reference: string;
    /** "Tue 22 Sep 14:00", already localised and already in the shop's timezone. */
    when: string;
    /** The service's name as the catalogue holds it. */
    service: string;
}

type Copy = Record<Language, (r: BookingChatReceipt) => string>;

const BOOKED: Copy = {
    en: (r) => `Booked: ${r.service}, ${r.when}. Your reference is ${r.reference}.`,
    fr: (r) => `Réservé : ${r.service}, ${r.when}. Votre référence est ${r.reference}.`,
    pt: (r) => `Reservado: ${r.service}, ${r.when}. A sua referência é ${r.reference}.`,
    es: (r) => `Reservado: ${r.service}, ${r.when}. Tu referencia es ${r.reference}.`,
    ar: (r) => `تم الحجز: ${r.service}، ${r.when}. رقمك المرجعي هو ${r.reference}.`,
};

const MOVED: Copy = {
    en: (r) => `Moved: ${r.service} is now ${r.when}. Your reference is still ${r.reference}.`,
    fr: (r) => `Déplacé : ${r.service} est maintenant le ${r.when}. Votre référence reste ${r.reference}.`,
    pt: (r) => `Alterado: ${r.service} passou para ${r.when}. A sua referência continua ${r.reference}.`,
    es: (r) => `Movido: ${r.service} ahora es el ${r.when}. Tu referencia sigue siendo ${r.reference}.`,
    ar: (r) => `تم النقل: ${r.service} أصبح ${r.when}. رقمك المرجعي لا يزال ${r.reference}.`,
};

/**
 * ⚠ **A `pending` booking is NOT confirmed, and saying so is the whole point of this line.**
 * A `manual`-mode service is an appointment the shop has not accepted yet; telling a customer it
 * is booked, and then that it was declined, is worse than telling them it is requested. This is
 * the same distinction `toBotBookingDto` refuses to relay as a payment state.
 */
const AWAITING_SHOP: Record<Language, string> = {
    en: 'The shop still has to accept it — I will tell you as soon as they do.',
    fr: "Le salon doit encore l'accepter — je vous préviens dès que c'est fait.",
    pt: 'A loja ainda tem de aceitar — aviso assim que o fizer.',
    es: 'La tienda todavía debe aceptarla — te aviso en cuanto lo haga.',
    ar: 'لا يزال المتجر بحاجة إلى قبوله — سأخبرك بمجرد أن يفعل.',
};

const pick = <T>(table: Record<Language, T>, language: string | null | undefined): T =>
    table[(language ?? 'en') as Language] ?? table.en;

/**
 * Every word the two booking SCREENS show.
 *
 * ⚠ **Served with the data, not held by the page**, exactly as the support form does it. A page
 * that holds English is a page that must be edited in two places when a word changes, and — the
 * binding reason — the WhatsApp Flow renders the same screens from the same read, so one set of
 * words is what keeps the two channels saying the same thing.
 *
 * ⚠ **`timesAvailable` is a FUNCTION** because a count sits inside the sentence in every language
 * and a page cannot build one. It is a description line under a day, never a plural rule the
 * client has to know.
 */
export interface BookingScreenCopy {
    listTitle: string;
    listEmpty: string;
    pickTitle: string;
    pickDay: string;
    pickTime: string;
    confirm: string;
    back: string;
    movingNotice: string;
    changeTime: string;
    timesAvailable: (count: number) => string;
    /** `bp`, the price of the appointment. */
    payTitle: string;
    /** `bp`, what a longer job came to above the quote. A different sentence, not a variant. */
    payBalanceTitle: string;
    /** Above the optional number field: what happens if it is left empty. */
    payNumberHint: string;
    payButton: string;
    /**
     * ⚠ **What the screen says after the charge is STARTED — and it never says "paid".**
     * A mobile-money charge is approved on a handset, minutes later, on a device this screen
     * cannot see. The outcome reaches the customer through the payment path, which speaks only
     * where the gateway actually gave a verdict — so a screen claiming success or failure here
     * would be reaching a verdict the platform deliberately has not.
     */
    paySent: string;
}

const SCREEN: Record<Language, BookingScreenCopy> = {
    en: {
        listTitle: 'Your appointments',
        listEmpty: 'You have no appointments yet.',
        pickTitle: 'Pick a time',
        pickDay: 'Choose a day',
        pickTime: 'Choose a time',
        confirm: 'Confirm',
        back: 'Back',
        movingNotice: 'Moving your appointment',
        changeTime: 'Change time',
        timesAvailable: (n) => (n === 1 ? '1 time free' : `${n} times free`),
        payTitle: 'Pay for your appointment',
        payBalanceTitle: 'Pay the balance',
        payNumberHint: 'Leave empty to use the number on your account.',
        payButton: 'Pay now',
        paySent: 'I\'ve sent the request to your phone. Approve it there and I\'ll tell you in the chat.',
    },
    fr: {
        listTitle: 'Vos rendez-vous',
        listEmpty: "Vous n'avez pas encore de rendez-vous.",
        pickTitle: 'Choisissez un horaire',
        pickDay: 'Choisissez un jour',
        pickTime: 'Choisissez une heure',
        confirm: 'Confirmer',
        back: 'Retour',
        movingNotice: 'Déplacement de votre rendez-vous',
        changeTime: "Changer l'horaire",
        timesAvailable: (n) => (n === 1 ? '1 horaire libre' : `${n} horaires libres`),
        payTitle: 'Payer votre rendez-vous',
        payBalanceTitle: 'Payer le solde',
        payNumberHint: 'Laissez vide pour utiliser le numéro de votre compte.',
        payButton: 'Payer maintenant',
        paySent: 'J\'ai envoyé la demande sur votre téléphone. Validez-la et je vous préviens dans la conversation.',
    },
    pt: {
        listTitle: 'As suas marcações',
        listEmpty: 'Ainda não tem marcações.',
        pickTitle: 'Escolha um horário',
        pickDay: 'Escolha um dia',
        pickTime: 'Escolha uma hora',
        confirm: 'Confirmar',
        back: 'Voltar',
        movingNotice: 'A alterar a sua marcação',
        changeTime: 'Alterar horário',
        timesAvailable: (n) => (n === 1 ? '1 horário livre' : `${n} horários livres`),
        payTitle: 'Pagar a sua marcação',
        payBalanceTitle: 'Pagar o saldo',
        payNumberHint: 'Deixe vazio para usar o número da sua conta.',
        payButton: 'Pagar agora',
        paySent: 'Enviei o pedido para o seu telemóvel. Aprove-o e aviso-o na conversa.',
    },
    es: {
        listTitle: 'Tus citas',
        listEmpty: 'Todavía no tienes citas.',
        pickTitle: 'Elige un horario',
        pickDay: 'Elige un día',
        pickTime: 'Elige una hora',
        confirm: 'Confirmar',
        back: 'Atrás',
        movingNotice: 'Moviendo tu cita',
        changeTime: 'Cambiar horario',
        timesAvailable: (n) => (n === 1 ? '1 horario libre' : `${n} horarios libres`),
        payTitle: 'Paga tu cita',
        payBalanceTitle: 'Paga el saldo',
        payNumberHint: 'Déjalo vacío para usar el número de tu cuenta.',
        payButton: 'Pagar ahora',
        paySent: 'He enviado la solicitud a tu teléfono. Apruébala y te aviso en el chat.',
    },
    ar: {
        listTitle: 'مواعيدك',
        listEmpty: 'ليس لديك مواعيد بعد.',
        pickTitle: 'اختر وقتًا',
        pickDay: 'اختر يومًا',
        pickTime: 'اختر الساعة',
        confirm: 'تأكيد',
        back: 'رجوع',
        movingNotice: 'جارٍ نقل موعدك',
        changeTime: 'تغيير الموعد',
        timesAvailable: (n) => (n === 1 ? 'وقت واحد متاح' : `${n} أوقات متاحة`),
        payTitle: 'ادفع لموعدك',
        payBalanceTitle: 'ادفع الرصيد',
        payNumberHint: 'اتركه فارغًا لاستخدام الرقم المسجل في حسابك.',
        payButton: 'ادفع الآن',
        paySent: 'أرسلت الطلب إلى هاتفك. وافق عليه وسأخبرك في المحادثة.',
    },
};

/** The screen's words, with the counts already placed — a page never computes a sentence. */
export function bookingScreenCopy(language: string | null | undefined): Omit<BookingScreenCopy, 'timesAvailable'> {
    const { timesAvailable, ...words } = pick(SCREEN, language);
    void timesAvailable;
    return words;
}

/** The description line under one day: how many times are free. */
export function bookingTimesAvailable(count: number, language: string | null | undefined): string {
    return pick(SCREEN, language).timesAvailable(count);
}

/**
 * The description line under one TIME on a class: how many seats are left.
 *
 * ⚠ **Only ever called for a capacity service.** On a one-person appointment `spotsRemaining` is
 * `null`, which means "not a class" and emphatically not "none left" — wording that as a number
 * would tell every customer booking a haircut that no seats remain.
 *
 * ⚠ **A count inside the sentence, like its sibling**, because a form can place a string and
 * cannot build one, and because "1 spot left" is not "1 spots left" in any of the five.
 */
export function bookingSpotsLeft(count: number, language: string | null | undefined): string {
    return pick(SPOTS_LEFT, language)(count);
}

const SPOTS_LEFT: Record<Language, (count: number) => string> = {
    en: (n) => (n === 1 ? '1 spot left' : `${n} spots left`),
    fr: (n) => (n === 1 ? '1 place restante' : `${n} places restantes`),
    pt: (n) => (n === 1 ? '1 lugar restante' : `${n} lugares restantes`),
    es: (n) => (n === 1 ? '1 plaza libre' : `${n} plazas libres`),
    ar: (n) => (n === 1 ? 'مكان واحد متبقٍ' : `${n} أماكن متبقية`),
};

/**
 * The CONTENT-FREE acknowledgement, for a channel that cannot prove whose booking it is.
 *
 * ⚠ **This is not the same sentence with the details left out — it is its own sentence, and the
 * distinction is load-bearing.** After a WhatsApp form completes, the handle is already spent and
 * the completion arrives as a fresh inbound whose payload is caller-supplied. A reference or a
 * time in that sentence would let a forged completion have the bot state somebody else's
 * appointment details. So nothing about the booking travels: the chat says it has the booking and
 * offers a **My bookings** button, which opens a screen that resolves the sender's OWN session
 * server-side. A tap code is not content.
 *
 * ⚠ **It must be true whether or not the shop has accepted**, which is why it says "got" rather
 * than "confirmed": a `manual`-mode service comes back REQUESTED, and this path cannot tell.
 *
 * ⚠ **Feeding the full receipt empty strings is NOT this**, and that mistake was made once in a
 * message already: it renders "Booked: , . Your reference is ." — a broken sentence rather than a
 * short one.
 */
export function bookingChatAcknowledgement(
    outcome: { moved: boolean },
    language: string | null | undefined,
): string {
    return pick(outcome.moved ? MOVED_ACK : BOOKED_ACK, language);
}

const BOOKED_ACK: Record<Language, string> = {
    en: "I've got your booking.",
    fr: 'J\'ai bien reçu votre réservation.',
    pt: 'Recebi a sua reserva.',
    es: 'He recibido tu reserva.',
    ar: 'استلمت حجزك.',
};

const MOVED_ACK: Record<Language, string> = {
    en: "I've moved your appointment.",
    fr: 'J\'ai déplacé votre rendez-vous.',
    pt: 'Alterei a sua marcação.',
    es: 'He movido tu cita.',
    ar: 'قمت بنقل موعدك.',
};

/**
 * The FULL receipt, for a channel where the server knows whose booking it is.
 *
 * Telegram only today: the push is made by this service from data it holds, with nothing
 * forgeable in the path. See `bookingChatAcknowledgement` for the other half.
 */
export function bookingChatReceipt(
    outcome: { moved: boolean; awaitingShop: boolean },
    receipt: BookingChatReceipt,
    language: string | null | undefined,
): string {
    const headline = pick(outcome.moved ? MOVED : BOOKED, language)(receipt);
    return outcome.awaitingShop ? `${headline} ${pick(AWAITING_SHOP, language)}` : headline;
}
