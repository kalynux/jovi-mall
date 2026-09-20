import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';
import { botOrderStatusUnavailable } from './bot-order-status-copy';
import type { TicketStatus, TicketType } from '../../tickets/types/ticket.types';

/**
 * ⭐ **HOW A SUPPORT REQUEST IS WORDED TO A CUSTOMER — the one table, for the chat AND the form.**
 *
 * Built the way `bot-order-status-copy.ts` is built, for the reason that file records: two surfaces
 * wording one state from two tables disagreed in four of nine statuses within a day of each other.
 * The chat card, the request list and the `tf` form screen all read this file.
 *
 * ── ⚠ NINE INTERNAL STATUSES BECOME FIVE CUSTOMER LABELS, AND THAT IS THE POINT ─
 * `waiting_on_admin`, `waiting_on_vendor`, `waiting_on_agency` and `waiting_on_agent` all read
 * **"In progress"**. Which desk is holding a request is the platform's internal business — telling a
 * customer their complaint is "waiting on the agency" invites them to chase the agency, about a
 * conversation they cannot see, and it discloses how the platform is organised. This is the same rule
 * `handing_over` follows on the order side: an internal value may choose the words; it may never BE
 * the words.
 *
 * `waiting_on_customer` is the one waiting state a customer must see, because it is the only one they
 * can act on — and it is why the Reply button reads "Reply here" there.
 *
 * ── THE TYPE SYSTEM DOES THE COMPLETENESS CHECKING ──────────────────────────
 * Every table is a total `Record` over a closed union, so a missing language or status is a compile
 * error. `assertTicketCopyComplete()` checks only what `tsc` cannot see: a string too long for the
 * control it lands in. An unknown status falls back to the ORDER table's neutral sentence rather than
 * to a raw token — one platform, one way of saying "we cannot tell you right now".
 *
 * ── ⚠ NO RUNTIME IMPORTS BEYOND THE COPY LANGUAGES ──────────────────────────
 * The ticket types are `import type`, erased at compile time, so any suite can import this file under
 * bare `ts-node`. Anything that reaches `tickets/` at runtime does work at import.
 */

type Copy = Record<BotCopyLanguage, string>;

function pick(copy: Copy, language: string | null | undefined): string {
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Status: nine internal states, five customer labels
// ─────────────────────────────────────────────────────────────────────────────

export type BotTicketState = 'received' | 'in_progress' | 'waiting_on_you' | 'resolved' | 'closed';

/**
 * ⚠ **A total map, so a tenth status is a compile error rather than a silent "unavailable".**
 * Written as the template-literal form of the enum so this file needs no runtime import of it.
 */
export const TICKET_STATE_OF: Readonly<Record<`${TicketStatus}`, BotTicketState>> = Object.freeze({
    open: 'received',
    in_progress: 'in_progress',
    waiting_on_admin: 'in_progress',
    waiting_on_vendor: 'in_progress',
    waiting_on_agency: 'in_progress',
    waiting_on_agent: 'in_progress',
    waiting_on_customer: 'waiting_on_you',
    resolved: 'resolved',
    closed: 'closed',
});

const TICKET_STATE_COPY: Readonly<Record<BotTicketState, Copy>> = Object.freeze({
    received: {
        en: 'Received',
        fr: 'Reçue',
        pt: 'Recebido',
        es: 'Recibida',
        ar: 'تم الاستلام',
    },
    in_progress: {
        en: 'In progress',
        fr: 'En cours',
        pt: 'Em curso',
        es: 'En curso',
        ar: 'قيد المعالجة',
    },
    waiting_on_you: {
        en: 'Waiting for your reply',
        fr: 'En attente de votre réponse',
        pt: 'À espera da sua resposta',
        es: 'Esperando tu respuesta',
        ar: 'بانتظار ردّك',
    },
    resolved: {
        en: 'Resolved',
        fr: 'Résolue',
        pt: 'Resolvido',
        es: 'Resuelta',
        ar: 'تم الحل',
    },
    closed: {
        en: 'Closed',
        fr: 'Fermée',
        pt: 'Fechado',
        es: 'Cerrada',
        ar: 'مغلق',
    },
});

/** The customer-facing state of a request, or the neutral sentence for a status no union knows. */
export function botTicketStateLabel(status: string | null | undefined, language: string | null): string {
    const state = TICKET_STATE_OF[status as `${TicketStatus}`];
    return state ? pick(TICKET_STATE_COPY[state], language) : botOrderStatusUnavailable(language);
}

/** Whether this request is waiting on the customer — the one state that changes a button's word. */
export function ticketAwaitsCustomer(status: string | null | undefined): boolean {
    return TICKET_STATE_OF[status as `${TicketStatus}`] === 'waiting_on_you';
}

/**
 * Whether a request can still be written to.
 *
 * ⚠ **Only `closed` refuses, and it is the SERVICE's rule reproduced, not invented here.**
 * `TicketNoteService.createNote` answers `409 TICKET_CLOSED` on a closed request and accepts a
 * resolved one — so Reply, Attach photo and Close are drawn for everything else. Drawing a button the
 * service will refuse is how a card teaches a customer to stop reading it.
 */
export function ticketAcceptsWriting(status: string | null | undefined): boolean {
    return TICKET_STATE_OF[status as `${TicketStatus}`] !== 'closed';
}

// ─────────────────────────────────────────────────────────────────────────────
//  What a customer's request may be about — eight choices, not forty-three
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **`TicketType` has 43 members and this offers EIGHT.** The rest describe a vendor's payout, an
 * integration, a compliance request — things a customer cannot have. A form that listed all of them
 * would make the common case (an order went wrong) something to hunt for, and a mis-picked type sends
 * a request to the wrong desk. The eight map onto real `TicketType` values, so nothing downstream
 * learns a new vocabulary.
 */
/**
 * A WhatsApp Flow option title, capped by Meta at 30 characters.
 *
 * ⚠ **Not ours to raise.** It is the `RadioButtonsGroup` limit the forms stream builds against
 * (2026-09-20), and it binds the subject labels below because the same eight choices are drawn as a
 * Flow on WhatsApp and as radio rows on the Telegram page. The page would show a longer label
 * happily, which is exactly why this is asserted rather than trusted.
 */
export const FLOW_OPTION_TITLE_MAX = 30;

export type BotTicketSubjectKey =
    | 'order'
    | 'delivery'
    | 'payment'
    | 'refund'
    | 'product'
    | 'booking'
    | 'account'
    | 'other';

export const BOT_TICKET_TYPE_OF: Readonly<Record<BotTicketSubjectKey, `${TicketType}`>> = Object.freeze({
    order: 'ORDER_ISSUE',
    delivery: 'SHIPPING_ISSUE',
    payment: 'PAYMENT_ISSUE',
    refund: 'ORDER_REFUND',
    product: 'PRODUCT_ISSUE',
    booking: 'BOOKING_ISSUE',
    account: 'ACCOUNT_ACCESS',
    other: 'GENERAL_SUPPORT',
});

/**
 * ⚠ **The three delivery topics refine the TYPE, so support reads what the customer asked for.**
 * A failed-delivery card's "Ask to redeliver" and "Address is wrong" are already distinct asks; losing
 * them into one `SHIPPING_ISSUE` would throw away the only structured thing the platform knows about
 * the request before anybody reads it.
 */
export const BOT_TICKET_TYPE_OF_TOPIC: Readonly<Record<'rd' | 'ad' | 'hp', `${TicketType}`>> =
    Object.freeze({
        rd: 'DELIVERY_DELAY',
        ad: 'ADDRESS_CHANGE',
        hp: 'SHIPPING_ISSUE',
    });

const SUBJECT_COPY: Readonly<Record<BotTicketSubjectKey, Copy>> = Object.freeze({
    order: {
        en: 'A problem with an order',
        fr: 'Un problème avec une commande',
        pt: 'Um problema com uma encomenda',
        es: 'Un problema con un pedido',
        ar: 'مشكلة في طلب',
    },
    delivery: {
        en: 'Delivery',
        fr: 'Livraison',
        pt: 'Entrega',
        es: 'Entrega',
        ar: 'التوصيل',
    },
    payment: {
        en: 'Payment',
        fr: 'Paiement',
        pt: 'Pagamento',
        es: 'Pago',
        ar: 'الدفع',
    },
    refund: {
        en: 'Refund',
        fr: 'Remboursement',
        pt: 'Reembolso',
        es: 'Reembolso',
        ar: 'استرداد المبلغ',
    },
    product: {
        en: 'A question about a product',
        fr: 'Une question sur un produit',
        pt: 'Uma dúvida sobre um produto',
        es: 'Una duda sobre un producto',
        ar: 'سؤال عن منتج',
    },
    booking: {
        en: 'A booking',
        fr: 'Une réservation',
        pt: 'Uma reserva',
        es: 'Una reserva',
        ar: 'حجز',
    },
    account: {
        en: 'My account',
        fr: 'Mon compte',
        pt: 'A minha conta',
        es: 'Mi cuenta',
        ar: 'حسابي',
    },
    other: {
        en: 'Something else',
        fr: 'Autre chose',
        pt: 'Outra coisa',
        es: 'Otra cosa',
        ar: 'شيء آخر',
    },
});

/** The eight choices, worded, in the order a form shows them. */
export function botTicketSubjectChoices(
    language: string | null,
): ReadonlyArray<{ key: BotTicketSubjectKey; label: string }> {
    return (Object.keys(SUBJECT_COPY) as BotTicketSubjectKey[]).map((key) => ({
        key,
        label: pick(SUBJECT_COPY[key], language),
    }));
}

export function botTicketSubjectLabel(key: BotTicketSubjectKey, language: string | null): string {
    return pick(SUBJECT_COPY[key], language);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The chat's turn strings
// ─────────────────────────────────────────────────────────────────────────────

const WHICH_TICKET: Copy = {
    en: 'Which request?',
    fr: 'Quelle demande ?',
    pt: 'Que pedido?',
    es: '¿Qué solicitud?',
    ar: 'أي طلب؟',
};

const WHICH_TICKET_FOR_FILE: Copy = {
    en: 'Which request is this file for?',
    fr: 'Pour quelle demande est ce fichier ?',
    pt: 'Para que pedido é este ficheiro?',
    es: '¿Para qué solicitud es este archivo?',
    ar: 'لأي طلب هذا الملف؟',
};

const NEW_REQUEST_ROW: Copy = {
    en: 'New request',
    fr: 'Nouvelle demande',
    pt: 'Novo pedido',
    es: 'Nueva solicitud',
    ar: 'طلب جديد',
};

const NEW_REQUEST_WITH_FILE: Copy = {
    en: 'Start a new request with this file',
    fr: 'Ouvrir une nouvelle demande avec ce fichier',
    pt: 'Abrir um novo pedido com este ficheiro',
    es: 'Abrir una nueva solicitud con este archivo',
    ar: 'ابدأ طلبًا جديدًا بهذا الملف',
};

const REPLY_BUTTON: Copy = {
    en: 'Reply',
    fr: 'Répondre',
    pt: 'Responder',
    es: 'Responder',
    ar: 'رد',
};

/** Shown instead of Reply when the request is waiting on the customer — the actionable state. */
const REPLY_HERE_BUTTON: Copy = {
    en: 'Reply here',
    fr: 'Répondre ici',
    pt: 'Responder aqui',
    es: 'Responder aquí',
    ar: 'رد هنا',
};

const ATTACH_PHOTO_BUTTON: Copy = {
    en: 'Attach photo',
    fr: 'Joindre une photo',
    pt: 'Anexar foto',
    es: 'Adjuntar foto',
    ar: 'إرفاق صورة',
};

const CLOSE_TICKET_BUTTON: Copy = {
    en: 'Close request',
    fr: 'Clore la demande',
    pt: 'Fechar pedido',
    es: 'Cerrar solicitud',
    ar: 'إغلاق الطلب',
};

/**
 * ⚠ **It says what closing COSTS the customer, because only support can undo it.**
 * `reopenTicket` refuses anyone but an administrator, so from where the customer sits this is
 * one-way — which is exactly why the tap carries a signed confirmation.
 */
const CLOSE_TICKET_PROMPT: Copy = {
    en: 'Close this request? Support can reopen it, but you will not be able to write in it any more.',
    fr: 'Fermer cette demande ? Le support pourra la rouvrir, mais vous ne pourrez plus y écrire.',
    pt: 'Fechar este pedido? O apoio pode reabri-lo, mas deixará de poder escrever nele.',
    es: '¿Cerrar esta solicitud? El soporte puede reabrirla, pero ya no podrás escribir en ella.',
    ar: 'هل تريد إغلاق هذا الطلب؟ يمكن للدعم إعادة فتحه، لكن لن تتمكن من الكتابة فيه بعد الآن.',
};

const TICKET_CLOSED: Copy = {
    en: 'Done — I have closed this request.',
    fr: "C'est fait — j'ai fermé cette demande.",
    pt: 'Feito — fechei este pedido.',
    es: 'Hecho — he cerrado esta solicitud.',
    ar: 'تم — أغلقت هذا الطلب.',
};

const SEND_PHOTO_PROMPT: Copy = {
    en: 'Send the photo here in this chat, and I will ask which request it belongs to.',
    fr: "Envoyez la photo ici, dans cette discussion, et je vous demanderai à quelle demande la joindre.",
    pt: 'Envie a foto aqui, nesta conversa, e eu pergunto a que pedido pertence.',
    es: 'Envía la foto aquí, en este chat, y te preguntaré a qué solicitud pertenece.',
    ar: 'أرسل الصورة هنا في هذه المحادثة، وسأسألك إلى أي طلب تنتمي.',
};

const FILE_ATTACHED: Copy = {
    en: 'Added to your request.',
    fr: 'Ajouté à votre demande.',
    pt: 'Adicionado ao seu pedido.',
    es: 'Añadido a tu solicitud.',
    ar: 'تمت الإضافة إلى طلبك.',
};

const NO_REPLIES_YET: Copy = {
    en: 'No replies yet.',
    fr: 'Pas encore de réponse.',
    pt: 'Ainda sem respostas.',
    es: 'Aún no hay respuestas.',
    ar: 'لا توجد ردود بعد.',
};

/** Who wrote a reply, as the card labels it. Never a staff member's name. */
const AUTHOR_YOU: Copy = {
    en: 'You',
    fr: 'Vous',
    pt: 'Você',
    es: 'Tú',
    ar: 'أنت',
};

const AUTHOR_SUPPORT: Copy = {
    en: 'Support',
    fr: 'Support',
    pt: 'Apoio',
    es: 'Soporte',
    ar: 'الدعم',
};

const NO_TICKETS: Copy = {
    en: 'You have no support requests yet.',
    fr: "Vous n'avez encore aucune demande d'assistance.",
    pt: 'Ainda não tem pedidos de apoio.',
    es: 'Todavía no tienes solicitudes de soporte.',
    ar: 'لا توجد لديك طلبات دعم بعد.',
};

/**
 * The turn strings, each with the cap it must satisfy. `null` means a message body rather than a
 * control — the convention `bot-chrome-copy.ts` and the order table both use.
 */
const TICKET_COPY = Object.freeze({
    whichTicket: { copy: WHICH_TICKET, cap: null },
    whichTicketForFile: { copy: WHICH_TICKET_FOR_FILE, cap: null },
    // A WhatsApp list row title.
    newRequestRow: { copy: NEW_REQUEST_ROW, cap: 24 },
    // A WhatsApp list row description.
    newRequestWithFile: { copy: NEW_REQUEST_WITH_FILE, cap: 72 },
    replyButton: { copy: REPLY_BUTTON, cap: 20 },
    replyHereButton: { copy: REPLY_HERE_BUTTON, cap: 20 },
    attachPhotoButton: { copy: ATTACH_PHOTO_BUTTON, cap: 20 },
    closeTicketButton: { copy: CLOSE_TICKET_BUTTON, cap: 20 },
    closeTicketPrompt: { copy: CLOSE_TICKET_PROMPT, cap: null },
    ticketClosed: { copy: TICKET_CLOSED, cap: null },
    sendPhotoPrompt: { copy: SEND_PHOTO_PROMPT, cap: null },
    fileAttached: { copy: FILE_ATTACHED, cap: null },
    noRepliesYet: { copy: NO_REPLIES_YET, cap: null },
    // Prefixes a reply line inside a card body; short so the reply itself has the room.
    authorYou: { copy: AUTHOR_YOU, cap: 18 },
    authorSupport: { copy: AUTHOR_SUPPORT, cap: 18 },
    noTickets: { copy: NO_TICKETS, cap: null },
} as const);

export type BotTicketCopyKey = keyof typeof TICKET_COPY;

export function botTicketCopy(key: BotTicketCopyKey, language: string | null | undefined): string {
    return pick(TICKET_COPY[key].copy, language);
}

/** Reply or Reply here, decided by the one status a customer can act on. */
export function botTicketReplyButton(status: string | null | undefined, language: string | null): string {
    return botTicketCopy(ticketAwaitsCustomer(status) ? 'replyHereButton' : 'replyButton', language);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The form screen's own words — served WITH its data, not from the shared /copy table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **The form's labels travel with the form, and that is deliberate.** The shared
 * `/s/:kind/:handle/copy` table carries the chrome every screen needs (loading, expired, try again)
 * and is the switchboard's file; these strings are the stream's own vocabulary, and they are also
 * exactly what backend-31's WhatsApp version needs in the same shape. One reading, one set of words,
 * two renderings — a second copy on the Flow side is a copy that drifts.
 */
const FORM_COPY = Object.freeze({
    title: {
        en: 'Contact support',
        fr: 'Contacter le support',
        pt: 'Contactar o apoio',
        es: 'Contactar con soporte',
        ar: 'التواصل مع الدعم',
    },
    aboutLabel: {
        en: 'About',
        fr: 'Concerne',
        pt: 'Sobre',
        es: 'Sobre',
        ar: 'بخصوص',
    },
    aboutNothing: {
        en: 'A general question',
        fr: 'Une question générale',
        pt: 'Uma questão geral',
        es: 'Una pregunta general',
        ar: 'سؤال عام',
    },
    directContactsLabel: {
        en: 'Or contact them directly',
        fr: 'Ou contactez-les directement',
        pt: 'Ou contacte-os diretamente',
        es: 'O contáctalos directamente',
        ar: 'أو تواصل معهم مباشرة',
    },
    shopLabel: {
        en: 'The shop',
        fr: 'La boutique',
        pt: 'A loja',
        es: 'La tienda',
        ar: 'المتجر',
    },
    carrierLabel: {
        en: 'The delivery company',
        fr: 'Le transporteur',
        pt: 'A transportadora',
        es: 'La empresa de reparto',
        ar: 'شركة التوصيل',
    },
    whatsappLabel: {
        en: 'WhatsApp',
        fr: 'WhatsApp',
        pt: 'WhatsApp',
        es: 'WhatsApp',
        ar: 'واتساب',
    },
    callLabel: {
        en: 'Call',
        fr: 'Appeler',
        pt: 'Ligar',
        es: 'Llamar',
        ar: 'اتصال',
    },
    emailLabel: {
        en: 'Email',
        fr: 'E-mail',
        pt: 'E-mail',
        es: 'Correo',
        ar: 'البريد الإلكتروني',
    },
    typeLabel: {
        en: 'What is it about?',
        fr: "De quoi s'agit-il ?",
        pt: 'De que se trata?',
        es: '¿De qué se trata?',
        ar: 'ما الموضوع؟',
    },
    descriptionLabel: {
        en: 'What happened?',
        fr: "Que s'est-il passé ?",
        pt: 'O que aconteceu?',
        es: '¿Qué ha pasado?',
        ar: 'ماذا حدث؟',
    },
    descriptionHint: {
        en: 'A few sentences are enough.',
        fr: 'Quelques phrases suffisent.',
        pt: 'Bastam algumas frases.',
        es: 'Bastan unas frases.',
        ar: 'بضع جمل تكفي.',
    },
    descriptionRequired: {
        en: 'Tell us what happened first.',
        fr: "Dites-nous d'abord ce qui s'est passé.",
        pt: 'Diga-nos primeiro o que aconteceu.',
        es: 'Cuéntanos primero qué ha pasado.',
        ar: 'أخبرنا أولًا بما حدث.',
    },
    attachmentLabel: {
        en: 'Photo attached',
        fr: 'Photo jointe',
        pt: 'Foto anexada',
        es: 'Foto adjunta',
        ar: 'صورة مرفقة',
    },
    submitButton: {
        en: 'Send',
        fr: 'Envoyer',
        pt: 'Enviar',
        es: 'Enviar',
        ar: 'إرسال',
    },
    sentTitle: {
        en: 'Sent',
        fr: 'Envoyé',
        pt: 'Enviado',
        es: 'Enviado',
        ar: 'تم الإرسال',
    },
    sentBody: {
        en: 'Your request is in. We will reply in the chat — you can close this page.',
        fr: 'Votre demande est envoyée. Nous vous répondrons dans la discussion — vous pouvez fermer cette page.',
        pt: 'O seu pedido foi enviado. Responderemos na conversa — pode fechar esta página.',
        es: 'Tu solicitud se ha enviado. Te responderemos en el chat — puedes cerrar esta página.',
        ar: 'تم إرسال طلبك. سنرد عليك في المحادثة — يمكنك إغلاق هذه الصفحة.',
    },
} as const);

export type BotTicketFormCopyKey = keyof typeof FORM_COPY;

/** The whole form vocabulary in one language, ready to travel with the form's data. */
export function botTicketFormCopy(language: string | null): Record<BotTicketFormCopyKey, string> {
    const out = {} as Record<BotTicketFormCopyKey, string>;
    for (const key of Object.keys(FORM_COPY) as BotTicketFormCopyKey[]) {
        out[key] = pick(FORM_COPY[key], language);
    }
    return out;
}

/**
 * What a chat pushes into the conversation once a form has been sent.
 *
 * ⚠ **A page that is about to close cannot tell a customer anything durable**, so the confirmation
 * belongs in the chat, where it stays. `{subject}` is substituted by the caller.
 */
const TICKET_OPENED_PUSH: Copy = {
    en: 'Your request “{subject}” has been sent. We will reply in this chat.',
    fr: 'Votre demande « {subject} » a bien été envoyée. Nous vous répondrons dans cette discussion.',
    pt: 'O seu pedido “{subject}” foi enviado. Responderemos nesta conversa.',
    es: 'Tu solicitud «{subject}» se ha enviado. Te responderemos en este chat.',
    ar: 'تم إرسال طلبك «{subject}». سنرد عليك في هذه المحادثة.',
};

export function botTicketOpenedPush(subject: string, language: string | null): string {
    return pick(TICKET_OPENED_PUSH, language).replace('{subject}', subject);
}

/**
 * Refuse to boot on a string a messaging client would truncate.
 *
 * ⚠ **Presence is the compiler's job; this is the caps.** A label two characters over WhatsApp's
 * button limit is silent forever and arrives as `Adjuntar fot…` to exactly the customers who read
 * Spanish. Only capped entries are walked — an uncapped one is never checked, so give a string a cap
 * the day it lands in a title or a button.
 *
 * The form strings carry no caps: they render in a web page and a Flow, neither of which truncates.
 */
export function assertTicketCopyComplete(): void {
    const gaps: string[] = [];

    for (const key of Object.keys(TICKET_COPY) as BotTicketCopyKey[]) {
        const { copy, cap } = TICKET_COPY[key];
        if (cap === null) continue;
        for (const language of BOT_COPY_LANGUAGES) {
            if (copy[language].length > cap) {
                gaps.push(`${key}:${language} is ${copy[language].length} chars, cap is ${cap}`);
            }
        }
    }

    /**
     * ⚠ **The eight subjects are capped by META, not by us** — a WhatsApp Flow renders them as a
     * `RadioButtonsGroup`, whose option title is cut at `FLOW_OPTION_TITLE_MAX`. The Telegram page has
     * room for all of them, so this limit is invisible on the channel we develop against and would
     * first be seen by a WhatsApp customer, as a half-word. Longest today is the French "Un problème
     * avec une commande" at 29.
     */
    for (const key of Object.keys(SUBJECT_COPY) as BotTicketSubjectKey[]) {
        for (const language of BOT_COPY_LANGUAGES) {
            const label = SUBJECT_COPY[key][language];
            if (label.length > FLOW_OPTION_TITLE_MAX) {
                gaps.push(`subject ${key}:${language} is ${label.length} chars, cap is ${FLOW_OPTION_TITLE_MAX}`);
            }
        }
    }

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] support copy is unusable: ${gaps.join('; ')}`);
    }
}

/** ⚠ Exported for the suite, which re-checks the caps and pins the tables. */
export const __TICKET_COPY_TABLE = TICKET_COPY;
export const __TICKET_FORM_COPY_TABLE = FORM_COPY;
export const __TICKET_STATE_TABLES = Object.freeze({
    stateOf: TICKET_STATE_OF,
    state: TICKET_STATE_COPY,
    subject: SUBJECT_COPY,
    typeOf: BOT_TICKET_TYPE_OF,
    typeOfTopic: BOT_TICKET_TYPE_OF_TOPIC,
    openedPush: TICKET_OPENED_PUSH,
});
