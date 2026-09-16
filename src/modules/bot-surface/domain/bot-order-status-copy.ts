import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';
import { CustomerShipmentStatus } from '../../orders/dto/customer-shipment.dto';
import { FulfillmentStatus } from '../../orders/order.model';

/**
 * The words an ORDER is described with — its state, and the few turns only fulfilment needs.
 *
 * ── WHY THIS IS A FOURTH COPY TABLE AND NOT A GROWTH OF `bot-chrome-copy.ts` ─
 * Two reasons, and the second decided it.
 *
 *   1. **Almost nothing here is chrome.** `bot-chrome-copy.ts` is explicit that it holds
 *      *"text that is rendered by the messaging client as a control"*, and that keeping it
 *      separate is what makes its caps checkable. A status label is a word inside a message
 *      body; mixing the two is what that file was split out to stop.
 *   2. ⚠ **Several sessions build on this surface in one working tree, and two sessions
 *      editing one file is a lost write rather than a merge conflict.** Stream 0 pre-declared
 *      the whole chrome vocabulary in one pass for exactly that reason. ~110 strings arriving
 *      into a table three other streams read would be the edit it was written to avoid.
 *
 * ⚠ **The five fulfilment strings that ARE chrome live in `bot-chrome-copy.ts` and must not
 * be copied here** — `cancelOrderButton`, `confirmDeliveryPrompt`, `cancelOrderPrompt`,
 * `cancelReasonPrompt`, `handoverPrompt`. They are reached with `botChrome()`. Two tables
 * answering "what do we call cancelling an order" is the drift a single copy layer exists to
 * prevent, and it would be invisible: both would render, in different words, on different
 * turns.
 *
 * ── ⚠ THE TYPE SYSTEM DOES MOST OF THE CHECKING, DELIBERATELY ───────────────
 * `assertBotChromeCopyFits` has to walk its table at boot because that table is a flat object
 * of loose keys, so a missing language can only be found by looking. Every status table below
 * is a **total `Record` over a closed union** — `FulfillmentStatus`, `BotOrderPaymentState`,
 * `CustomerShipmentStatus` — so a missing status is a **compile error**, and a missing
 * language is one too. That is strictly stronger than a boot assert: it fails in the editor
 * of the person adding the status rather than in production.
 *
 * `assertOrderStatusCopyComplete()` is exported anyway, because the one thing the compiler
 * cannot see is a string that is present but too long for the control it lands in.
 *
 * ── ⛔ THE SEAM: THESE WORDS ARE SHARED WITH A FILE NOTHING CAN CHECK THEM AGAINST ──
 * **`miniapp/surfaces/order-listing.controller.ts` words the same nine fulfilment statuses for
 * the same customer, and the chat list below is the FIRST FIVE ROWS OF THE LIST THAT SCREEN
 * CONTINUES.** A customer taps "Load more" and goes straight from one table to the other.
 *
 * They diverged within a day of both being written (2026-09-16), in four of nine statuses, and
 * neither file was wrong when read alone — both are total `Record`s over the union, both carry
 * a written rationale, and both independently concluded that "fulfilled" is a warehouse word.
 * The worst of the four was `pending`, the state **every new order is in**: one table said
 * *"Order received"* and the other *"Preparing"*, which are two different claims about whether
 * anybody has started work.
 *
 * ⚠ **No assertion can see this.** The two tables are in different files owned by different
 * streams, keyed on different unions — one collapses nine statuses to six customer words, this
 * one does not collapse at all. A guard would have to know that the two describe one list, and
 * nothing in either file says so except this paragraph and its twin over there.
 *
 * ⚠ **So: changing a word here means changing it there, in the same change.** If the two ever
 * have to differ, write down why — because the next reader's first instinct will be to "fix"
 * the inconsistency, and they will pick a direction at random.
 *
 * ── WHERE THE WORDING COMES FROM ────────────────────────────────────────────
 * ⚠ **The delivery states are worded to agree with
 * `notifications/catalog/customer-notification-catalog.ts`**, which already tells this same
 * customer "your order is on its way" and "out for delivery" in these same five languages. A
 * customer who reads a notification and then opens the chat must find the same word for the
 * same parcel — somebody who does not is not told we have two systems, they are told we do
 * not know where their parcel is. The notification catalogue is the senior of the two: it
 * shipped first, and a copy of it is sitting in their inbox.
 */

type Copy = Record<BotCopyLanguage, string>;

// ─────────────────────────────────────────────────────────────────────────────
//  Payment — ONE vocabulary, folded from the two the platform actually holds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a customer is told about money, as a closed set.
 *
 * ⚠ **This is neither `PaymentStatus` nor `aggregatePaymentStatus`'s output — it is the two
 * of them folded.** The platform holds two payment vocabularies that overlap and disagree at
 * the edges:
 *
 *   - `PaymentStatus` on one order: `pending · AWAITING_PAYMENT · partially_paid · paid ·
 *     disputed · failed · refunded`. ⚠ **`pending` and `AWAITING_PAYMENT` are two spellings
 *     of one fact** — one of them even shouts — and a customer shown both would reasonably
 *     conclude they name two different things that have happened to their money.
 *   - `aggregatePaymentStatus` over a checkout group adds `mixed` and `unknown`, which
 *     describe the *group* rather than any payment.
 *
 * Folding once, here, is what stops the order list and the order card calling one state by
 * two names on two consecutive turns.
 */
export type BotOrderPaymentState =
    | 'awaiting_payment'
    | 'partially_paid'
    | 'paid'
    | 'disputed'
    | 'failed'
    | 'refunded'
    | 'mixed'
    | 'unknown';

/**
 * Fold either vocabulary onto the one above.
 *
 * ⚠ **An unrecognised string becomes `unknown`, never `paid`.** This takes a plain `string`
 * because `aggregatePaymentStatus` is typed that way, so a status nobody has mapped yet will
 * eventually arrive here. Defaulting it to anything reassuring would answer *"what happened
 * to my money"* with a guess — the failure `aggregatePaymentStatus` guards against by putting
 * its empty case first, arriving by a second door.
 */
export function toBotOrderPaymentState(raw: string | null | undefined): BotOrderPaymentState {
    switch (raw) {
        // The two spellings of "we are still waiting for this money".
        case 'pending':
        case 'AWAITING_PAYMENT':
        case 'awaiting_payment':
            return 'awaiting_payment';
        case 'partially_paid':
            return 'partially_paid';
        case 'paid':
            return 'paid';
        case 'disputed':
            return 'disputed';
        case 'failed':
            return 'failed';
        case 'refunded':
            return 'refunded';
        case 'mixed':
            return 'mixed';
        default:
            return 'unknown';
    }
}

const PAYMENT_STATE: Readonly<Record<BotOrderPaymentState, Copy>> = Object.freeze({
    awaiting_payment: {
        en: 'Not paid yet',
        fr: 'Pas encore payée',
        pt: 'Ainda não paga',
        es: 'Aún sin pagar',
        ar: 'لم تُدفع بعد',
    },
    partially_paid: {
        en: 'Partly paid',
        fr: 'Partiellement payée',
        pt: 'Parcialmente paga',
        es: 'Parcialmente pagada',
        ar: 'مدفوعة جزئيًا',
    },
    paid: {
        en: 'Paid',
        fr: 'Payée',
        pt: 'Paga',
        es: 'Pagada',
        ar: 'مدفوعة',
    },
    disputed: {
        en: 'Payment disputed',
        fr: 'Paiement contesté',
        pt: 'Pagamento contestado',
        es: 'Pago en disputa',
        ar: 'الدفع محل نزاع',
    },
    failed: {
        en: 'Payment failed',
        fr: 'Paiement échoué',
        pt: 'Pagamento falhou',
        es: 'Pago fallido',
        ar: 'فشل الدفع',
    },
    refunded: {
        en: 'Refunded',
        fr: 'Remboursée',
        pt: 'Reembolsada',
        es: 'Reembolsada',
        ar: 'تم استردادها',
    },
    /**
     * ⚠ **A checkout group whose orders disagree — and it must not read as a state of the
     * money.** "Mixed" alone invites *"mixed with what?"*; naming the level the disagreement
     * lives at is what makes it a fact the customer can act on.
     */
    mixed: {
        en: 'Varies by order',
        fr: 'Varie selon la commande',
        pt: 'Varia por encomenda',
        es: 'Varía según el pedido',
        ar: 'يختلف حسب الطلب',
    },
    /**
     * ⚠ **Reached only when there is nothing to report at all** — on this path, a group with
     * no orders in it. It says so plainly rather than inventing a state, which is the same
     * decision `aggregatePaymentStatus` makes by answering `unknown` for an empty group
     * instead of letting `[].every(...)` report `paid`.
     */
    unknown: {
        en: 'Not available',
        fr: 'Non disponible',
        pt: 'Indisponível',
        es: 'No disponible',
        ar: 'غير متاح',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
//  Fulfilment — the nine, worded for the person waiting rather than the warehouse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **A total map over `FulfillmentStatus`, so a tenth status is a compile error here.** The
 * rule `CUSTOMER_VISIBLE_STATUS` already follows in `customer-shipment.dto.ts`, for the same
 * reason: the alternative is a new internal state reaching a customer under whatever the
 * fallback happened to be.
 *
 * ⚠ **Unlike that map, this one collapses nothing — all nine are shown.** The shipment
 * vocabulary is collapsed 11 → 5 because most of those eleven describe dispatch machinery the
 * customer cannot act on. These nine are all facts about the customer's own order, and
 * `partially_shipped` against `shipped` is precisely the difference somebody with two parcels
 * needs to see.
 */
const FULFILLMENT_STATE: Readonly<Record<FulfillmentStatus, Copy>> = Object.freeze({
    pending: {
        en: 'Order received',
        fr: 'Commande reçue',
        pt: 'Encomenda recebida',
        es: 'Pedido recibido',
        ar: 'تم استلام الطلب',
    },
    processing: {
        en: 'Being prepared',
        fr: 'En préparation',
        pt: 'Em preparação',
        es: 'En preparación',
        ar: 'قيد التحضير',
    },
    partially_shipped: {
        en: 'Part of it is on its way',
        fr: 'Une partie est en route',
        pt: 'Parte está a caminho',
        es: 'Una parte va en camino',
        ar: 'جزء منه في الطريق',
    },
    /** ⚠ Worded to match `order.shipped`'s notification — "on its way", never "dispatched". */
    shipped: {
        en: 'On its way',
        fr: 'En route',
        pt: 'A caminho',
        es: 'En camino',
        ar: 'في الطريق',
    },
    partially_delivered: {
        en: 'Part of it has arrived',
        fr: 'Une partie est arrivée',
        pt: 'Parte já chegou',
        es: 'Una parte ha llegado',
        ar: 'وصل جزء منه',
    },
    delivered: {
        en: 'Delivered',
        fr: 'Livrée',
        pt: 'Entregue',
        es: 'Entregado',
        ar: 'تم التسليم',
    },
    /**
     * ⚠ **"Complete", not "Fulfilled".** `fulfilled` is the platform's word for *delivered,
     * confirmed and settled*; to the customer the parcel simply arrived, and a second
     * delivery-shaped word after "Delivered" reads as another state they are still waiting on
     * rather than as the end of it.
     */
    fulfilled: {
        en: 'Complete',
        fr: 'Terminée',
        pt: 'Concluída',
        es: 'Completado',
        ar: 'مكتمل',
    },
    cancelled: {
        en: 'Cancelled',
        fr: 'Annulée',
        pt: 'Cancelada',
        es: 'Cancelado',
        ar: 'أُلغيت',
    },
    returned: {
        en: 'Returned',
        fr: 'Retournée',
        pt: 'Devolvida',
        es: 'Devuelto',
        ar: 'أُعيدت',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
//  Parcels — the five a customer is shown, and nothing behind them
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **Keyed on `CustomerShipmentStatus`, the five — never on `ShipmentStatus`, the eleven.**
 *
 * The collapse is already made once, in `customer-shipment.dto.ts`, and it is a **disclosure**
 * decision rather than a display one: `handing_over` and `pending_agency_reassignment` say how
 * dispatch works and invite support contacts about states nobody can act on. A copy table
 * keyed on the eleven would quietly re-open that by giving four of them customer-facing words
 * — and it would look like thoroughness while doing it.
 */
const SHIPMENT_STATE: Readonly<Record<CustomerShipmentStatus, Copy>> = Object.freeze({
    preparing: {
        en: 'Being prepared',
        fr: 'En préparation',
        pt: 'Em preparação',
        es: 'En preparación',
        ar: 'قيد التحضير',
    },
    shipped: {
        en: 'On its way',
        fr: 'En route',
        pt: 'A caminho',
        es: 'En camino',
        ar: 'في الطريق',
    },
    /** ⚠ Worded to match `order.out_for_delivery`'s notification. */
    out_for_delivery: {
        en: 'Out for delivery',
        fr: 'En cours de livraison',
        pt: 'Em entrega',
        es: 'En reparto',
        ar: 'قيد التوصيل',
    },
    delivered: {
        en: 'Delivered',
        fr: 'Livré',
        pt: 'Entregue',
        es: 'Entregado',
        ar: 'تم التسليم',
    },
    /**
     * ⚠ **It names the ATTEMPT, not the parcel.** `delivery_failed` also covers the internal
     * `returned`, and "failed" said flatly reads as *your parcel is gone*. A failed attempt is
     * usually followed by another one by the same agent — `failed` is not terminal and the
     * agent keeps the parcel — so the wording has to leave that open.
     */
    delivery_failed: {
        en: 'Delivery attempt failed',
        fr: 'Tentative de livraison échouée',
        pt: 'Tentativa de entrega falhou',
        es: 'Intento de entrega fallido',
        ar: 'فشلت محاولة التسليم',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
//  The few turns only fulfilment has
// ─────────────────────────────────────────────────────────────────────────────

/** The line above a list of the customer's orders. */
const WHICH_ORDER: Copy = {
    en: 'Which order would you like to see?',
    fr: 'Quelle commande souhaitez-vous voir ?',
    pt: 'Que encomenda quer ver?',
    es: '¿Qué pedido quieres ver?',
    ar: 'أي طلب تريد أن ترى؟',
};

/** The line above a list of one order's parcels. */
const WHICH_PARCEL: Copy = {
    en: 'Which parcel?',
    fr: 'Quel colis ?',
    pt: 'Qual volume?',
    es: '¿Qué paquete?',
    ar: 'أي طرد؟',
};

/**
 * A parcel's name in a picker row, numbered by the caller.
 *
 * ⚠ **A number, not the tracking code.** `ACR-YYMMDD-HHMMSS-XXXXX` is 23 characters against
 * WhatsApp's 24-character row title: it fits by one character today and would be cut, in
 * silence, by any change to that generator. The code goes in the row's *description*, which
 * has 72.
 */
const PARCEL_LABEL: Copy = {
    en: 'Parcel',
    fr: 'Colis',
    pt: 'Volume',
    es: 'Paquete',
    ar: 'طرد',
};

/** What to say once a delivery has been confirmed. */
const DELIVERY_CONFIRMED: Copy = {
    en: 'Thank you — I have marked this parcel as received.',
    fr: "Merci — j'ai noté que ce colis est bien reçu.",
    pt: 'Obrigado — registei esta encomenda como recebida.',
    es: 'Gracias — he marcado este paquete como recibido.',
    ar: 'شكرًا — سجّلت استلام هذا الطرد.',
};

/**
 * What to say when the customer answers **No** to "did your parcel arrive?".
 *
 * ⚠ **It must not offer anything the platform cannot do.** There is no report-a-missing-parcel
 * action on this surface, so this hands the turn back to the assistant — which can open a
 * support conversation — rather than promising an investigation that nothing starts.
 */
const DELIVERY_NOT_RECEIVED: Copy = {
    en: 'Understood — I have not marked it as received. Tell me what happened and I will get you help.',
    fr: "Compris — je ne l'ai pas marqué comme reçu. Dites-moi ce qui s'est passé et je vous trouve de l'aide.",
    pt: 'Entendido — não a registei como recebida. Diga-me o que aconteceu e eu arranjo-lhe ajuda.',
    es: 'Entendido — no lo he marcado como recibido. Cuéntame qué ha pasado y te consigo ayuda.',
    ar: 'مفهوم — لم أسجّله كمستلَم. أخبرني بما حدث وسأوفّر لك المساعدة.',
};

/**
 * The line above the actions offered after a failed delivery attempt.
 *
 * ⚠ **It states the fact and stops.** `customer-shipment.dto.ts` publishes only *that* an
 * attempt failed — never `delivery_failures[].reason` or `.note`. The note is written by an
 * agent for their own agency ("gate locked, dog") and the reason is an internal enum; both are
 * already rephrased deliberately by the notification copy. Repeating either here would undo
 * that in the one place the customer would actually read it.
 */
const DELIVERY_FAILED_PROMPT: Copy = {
    en: 'The courier could not deliver this parcel. What would you like to do?',
    fr: 'Le livreur n’a pas pu remettre ce colis. Que souhaitez-vous faire ?',
    pt: 'O estafeta não conseguiu entregar esta encomenda. O que quer fazer?',
    es: 'El repartidor no ha podido entregar este paquete. ¿Qué quieres hacer?',
    ar: 'لم يتمكّن المندوب من تسليم هذا الطرد. ماذا تريد أن تفعل؟',
};

/**
 * ⭐ **The two buttons that open a SUPPORT CONVERSATION rather than a feature.**
 *
 * Owner's decision, 2026-09-16, taken knowing the position: there is **no** delivery-reschedule
 * endpoint anywhere in the platform (`bookings_reschedule` is appointments, not parcels), and
 * the delivery address is snapshotted onto the order at checkout — so editing the saved address
 * book moves no parcel that is already out. The alternative considered and rejected was showing
 * Get help alone, which hides the two things the customer most likely wants and makes them
 * explain from scratch.
 *
 * ⚠ **So the labels must not promise the action.** "Reschedule" claims the customer has just
 * chosen a new day; "Change address" claims a parcel has been redirected. These say what
 * actually happens next, which is that somebody is asked. Capped at 20 — WhatsApp's
 * reply-button title — exactly as `bot-chrome-copy.ts` caps its own.
 */
const ASK_REDELIVERY_BUTTON: Copy = {
    en: 'Ask to redeliver',
    fr: 'Demander un report',
    pt: 'Pedir nova entrega',
    es: 'Pedir otra entrega',
    ar: 'طلب إعادة التسليم',
};

const ASK_ADDRESS_FIX_BUTTON: Copy = {
    en: 'Address is wrong',
    fr: 'Adresse incorrecte',
    pt: 'Morada errada',
    es: 'Dirección incorrecta',
    ar: 'العنوان غير صحيح',
};

/**
 * Everything above that is not keyed on a status, with the cap it has to satisfy.
 *
 * `null` means a body rather than a control — the same convention `bot-chrome-copy.ts`'s table
 * uses, so the two read the same way and neither teaches a second set of rules.
 */
const ORDER_COPY = Object.freeze({
    whichOrder: { copy: WHICH_ORDER, cap: null },
    whichParcel: { copy: WHICH_PARCEL, cap: null },
    // Half of a WhatsApp list row title (24) once a number is appended: `Paquete 2`.
    parcelLabel: { copy: PARCEL_LABEL, cap: 18 },
    deliveryConfirmed: { copy: DELIVERY_CONFIRMED, cap: null },
    deliveryNotReceived: { copy: DELIVERY_NOT_RECEIVED, cap: null },
    deliveryFailedPrompt: { copy: DELIVERY_FAILED_PROMPT, cap: null },
    askRedeliveryButton: { copy: ASK_REDELIVERY_BUTTON, cap: 20 },
    askAddressFixButton: { copy: ASK_ADDRESS_FIX_BUTTON, cap: 20 },
} as const);

export type BotOrderCopyKey = keyof typeof ORDER_COPY;

/**
 * One of the strings above, in the customer's language.
 *
 * Falls back to English rather than to the key, exactly as `botChrome` does — a customer shown
 * the word `whichParcel` has been shown an internal identifier, which is the failure the whole
 * copy layer exists to prevent.
 */
export function botOrderCopy(key: BotOrderCopyKey, language: string | null | undefined): string {
    const { copy } = ORDER_COPY[key];
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/** How this order's money is described. */
export function botPaymentStateLabel(
    state: BotOrderPaymentState,
    language: string | null | undefined,
): string {
    const copy = PAYMENT_STATE[state];
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/**
 * How this order's progress is described.
 *
 * ⚠ **Takes a `string`, not a `FulfillmentStatus`, and the looseness is on purpose.** Every
 * caller reads the status off a DTO or an aggregation, where it is typed `string` — so a
 * parameter of the narrow type would be satisfied by a cast at each call site, and a cast is
 * exactly what turns an unmapped value into `undefined.en` and a 500 on "where is my order?".
 *
 * ⚠ **The compile-time guarantee is NOT weakened by this.** `FULFILLMENT_STATE` is still a
 * total `Record<FulfillmentStatus, Copy>`, so a tenth status added to the union still fails
 * `tsc` here. What this adds is a floor under data that reached the database before the union
 * did, which a cast would have hidden.
 */
export function botFulfillmentStateLabel(
    status: string,
    language: string | null | undefined,
): string {
    const copy = FULFILLMENT_STATE[status as FulfillmentStatus];
    if (!copy) return status;
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/**
 * How one parcel's progress is described.
 *
 * Narrowly typed, unlike the fulfilment label above, because `CustomerShipmentDto.status` is
 * already the five-member union — the collapse happened in the projection and nothing
 * downstream handles a raw `ShipmentStatus`. There is no cast at any call site to hide.
 */
export function botShipmentStateLabel(
    status: CustomerShipmentStatus,
    language: string | null | undefined,
): string {
    const copy = SHIPMENT_STATE[status];
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/**
 * Refuse to boot on a string a messaging client would truncate.
 *
 * ⚠ **Presence is NOT checked here, and that is not an omission — the compiler checks it.**
 * Every table in this file is a total `Record` over a closed union, so a missing status or a
 * missing language fails `tsc` in the editor of whoever added it. What `tsc` cannot see is a
 * label two characters over WhatsApp's button cap, which is silent forever and arrives as
 * `Dirección incorrec…` to exactly the customers who read Spanish.
 *
 * The status tables are walked too, though every one of them is uncapped today: they land in
 * list-row *descriptions* (72 characters) now, and a later turn may well put one in a title. A
 * loop that already exists costs nothing and is one fewer thing for that person to remember.
 *
 * A bare `Error` — this runs beside the other boot assertions, with no request in flight.
 */
export function assertOrderStatusCopyComplete(): void {
    const gaps: string[] = [];

    for (const key of Object.keys(ORDER_COPY) as BotOrderCopyKey[]) {
        const { copy, cap } = ORDER_COPY[key];
        if (cap === null) continue;
        for (const lang of BOT_COPY_LANGUAGES) {
            if (copy[lang].length > cap) {
                gaps.push(`${key}:${lang} is ${copy[lang].length} chars, cap is ${cap}`);
            }
        }
    }

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] order status copy is unusable: ${gaps.join('; ')}`);
    }
}

/** ⚠ Exported for the fulfilment suite, which re-checks the caps the assert above enforces. */
export const __ORDER_COPY_TABLE = ORDER_COPY;
export const __ORDER_STATUS_TABLES = Object.freeze({
    payment: PAYMENT_STATE,
    fulfillment: FULFILLMENT_STATE,
    shipment: SHIPMENT_STATE,
});
