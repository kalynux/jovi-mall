import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';
import type { CustomerShipmentStatus } from '../../orders/dto/customer-shipment.dto';
import type { FulfillmentStatus } from '../../orders/order.model';

/**
 * ⭐ **THE ONE TABLE for how an order's state is worded to a customer — read by the chat AND by
 * the order-listing screen.**
 *
 * ── ⛔ WHY THERE IS ONE, AND WHY IT MUST STAY ONE ───────────────────────────
 * The chat's order list is the first five rows of the list `miniapp/surfaces/
 * order-listing.controller.ts` continues: a customer taps "Load more" and goes straight from one
 * to the other. On 2026-09-16 each surface had its own table, written a day apart, and they
 * disagreed in **four of nine** fulfilment statuses and in the payment wording too. Neither file
 * was wrong read alone — both were total `Record`s over the union, both had a written rationale —
 * and the worst disagreement was on `pending`, the state every new order is in: one said *"Order
 * received"*, the other *"Preparing"*, which are two different claims about whether anybody has
 * started work.
 *
 * A guard comparing two tables was proposed and declined in favour of this (coordinator decision,
 * 2026-09-16): **a guard catches a drift after somebody has written it; a single table cannot
 * drift.** The screen imports from here and holds no copy of its own.
 *
 * ⚠ **So never re-add a status word to a surface.** If a screen or a card needs a wording this
 * file does not have, add it here, where both surfaces read it — and if two surfaces genuinely
 * must say different things, write down why, because the next reader's instinct is to "fix" the
 * difference in a direction picked at random.
 *
 * ── ⚠ AN INTERNAL VALUE NEVER REACHES THE CUSTOMER, EVEN WHEN IT IS UNKNOWN ──
 * The statuses arrive as plain `string`s out of aggregations and DTOs, so a value that reached the
 * database before the union did will one day arrive here. It gets `statusUnavailable` — a neutral
 * sentence in the customer's language — and **never the raw token**. An earlier version of this
 * file returned the token itself as its floor, so a customer would have read `partially_shipped`;
 * that was exactly what the collapse below exists to prevent, arriving by the back door.
 *
 * ── THE TYPE SYSTEM DOES MOST OF THE CHECKING ───────────────────────────────
 * Every table is a **total `Record` over a closed union**, so a new status, bucket or language is a
 * compile error in the editor of whoever adds it. `assertOrderStatusCopyComplete()` checks only
 * what the compiler cannot see: a string too long for the control it lands in.
 *
 * ── ⚠ THIS FILE HAS NO RUNTIME IMPORTS BEYOND THE COPY LANGUAGES ────────────
 * Both model imports are `import type`, erased at compile time, so any suite can import this file
 * under bare `ts-node`. That matters here more than most places: anything that reaches `orders/`
 * or `payments/` at runtime does work at import and hangs bare `ts-node` with no output.
 *
 * ── WHERE THE WORDING COMES FROM ────────────────────────────────────────────
 * The delivery words agree with `notifications/catalog/customer-notification-catalog.ts`, which
 * already tells this customer "on its way" and "out for delivery" in these five languages; that
 * catalogue is the senior source, because a copy of it is sitting in their inbox.
 */

/** Five languages, one string each. Exported so a surface can type its own non-status copy. */
export type BotOrderCopy = Record<BotCopyLanguage, string>;
type Copy = BotOrderCopy;

/** A copy entry in the customer's language, falling back to English and never to a key. */
function pick(copy: Copy, language: string | null | undefined): string {
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The floor under every status: what an unrecognised one reads as
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **True of every status it could stand in for, which is why it says so little.** It is shown
 * for a value neither union knows — never for a real state — so it cannot guess at progress: a
 * default of "Preparing" would tell somebody with a cancelled order that their parcel is being
 * packed.
 */
export const ORDER_STATUS_UNAVAILABLE_COPY: Readonly<Copy> = Object.freeze({
    en: 'Status not available',
    fr: 'Statut indisponible',
    pt: 'Estado indisponível',
    es: 'Estado no disponible',
    ar: 'الحالة غير متاحة',
});

export function botOrderStatusUnavailable(language: string | null | undefined): string {
    return pick(ORDER_STATUS_UNAVAILABLE_COPY, language);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fulfilment — nine statuses, seven words
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seven words an order's progress collapses to.
 *
 * `partially_shipped` describes how many parcels a warehouse has released, which is the platform's
 * business rather than the customer's, so it reads "On its way". `fulfilled` is a warehouse word
 * for delivered-and-settled, so it reads "Delivered".
 *
 * ⚠ **`received` and `preparing` are DIFFERENT buckets, and must stay so.** `pending` is where every
 * order starts — and where a cash-on-delivery order can sit untouched for days — while `processing`
 * means somebody has started. One word for both is false in one direction or the other: "Preparing"
 * asserts work nobody has done, "Order received" hides work that has begun. `test:inapp-orders`
 * pins the two apart, so a future "tidy them into one" fails.
 *
 * ⚠ **`partly_delivered` keeps its own word.** A customer who already has half a multi-seller
 * checkout must not be told nothing has arrived; that is the one place collapsing into "On its way"
 * would state something false.
 */
export type BotOrderProgress =
    | 'received'
    | 'preparing'
    | 'shipped'
    | 'partly_delivered'
    | 'delivered'
    | 'cancelled'
    | 'returned';

/** ⚠ Total over `FulfillmentStatus`: a tenth fulfilment status is a compile error here. */
export const ORDER_PROGRESS_OF: Readonly<Record<FulfillmentStatus, BotOrderProgress>> = Object.freeze({
    pending: 'received',
    processing: 'preparing',
    partially_shipped: 'shipped',
    shipped: 'shipped',
    partially_delivered: 'partly_delivered',
    delivered: 'delivered',
    fulfilled: 'delivered',
    cancelled: 'cancelled',
    returned: 'returned',
});

export const ORDER_PROGRESS_COPY: Readonly<Record<BotOrderProgress, Copy>> = Object.freeze({
    received: {
        en: 'Order received',
        fr: 'Commande reçue',
        pt: 'Encomenda recebida',
        es: 'Pedido recibido',
        ar: 'تم استلام الطلب',
    },
    preparing: {
        en: 'Preparing',
        fr: 'En préparation',
        pt: 'Em preparação',
        es: 'En preparación',
        ar: 'قيد التحضير',
    },
    /** ⚠ Worded to match `order.shipped`'s notification — "on its way", never "dispatched". */
    shipped: {
        en: 'On its way',
        fr: 'En route',
        pt: 'A caminho',
        es: 'En camino',
        ar: 'في الطريق',
    },
    partly_delivered: {
        en: 'Partly delivered',
        fr: 'Partiellement livrée',
        pt: 'Parcialmente entregue',
        es: 'Entregado en parte',
        ar: 'تم تسليم جزء منه',
    },
    delivered: {
        en: 'Delivered',
        fr: 'Livrée',
        pt: 'Entregue',
        es: 'Entregado',
        ar: 'تم التسليم',
    },
    cancelled: {
        en: 'Cancelled',
        fr: 'Annulée',
        pt: 'Cancelada',
        es: 'Cancelado',
        ar: 'ملغى',
    },
    returned: {
        en: 'Returned',
        fr: 'Retournée',
        pt: 'Devolvida',
        es: 'Devuelto',
        ar: 'مُعاد',
    },
});

/**
 * Which bucket a fulfilment status belongs to — or `null` for a value the union does not know.
 *
 * ⚠ **Takes a `string`, on purpose.** Callers read the status out of an aggregation or a DTO, where
 * it is typed `string`; a narrow parameter would be satisfied by a cast at every call site, and a
 * cast is what turns an unmapped value into `undefined`. The table stays total over the union, so
 * this looseness weakens no compile-time guarantee.
 */
export function orderProgressOf(status: string | null | undefined): BotOrderProgress | null {
    if (typeof status !== 'string') return null;
    return (ORDER_PROGRESS_OF as Record<string, BotOrderProgress | undefined>)[status] ?? null;
}

/** How an order's progress is described. An unknown status reads as `statusUnavailable`. */
export function botFulfillmentStateLabel(
    status: string | null | undefined,
    language: string | null | undefined,
): string {
    const progress = orderProgressOf(status);
    return progress ? pick(ORDER_PROGRESS_COPY[progress], language) : botOrderStatusUnavailable(language);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Payment — one vocabulary, folded from the two the platform holds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a customer is told about money, as a closed set.
 *
 * ⚠ **The union of `PaymentStatus` and `aggregatePaymentStatus`'s output, folded.** `PaymentStatus`
 * spells one fact twice — `pending` and `AWAITING_PAYMENT` — and a customer shown both would
 * reasonably conclude two different things had happened to their money. `aggregatePaymentStatus`
 * adds `mixed` and `unknown`, which describe a checkout GROUP rather than any one payment.
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
 * ⚠ **Anything unrecognised becomes `unknown`, never `paid`.** Defaulting to anything reassuring
 * would answer *"what happened to my money"* with a guess — the failure `aggregatePaymentStatus`
 * guards against by putting its empty case first.
 */
export function toBotOrderPaymentState(raw: string | null | undefined): BotOrderPaymentState {
    switch (raw) {
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

/**
 * ⚠ **`unknown` has no entry: it reads as `statusUnavailable`**, through the same floor as an
 * unrecognised fulfilment status. It is reached only for a group with no orders in it.
 *
 * Wording adopted verbatim from the order-listing screen when the two tables became this one; it
 * had the better reasons, recorded on the entries below.
 */
export const ORDER_PAYMENT_COPY: Readonly<Record<Exclude<BotOrderPaymentState, 'unknown'>, Copy>> =
    Object.freeze({
        paid: {
            en: 'Paid',
            fr: 'Payée',
            pt: 'Paga',
            es: 'Pagado',
            ar: 'مدفوع',
        },
        partially_paid: {
            en: 'Partly paid',
            fr: 'Partiellement payée',
            pt: 'Parcialmente paga',
            es: 'Pagado en parte',
            ar: 'مدفوع جزئيًا',
        },
        awaiting_payment: {
            en: 'Awaiting payment',
            fr: 'En attente de paiement',
            pt: 'A aguardar pagamento',
            es: 'Pendiente de pago',
            ar: 'في انتظار الدفع',
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
            es: 'Reembolsado',
            ar: 'تم الاسترداد',
        },
        disputed: {
            en: 'Payment disputed',
            fr: 'Paiement contesté',
            pt: 'Pagamento contestado',
            es: 'Pago en disputa',
            ar: 'الدفع محل نزاع',
        },
        /**
         * The orders in one checkout are in different states — one refunded and one failed, say.
         * Worded as something to look at rather than as a verdict, because it is genuinely several
         * facts and the chat is where a customer can ask which.
         */
        mixed: {
            en: 'Payment needs attention',
            fr: 'Paiement à vérifier',
            pt: 'Pagamento a verificar',
            es: 'Pago por revisar',
            ar: 'الدفع يحتاج مراجعة',
        },
    });

/**
 * ⚠ **Cash on delivery is shown as a METHOD, not as a debt.**
 *
 * A COD order sits unpaid until the agent collects, so "awaiting payment" is technically honest and
 * practically wrong: it tells somebody who owes nothing yet that they are behind on a payment. When
 * the money is not due until the door, the method is the truer thing to say.
 *
 * ⚠ **The method, never the code.** The delivery code is a credential disclosed once, on request,
 * through a route built for it.
 */
export const ORDER_CASH_ON_DELIVERY_COPY: Readonly<Copy> = Object.freeze({
    en: 'Cash on delivery',
    fr: 'Paiement à la livraison',
    pt: 'Pagamento na entrega',
    es: 'Pago contra entrega',
    ar: 'الدفع عند الاستلام',
});

/**
 * How an order's money is described.
 *
 * ⚠ **`cashOnDelivery` means EVERY order being described is cash on delivery** — one order for a
 * chat card, all of a checkout's orders for a listing row. A group mixing prepaid and COD orders is
 * not "cash on delivery", and saying so would hide the prepaid half's debt.
 */
export function botPaymentStateLabel(
    state: BotOrderPaymentState,
    language: string | null | undefined,
    options: { cashOnDelivery?: boolean } = {},
): string {
    if (state === 'unknown') return botOrderStatusUnavailable(language);
    if (options.cashOnDelivery && state === 'awaiting_payment') {
        return pick(ORDER_CASH_ON_DELIVERY_COPY, language);
    }
    return pick(ORDER_PAYMENT_COPY[state], language);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parcels — the five a customer is shown, and nothing behind them
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **Keyed on `CustomerShipmentStatus`, the five — never on `ShipmentStatus`, the eleven.**
 *
 * The collapse is made once, in `customer-shipment.dto.ts`, and it is a **disclosure** decision:
 * `handing_over` and `pending_agency_reassignment` say how dispatch works and invite support
 * contacts about states nobody can act on. A table keyed on the eleven would quietly give four of
 * them customer-facing words — and would look like thoroughness while doing it.
 *
 * ⚠ **`preparing` and `shipped` use the SAME strings as the order buckets of those names**, so a
 * customer reading the order card and then a parcel card in one conversation sees one word for one
 * state.
 */
const SHIPMENT_STATE: Readonly<Record<CustomerShipmentStatus, Copy>> = Object.freeze({
    preparing: ORDER_PROGRESS_COPY.preparing,
    shipped: ORDER_PROGRESS_COPY.shipped,
    /** ⚠ Worded to match `order.out_for_delivery`'s notification. */
    out_for_delivery: {
        en: 'Out for delivery',
        fr: 'En cours de livraison',
        pt: 'Em entrega',
        es: 'En reparto',
        ar: 'قيد التوصيل',
    },
    /** ⚠ Masculine in French — `colis` — where the order bucket is feminine, `commande`. */
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
     * usually followed by another by the same agent — `failed` is not terminal — so the wording has
     * to leave that open.
     */
    delivery_failed: {
        en: 'Delivery attempt failed',
        fr: 'Tentative de livraison échouée',
        pt: 'Tentativa de entrega falhou',
        es: 'Intento de entrega fallido',
        ar: 'فشلت محاولة التسليم',
    },
});

/** How one parcel's progress is described. Narrowly typed: the DTO already holds the five. */
export function botShipmentStateLabel(
    status: CustomerShipmentStatus,
    language: string | null | undefined,
): string {
    return pick(SHIPMENT_STATE[status], language);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The few turns only the chat's fulfilment flow has
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
 * WhatsApp's 24-character row title: it fits by one and would be cut, in silence, by any change to
 * that generator. The code goes in the row's description, which has 72.
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
 * ⚠ **It offers nothing the platform cannot do.** There is no report-a-missing-parcel action on
 * this surface, so it hands the turn back to the assistant — which can open a support conversation
 * — rather than promising an investigation that nothing starts.
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
 * ⚠ **It states the fact and stops.** `customer-shipment.dto.ts` publishes only *that* an attempt
 * failed — never `delivery_failures[].reason` or `.note`. The note is written by an agent for their
 * own agency ("gate locked, dog"); repeating it here would undo that in the one place the customer
 * would actually read it.
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
 * endpoint anywhere in the platform (`bookings_reschedule` is appointments, not parcels), and the
 * delivery address is snapshotted onto the order at checkout — so editing the saved address book
 * moves no parcel already out. Rejected: Get help alone, which hides what the customer most likely
 * wants and makes them explain from scratch.
 *
 * ⚠ **The labels must not promise the action.** "Reschedule" claims a new day has been chosen;
 * "Change address" claims a parcel has been redirected. These say what actually happens next —
 * somebody is asked. Capped at 20, WhatsApp's reply-button title.
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
 * The turn strings above, each with the cap it has to satisfy. `null` means a body rather than a
 * control — the convention `bot-chrome-copy.ts` uses, so the two tables read the same way.
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

/** One turn string, in the customer's language — falling back to English, never to the key. */
export function botOrderCopy(key: BotOrderCopyKey, language: string | null | undefined): string {
    return pick(ORDER_COPY[key].copy, language);
}

/**
 * Refuse to boot on a string a messaging client would truncate.
 *
 * ⚠ **Presence is not checked here — the compiler checks it.** Every table is a total `Record`
 * over a closed union, so a missing status or language fails `tsc`. What `tsc` cannot see is a
 * label two characters over WhatsApp's button cap, which is silent forever and arrives as
 * `Dirección incorrec…` to exactly the customers who read Spanish.
 *
 * ⚠ **Only the turn strings carry a cap, so only they are walked.** The status words land in
 * message bodies and in list-row DESCRIPTIONS (72 characters), where nothing on this surface is
 * near the limit. The day a status word is put into a row title or a button, give it a cap here —
 * an uncapped entry is never checked.
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

/** ⚠ Exported for suites, which re-check the caps and pin the tables. */
export const __ORDER_COPY_TABLE = ORDER_COPY;
export const __ORDER_STATUS_TABLES = Object.freeze({
    progressOf: ORDER_PROGRESS_OF,
    progress: ORDER_PROGRESS_COPY,
    payment: ORDER_PAYMENT_COPY,
    cashOnDelivery: ORDER_CASH_ON_DELIVERY_COPY,
    unavailable: ORDER_STATUS_UNAVAILABLE_COPY,
    shipment: SHIPMENT_STATE,
});
