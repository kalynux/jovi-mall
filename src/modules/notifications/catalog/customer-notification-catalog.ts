import { CustomerNotificationType } from '../models/customer-notification.model';
import type { ShipmentFailureReason } from '../../shipments/shipment.model';
import { renderTemplate, RenderContext } from './message-renderer';
import { Language, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './notification-i18n';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
    ChannelText,
    SituationMessages,
    ButtonDef,
    QuickReplyDef,
    WhatsAppTemplateDef,
    closureRequestedBase,
    CLOSURE_SUBJECT
} from './notification-catalog';
/**
 * The bot's tap-token grammar. A pure module (`crypto` + the dependency-free onboarding
 * step list), so importing it closes no cycle with the bot surface.
 */
import { accountActionId, deliveryFeeListActionId, deliveryFeeOrderActionId } from '../../bot-surface/domain/bot-action-id';

/**
 * A customer situation. The same shape as every stack's, except that the WhatsApp TEMPLATE is
 * optional — for this stack alone, because only this stack has a situation that is
 * deliberately in-window-only (`cart.abandoned`; owner's ruling 2026-09-27, plan Q-6). Out of
 * the 24-hour window such a situation sends NO WhatsApp message at all.
 *
 * Scoped here rather than loosened on `SituationMessages`, so the vendor, agency and agent
 * stacks — every one of whose situations has a template — keep the compiler's guarantee.
 *
 * ⛔ Never name a template that was not submitted just to fill the field: that is exactly the
 * defect the name-parity guard in `test:customer-notifications` exists to catch. Absent is the
 * honest value.
 */
export interface CustomerSituationMessages extends Omit<SituationMessages, 'whatsapp'> {
    whatsapp: Omit<SituationMessages['whatsapp'], 'template'> & { template?: WhatsAppTemplateDef };
}
import { storefrontPath } from '../../../core/utils/storefront-link.util';

/**
 * Customer Notification Message Catalog (localized)
 *
 * Customer-facing counterpart to the vendor / agency / agent catalogs. Same shape
 * and rendering rules (see notification-catalog.ts's doc comment).
 *
 * ── How this copy differs from the other three ──────────────────────────────
 *
 * The sibling catalogs address a *business* about its operations. This one
 * addresses a person about something they are waiting for, so it follows three
 * rules the others do not need:
 *
 *  1. **Say what happens next, or that nothing does.** "We'll refund you" leaves
 *     someone watching their bank account; "the money is on its way back and
 *     usually lands within a few days" does not.
 *  2. **Never use platform vocabulary.** No "shipment", no "fulfilment", no
 *     "aggregate". A customer has an *order* and a *delivery*, and a service
 *     appointment is a *booking*. `no-show` is never shown to them at all.
 *  3. **Name the thing, not the id.** The service or the order number, plus the
 *     time — because these arrive on a lock screen with no context around them.
 *
 * Times are pre-formatted by the handler in the CUSTOMER's timezone before they
 * reach a template — `{{startAt}}` is already a readable local string here, never
 * an ISO instant.
 *
 * Translations are maintained for: en, fr, pt, es, ar.
 */

// ─── Where the buttons point ─────────────────────────────────────────────────

/**
 * ⚠ **A `urlSuffix` is a REAL ROUTE in `frontend/landing`, and nothing here can
 * check that.** Every one of them was written as a bare noun — `orders/{{id}}`,
 * `support/{{id}}` — before the shop's pages existed, and every one was wrong:
 * the pages live under `/shop/account/`, so all 22 buttons in this catalogue
 * pointed at a 404 in every email, WhatsApp message, Telegram message and inbox
 * row for as long as they have existed. Nothing reported it, because a link is
 * only ever wrong in the customer's browser.
 *
 * So when you add or move one, **open the storefront's route tree and read it**
 * (`frontend/landing/src/app/[locale]/…`). The four rules that make these hold:
 *
 *  1. **No leading slash.** WhatsApp's approved template button is
 *     `{STOREFRONT_URL}/{{1}}` and Meta supplies the separator — a leading
 *     slash here produces `https://site//shop/…`.
 *  2. **No locale.** `renderCustomerButton` adds it, once, per channel.
 *     Baking `fr/` in here would double it on the bot's path.
 *  3. **Everything owner-scoped lives under `shop/account/`.** The exception is
 *     the pay page, which is deliberately reachable with no session.
 *  4. **A route that does not exist yet is worse than no button.** Three were in
 *     that state when the tails above were corrected; the storefront built all
 *     three on 2026-09-07, and every suffix in this file now resolves on both
 *     the web and the packaged app. `api-doc/notifications/storefront-routes.md`
 *     is the cross-repository record and is the page to update — in BOTH copies
 *     of the mirror — the next time one of these moves.
 */

// ─── Shared button label sets ────────────────────────────────────────────────

const VIEW_BOOKING_LABEL: Record<Language, string> = {
    en: 'View booking',
    fr: 'Voir la réservation',
    pt: 'Ver reserva',
    es: 'Ver reserva',
    ar: 'عرض الحجز'
};

const BOOKING_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_BOOKING_LABEL,
    urlSuffix: 'shop/account/bookings/{{bookingId}}'
};

const PAY_BALANCE_LABEL: Record<Language, string> = {
    en: 'Pay balance',
    fr: 'Payer le solde',
    pt: 'Pagar saldo',
    es: 'Pagar saldo',
    ar: 'دفع الرصيد'
};

const PAY_BALANCE_BUTTON: ButtonDef = {
    type: 'url',
    label: PAY_BALANCE_LABEL,
    urlSuffix: 'shop/account/bookings/{{bookingId}}/balance'
};

const VIEW_ORDER_LABEL: Record<Language, string> = {
    en: 'View order',
    fr: 'Voir la commande',
    pt: 'Ver encomenda',
    es: 'Ver pedido',
    ar: 'عرض الطلب'
};

/**
 * ✅ Built in the storefront on 2026-09-07 as `components/shop/account/OrderDetail.tsx`,
 * with an app twin at `/shop/account/order/detail?id=`.
 *
 * ⚠ **`{{orderId}}` is one ORDER, and the storefront's `/shop/account/orders/:cartId` is a
 * whole CHECKOUT GROUP** — one basket split into one order per vendor. So this button could
 * not simply be re-pointed at the page that exists: it carries the id of the parcel the
 * message is about, and that page looks up a group by the id it is given and finds nothing.
 * Sending the *group* id instead was the alternative, and the owner chose the page — a
 * message about one parcel should land on that parcel, not on a list containing it.
 *
 * ⚠ **The `detail` segment is load-bearing and must not be tidied away.** Its sibling
 * `orders/[cartId]` is a dynamic segment at the same depth over there, and a static
 * segment in front of the id is the only thing stopping it swallowing every single-order
 * link and rendering the group screen against an id it cannot resolve.
 */
const VIEW_BASKET_LABEL: Record<Language, string> = {
    en: 'View basket', fr: 'Voir le panier', pt: 'Ver cesto', es: 'Ver carrito', ar: 'عرض السلة'
};

/** The storefront basket page, `src/app/[locale]/shop/cart/page.tsx` in the landing app. */
const CART_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_BASKET_LABEL,
    urlSuffix: 'shop/cart'
};

const SHOW_BASKET_LABEL: Record<Language, string> = {
    en: 'Show my basket', fr: 'Voir mon panier', pt: 'Ver o meu cesto', es: 'Ver mi carrito', ar: 'اعرض سلتي'
};

const ORDER_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_ORDER_LABEL,
    urlSuffix: 'shop/account/orders/detail/{{orderId}}'
};

const PAY_NOW_LABEL: Record<Language, string> = {
    en: 'Pay now',
    fr: 'Payer maintenant',
    pt: 'Pagar agora',
    es: 'Pagar ahora',
    ar: 'ادفع الآن'
};

/**
 * The hosted card page (GAP-008).
 *
 * ⚠ **`{{payToken}}`, never `{{transactionId}}`.** The page is reachable without a session,
 * so what travels in the URL has to be the opaque expiring handle rather than the
 * transaction's id — the whole argument for the handle is in `payments/domain/pay-link.ts`,
 * and putting an id here would quietly undo it.
 *
 * ✅ Built in the storefront on 2026-09-07 as `components/pay/PayLink.tsx`, with a real
 * Stripe Payment Element reading `GET /payments/session/:token`. This is the only suffix
 * here deliberately NOT under `shop/account/`: the whole point of a pay link is that
 * somebody without an account opens it — a mother orders, her son pays — so building it
 * inside the signed-in tree would lock out the one person it is for. The storefront's
 * middleware gates on a prefix list that `/pay` is not on, and it must stay off it.
 *
 * ⚠ **It has NO app twin, unlike every other suffix here, and that is deliberate.** A pay
 * link is opened in whatever browser the recipient tapped it from, by somebody who very
 * often has no app installed at all.
 */
const PAY_LINK_BUTTON: ButtonDef = {
    type: 'url',
    label: PAY_NOW_LABEL,
    urlSuffix: 'pay/{{payToken}}'
};

const VIEW_TICKET_LABEL: Record<Language, string> = {
    en: 'View request',
    fr: 'Voir la demande',
    pt: 'Ver pedido de apoio',
    es: 'Ver solicitud',
    ar: 'عرض الطلب'
};

/**
 * ⚠ **"Request", never "ticket".** Rule 2 of this catalog's header — no platform
 * vocabulary. A customer opened a support *request*; `ticket` is what the system calls the
 * row, and the Portuguese and Spanish words for it mean a travel or raffle ticket.
 */
const TICKET_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_TICKET_LABEL,
    urlSuffix: 'shop/account/support/{{ticketId}}'
};

const TRACK_ORDER_LABEL: Record<Language, string> = {
    en: 'Track delivery',
    fr: 'Suivre la livraison',
    pt: 'Acompanhar entrega',
    es: 'Seguir la entrega',
    ar: 'تتبع التوصيل'
};

/**
 * ✅ Built in the storefront on 2026-09-07, on its existing live-tracking stack, with an app
 * twin at `/shop/account/order/tracking?id=`. It is nested under the single-order page
 * rather than under the checkout-group page, because a customer tracks one parcel and a
 * checkout group can be several going to several places.
 */
const TRACK_BUTTON: ButtonDef = {
    type: 'url',
    label: TRACK_ORDER_LABEL,
    urlSuffix: 'shop/account/orders/detail/{{orderId}}/tracking'
};

// ─── Quick replies (phase 10, stage 1) ───────────────────────────────────────

/**
 * ⭐ **The chat quick-reply vocabulary, designed once for every situation.**
 *
 * A tap here comes back as a TOKEN to the bot's dispatcher, unlike `button`
 * above, which opens a page. See `QuickReplyDef` for the per-channel mechanics
 * and for why the in-app inbox deliberately shows none of these.
 *
 * ── The rule that decided which situations get one ──────────────────────────
 *
 * Every situation already has a URL button answering *"let me look at it"*. A
 * quick reply is added **only** where the customer plausibly wants to *do*
 * something the bot can finish in chat without opening a screen. **Most get
 * none, deliberately** — a button that merely repeats the link costs a Meta
 * re-approval in stage 2 and buys the customer nothing. (No count here: this
 * sentence carried one, and it expired as situations and buttons moved.)
 *
 * ── ⚠ Three constraints every entry below satisfies, all asserted at boot ───
 *
 *  1. **≤ 20 characters per label, in all five languages** — WhatsApp's reply
 *     button title cap, the tightest of the channels. Over it the builder
 *     truncates and the customer reads a clipped word.
 *  2. **≤ 64 bytes per rendered token** — Telegram's `callback_data` cap. The
 *     longest here is 44.
 *  3. **≤ 3 per situation** — WhatsApp's cap on one interactive message.
 *
 * ── ⚠ An unresolved placeholder DROPS the button, and that is a feature ─────
 *
 * `pay:rt:` with no id would reach the dispatcher's unknown-action refusal,
 * which reads to a customer as *"this button expired"* on a message that just
 * arrived. So the renderer drops any quick reply whose token still contains an
 * unfilled `{{…}}`. Two entries rely on this **as their conditional**, rather
 * than growing a second mechanism — see `ticket.resolved` and
 * `booking.cancelled` below.
 */

/*
 * ⚠ `CANCEL_BOOKING_LABEL` and `THAT_WORKS_LABEL` are referenced by NO situation today, on
 * purpose: their tokens (`yes:bkcnl:` / `no:bkcnl:`, `yes:bkmove:`) have no registered handler,
 * and a button without one reaches the unknown-action refusal. They are kept, translated, for
 * the bookings work that registers those keys — see `booking.rescheduled`'s withdrawal note.
 */
const CANCEL_BOOKING_LABEL: Record<Language, string> = {
    en: 'Cancel booking', fr: 'Annuler', pt: 'Cancelar', es: 'Cancelar', ar: 'إلغاء الحجز'
};

const THAT_WORKS_LABEL: Record<Language, string> = {
    en: 'That works', fr: 'Ça me va', pt: 'Está bem', es: 'Me va bien', ar: 'يناسبني'
};

const ASK_TO_CHANGE_LABEL: Record<Language, string> = {
    en: 'Ask to change', fr: 'Demander un autre', pt: 'Pedir outra hora', es: 'Pedir otra hora', ar: 'طلب وقت آخر'
};

const BOOK_AGAIN_LABEL: Record<Language, string> = {
    en: 'Book again', fr: 'Réserver à nouveau', pt: 'Reservar de novo', es: 'Reservar otra vez', ar: 'حجز مرة أخرى'
};

const LEAVE_REVIEW_LABEL: Record<Language, string> = {
    en: 'Leave a review', fr: 'Donner un avis', pt: 'Deixar avaliação', es: 'Dejar reseña', ar: 'أضف تقييمًا'
};

const TRY_AGAIN_LABEL: Record<Language, string> = {
    en: 'Try again', fr: 'Réessayer', pt: 'Tentar de novo', es: 'Intentar otra vez', ar: 'إعادة المحاولة'
};

export const ORDER_DETAILS_LABEL: Record<Language, string> = {
    en: 'Order details', fr: 'Détails', pt: 'Detalhes', es: 'Detalles', ar: 'تفاصيل الطلب'
};

const SOMETHING_WRONG_LABEL: Record<Language, string> = {
    en: 'Something\'s wrong', fr: 'Un problème', pt: 'Há um problema', es: 'Hay un problema', ar: 'هناك مشكلة'
};

const REPLY_HERE_LABEL: Record<Language, string> = {
    en: 'Reply here', fr: 'Répondre ici', pt: 'Responder aqui', es: 'Responder aquí', ar: 'الرد هنا'
};

const NOT_SORTED_LABEL: Record<Language, string> = {
    en: 'Not sorted', fr: 'Pas résolu', pt: 'Não resolvido', es: 'Sin resolver', ar: 'لم يُحل'
};

const NOT_THERE_LABEL: Record<Language, string> = {
    en: 'I was not there', fr: 'Je n\'étais pas là', pt: 'Não estava lá', es: 'No estaba allí', ar: 'لم أكن هناك'
};

/** ≤ 20 characters in every language — WhatsApp's reply-button cap. */
const REVIEW_CLOSURE_LABEL: Record<Language, string> = {
    en: 'Review the request', fr: 'Voir la demande', pt: 'Ver o pedido', es: 'Ver la solicitud', ar: 'مراجعة الطلب'
};

/**
 * Opens the bot's closure preview (ADR-A10). Placeholder-free, so it needs no
 * `templateFallback`: it always renders, in a chat and on the template alike.
 *
 * ⚠ **Written as a literal in the `token: '…'` shape on purpose, and PINNED to its builder.**
 * Two guards keep catalogue tokens alive and they need different things:
 *
 *   - `test:bot-surface` § 20's catalogue scan reads `token: '<literal>'` out of this file and
 *     runs each through the dispatcher's own `parseBotActionId` + `actionKeyOf`; its
 *     non-vacuity check requires every LIVE token to appear in that shape, so a
 *     `token: accountActionId(…)` call is invisible to it and fails the suite.
 *   - `accountActionId` owns the `acct:` grammar. `assertCustomerCatalogComplete` (boot)
 *     refuses to start if this literal and `accountActionId('close')` ever disagree, so the
 *     literal cannot drift from the builder — the hand-written-token failure (10 of 14 once
 *     went dead) is closed from both sides.
 */
const REVIEW_CLOSURE: QuickReplyDef = { token: 'acct:close', label: REVIEW_CLOSURE_LABEL };

const OPEN_MY_ACCOUNT_LABEL: Record<Language, string> = {
    en: 'Open my account',
    fr: 'Ouvrir mon compte',
    pt: 'Abrir a minha conta',
    es: 'Abrir mi cuenta',
    ar: 'فتح حسابي'
};

/**
 * The storefront's account-closure page. Owner-scoped, so under `shop/account/` (rule 3 of
 * this file's header). ⚠ Rule 4: this page must EXIST in `frontend/landing` before the
 * template is approved — record it in `api-doc/notifications/storefront-routes.md`.
 */
const CLOSURE_BUTTON: ButtonDef = {
    type: 'url',
    label: OPEN_MY_ACCOUNT_LABEL,
    urlSuffix: 'shop/account/closure'
};

const ADDRESS_WRONG_LABEL: Record<Language, string> = {
    en: 'My address is wrong', fr: 'Adresse incorrecte', pt: 'Morada errada', es: 'Dirección errónea', ar: 'العنوان خاطئ'
};

/*
 * ⚠ **"Where is it now" is deliberately absent.** It was drafted for
 * `order.delivery_failed` and removed before it shipped: that situation's link button is
 * `TRACK_BUTTON`, which already opens tracking and already says "Track delivery", so the tap
 * button was a second control for one intent. Recorded rather than silently deleted, because
 * the obvious next idea for a delivery message is a "where is it" button — and the answer is
 * that the message already has one.
 */

const TRY_PAYMENT_AGAIN: QuickReplyDef = { token: 'pay:rt:{{transactionId}}', label: TRY_AGAIN_LABEL, templateFallback: 'open:ol' };

/**
 * ⭐ **A booking's own Pay buttons — `bpay:`, never `pay:rt:`.** `pay:rt:`'s handler re-opens a
 * charge for ORDERS (`resolveCheckoutPayment` filters `cartId: { $ne: null }`) and a booking
 * transaction has no cart, so under `booking.payment_failed` it told the customer about their
 * orders. `bpay:` opens the booking payment screen; grammar owned by `bookingPayActionId` /
 * `parseBookingPayArgument` in `bot-action-id.ts`, which `test:inapp-bookings` parses these with.
 *
 * Two for the failure, ONE of which is ever drawn: the handler fills exactly one id, and an
 * empty placeholder drops its button — the conditional-button rule `renderCustomerQuickReplies`
 * documents. The label stays "Try again" for a failure.
 */
const RETRY_BOOKING_PRICE: QuickReplyDef = { token: 'bpay:{{payPriceBookingId}}', label: TRY_AGAIN_LABEL, templateFallback: 'open:bl' };
const RETRY_BOOKING_BALANCE: QuickReplyDef = { token: 'bpay:{{payBalanceBookingId}}:b', label: TRY_AGAIN_LABEL, templateFallback: 'open:bl' };
/** Reuses `PAY_BALANCE_LABEL` — the URL button's own words — rather than a second construction. */
const PAY_BOOKING_BALANCE: QuickReplyDef = { token: 'bpay:{{bookingId}}:b', label: PAY_BALANCE_LABEL, templateFallback: 'open:bl' };

/** ≤ 20 characters in every language — WhatsApp's reply-button cap. */
const SEE_DELIVERY_FEE_LABEL: Record<Language, string> = {
    en: 'See the new fee', fr: 'Voir les frais', pt: 'Ver a taxa', es: 'Ver la tarifa', ar: 'عرض الرسوم'
};

const PAY_DELIVERY_LABEL: Record<Language, string> = {
    en: 'Pay now', fr: 'Payer maintenant', pt: 'Pagar agora', es: 'Pagar ahora', ar: 'ادفع الآن'
};

/**
 * ⭐ **The delivery-fee change buttons (ADR-A11, W-H) carry the ORDER, never the proposal or a
 * figure.** The notifier's context holds `orderId` only (`customer-fee-notifier.ts`), and an
 * order-scoped tap re-reads the CURRENT change on the press — a notification is exactly the
 * button most likely to be pressed after the delivery company edited its figure. The tap draws
 * Accept · Decline (or Pay now · Decline); grammar owned by `deliveryFeeOrderActionId` /
 * `parseDeliveryFeeArgument`, and `assertCustomerCatalogComplete` pins these literals to it.
 * Out of window the template button falls back to `dfee:list` — every change waiting.
 */
const SEE_DELIVERY_FEE: QuickReplyDef = { token: 'dfee:{{orderId}}', label: SEE_DELIVERY_FEE_LABEL, templateFallback: 'dfee:list' };
const PAY_DELIVERY_TOPUP: QuickReplyDef = { token: 'dfee:{{orderId}}', label: PAY_DELIVERY_LABEL, templateFallback: 'dfee:list' };
const RETRY_DELIVERY_TOPUP: QuickReplyDef = { token: 'dfee:{{orderId}}', label: TRY_AGAIN_LABEL, templateFallback: 'dfee:list' };

// ─── Composed lines ──────────────────────────────────────────────────────────

/**
 * Why a delivery attempt failed, phrased for the CUSTOMER.
 *
 * The agent picks an operational code (`ShipmentFailureReason`); this is not that
 * code translated, it is what the person waiting at home should be told. Three
 * rules shaped the wording:
 *
 *  - **Never accuse.** `customer_refused` becomes "the delivery was declined at
 *    the door", not "you refused it". The agent may have mis-tagged it, and the
 *    customer is the one who would have to argue about it.
 *  - **Never blame them for a reason they cannot act on.** `address_not_found`
 *    says we could not find it, which is at least actionable.
 *  - **`other` is deliberately generic.** The agent's free-text `note` is an
 *    internal operational field written for a dispatcher — it is unbounded in
 *    tone and never shown to the customer.
 *
 * `unknown` covers a reason-less report: the agent may record `failed` without
 * choosing a reason at all (`reason: null` on the model).
 */
export type DeliveryFailureLineKey = ShipmentFailureReason | 'unknown';

export const DELIVERY_FAILURE_LINE: Record<DeliveryFailureLineKey, Record<Language, string>> = {
    customer_unreachable: {
        en: 'We could not reach you by phone.',
        fr: 'Nous n\'avons pas pu vous joindre par téléphone.',
        pt: 'Não conseguimos contactá-lo por telefone.',
        es: 'No pudimos contactarte por teléfono.',
        ar: 'لم نتمكن من الوصول إليك عبر الهاتف.'
    },
    customer_absent: {
        en: 'There was nobody at the address.',
        fr: 'Personne n\'était présent à l\'adresse.',
        pt: 'Não estava ninguém na morada.',
        es: 'No había nadie en la dirección.',
        ar: 'لم يكن هناك أحد في العنوان.'
    },
    customer_refused: {
        en: 'The delivery was declined at the door.',
        fr: 'La livraison a été refusée à la porte.',
        pt: 'A entrega foi recusada à porta.',
        es: 'La entrega fue rechazada en la puerta.',
        ar: 'تم رفض التسليم عند الباب.'
    },
    address_not_found: {
        en: 'We could not find the delivery address.',
        fr: 'Nous n\'avons pas trouvé l\'adresse de livraison.',
        pt: 'Não conseguimos encontrar a morada de entrega.',
        es: 'No pudimos encontrar la dirección de entrega.',
        ar: 'لم نتمكن من العثور على عنوان التسليم.'
    },
    address_inaccessible: {
        en: 'The address could not be reached.',
        fr: 'L\'adresse était inaccessible.',
        pt: 'Não foi possível aceder à morada.',
        es: 'No se pudo acceder a la dirección.',
        ar: 'تعذر الوصول إلى العنوان.'
    },
    payment_refused: {
        en: 'The cash payment was not completed at the door.',
        fr: 'Le paiement en espèces n\'a pas été effectué à la livraison.',
        pt: 'O pagamento em dinheiro não foi concluído na entrega.',
        es: 'El pago en efectivo no se completó en la entrega.',
        ar: 'لم يكتمل الدفع النقدي عند التسليم.'
    },
    package_damaged: {
        en: 'The package was damaged, so we held it back rather than hand it over.',
        fr: 'Le colis était endommagé, nous l\'avons donc retenu plutôt que de vous le remettre.',
        pt: 'A encomenda estava danificada, por isso retivemo-la em vez de a entregar.',
        es: 'El paquete estaba dañado, así que lo retuvimos en lugar de entregarlo.',
        ar: 'كان الطرد تالفًا، لذا احتفظنا به بدلاً من تسليمه.'
    },
    rescheduled_by_customer: {
        en: 'You asked us to deliver at another time.',
        fr: 'Vous nous avez demandé de livrer à un autre moment.',
        pt: 'Pediu-nos para entregar noutra altura.',
        es: 'Nos pediste entregar en otro momento.',
        ar: 'طلبت منا التسليم في وقت آخر.'
    },
    other: {
        en: 'The delivery could not be completed.',
        fr: 'La livraison n\'a pas pu être effectuée.',
        pt: 'Não foi possível concluir a entrega.',
        es: 'No se pudo completar la entrega.',
        ar: 'تعذر إتمام التسليم.'
    },
    unknown: {
        en: 'The delivery could not be completed.',
        fr: 'La livraison n\'a pas pu être effectuée.',
        pt: 'Não foi possível concluir a entrega.',
        es: 'No se pudo completar la entrega.',
        ar: 'تعذر إتمام التسليم.'
    }
};

/** The customer-facing failure sentence for a reason, defaulting to the generic one. */
export function deliveryFailureLine(
    reason: ShipmentFailureReason | null | undefined,
    lang: Language
): string {
    const key: DeliveryFailureLineKey = reason ?? 'unknown';
    const variants = DELIVERY_FAILURE_LINE[key] ?? DELIVERY_FAILURE_LINE.unknown;
    return variants[lang] ?? variants[DEFAULT_LANGUAGE];
}

const COD_LINE: Record<Language, string> = {
    en: 'This order is cash on delivery — please have {{currency}} {{amountFormatted}} ready.',
    fr: 'Cette commande est payable à la livraison — préparez {{currency}} {{amountFormatted}}.',
    pt: 'Esta encomenda é paga na entrega — tenha {{currency}} {{amountFormatted}} prontos.',
    es: 'Este pedido se paga contra entrega — ten {{currency}} {{amountFormatted}} preparados.',
    ar: 'هذا الطلب دفع عند الاستلام — يرجى تجهيز {{currency}} {{amountFormatted}}.'
};

/**
 * The "have cash ready" sentence for a COD order, or empty for a prepaid one.
 *
 * The whole point of the out-for-delivery message is to get someone to the door;
 * for a COD order, getting them there without the money is a wasted trip and a
 * `payment_refused` failure.
 */
export function codReadyLine(
    isCod: boolean,
    amount: number,
    currency: string,
    lang: Language
): string {
    if (!isCod || amount <= 0) return '';
    const template = COD_LINE[lang] ?? COD_LINE[DEFAULT_LANGUAGE];
    return renderTemplate(template, {
        currency,
        amountFormatted: new Intl.NumberFormat('en-US').format(Math.round(amount))
    });
}

const DELIVERY_FEE_CASH_LINE: Record<Language, string> = {
    en: 'Your items are paid — please have {{currency}} {{amountFormatted}} ready in cash for the delivery fee.',
    fr: 'Vos articles sont payés — préparez {{currency}} {{amountFormatted}} en espèces pour les frais de livraison.',
    pt: 'Os seus artigos estão pagos — tenha {{currency}} {{amountFormatted}} em dinheiro prontos para a taxa de entrega.',
    es: 'Tus artículos están pagados — ten {{currency}} {{amountFormatted}} en efectivo preparados para la tarifa de envío.',
    ar: 'تم دفع منتجاتك — يرجى تجهيز {{currency}} {{amountFormatted}} نقدًا لرسوم التوصيل.'
};

/**
 * The "have the delivery fee ready in cash" sentence for a parcel of an ONLINE order whose
 * delivery fee is paid to the rider (ADR-A11 § Cash for delivery, W-F), or empty. Rendered into
 * the same `codLine` slot as `codReadyLine` — an order is one or the other, never both.
 */
export function deliveryFeeCashReadyLine(amount: number, currency: string, lang: Language): string {
    if (!(amount > 0)) return '';
    const template = DELIVERY_FEE_CASH_LINE[lang] ?? DELIVERY_FEE_CASH_LINE[DEFAULT_LANGUAGE];
    return renderTemplate(template, {
        currency,
        amountFormatted: new Intl.NumberFormat('en-US').format(Math.round(amount))
    });
}

const REOPEN_LINE: Record<Language, string> = {
    en: 'If that is not right, reply on the request and we will pick it back up.',
    fr: 'Si ce n\'est pas réglé, répondez sur la demande et nous la reprendrons.',
    pt: 'Se não estiver resolvido, responda no pedido e voltamos a tratá-lo.',
    es: 'Si no es correcto, responde en la solicitud y la retomamos.',
    ar: 'إذا لم يكن الأمر كذلك، فردّ على الطلب وسنعاود النظر فيه.'
};

const CLOSED_LINE: Record<Language, string> = {
    en: 'This one is now closed — start a new request if you need anything else.',
    fr: 'Celle-ci est désormais close — ouvrez une nouvelle demande si vous avez besoin d\'autre chose.',
    pt: 'Este ficou fechado — abra um novo pedido se precisar de mais alguma coisa.',
    es: 'Esta ya está cerrada — abre una nueva solicitud si necesitas algo más.',
    ar: 'تم إغلاق هذا الطلب — افتح طلبًا جديدًا إذا احتجت أي شيء آخر.'
};

/**
 * What a customer may still do with a request that just reached a terminal status.
 *
 * `resolved` and `closed` are both terminal and are NOT interchangeable here: a resolved
 * request can be reopened by replying, a closed one cannot. Telling somebody to "reply if
 * this is not sorted" on a closed request sends them somewhere that will not answer, which
 * is worse than saying nothing — it is the platform promising a route it has shut.
 *
 * ⚠ **Returns a whole sentence, never an empty string** — unlike `codReadyLine`, whose
 * absence is a legitimate state. This one always has something true to say, and an empty
 * value would leave a WhatsApp template parameter blank, which Meta rejects outright.
 */
export function ticketReopenLine(isClosed: boolean, lang: Language): string {
    const variants = isClosed ? CLOSED_LINE : REOPEN_LINE;
    return variants[lang] ?? variants[DEFAULT_LANGUAGE];
}

// ─── Refund lines (REFUND-FLOW-PLAN § 8, R-3) ─────────────────────────────────

/** What the customer receives when a transfer fee was taken — the R-3 fee line. */
const REFUND_AMOUNT_WITH_FEE_LINE: Record<Language, string> = {
    en: 'You receive {{net}} {{currency}} ({{gross}} minus a {{percent}}% transfer fee).',
    fr: 'Vous recevez {{net}} {{currency}} ({{gross}} moins des frais de transfert de {{percent}} %).',
    pt: 'Recebe {{net}} {{currency}} ({{gross}} menos uma taxa de transferência de {{percent}}%).',
    es: 'Recibes {{net}} {{currency}} ({{gross}} menos una comisión de transferencia del {{percent}} %).',
    ar: 'ستستلم {{net}} {{currency}} ({{gross}} مطروحًا منها رسوم تحويل بنسبة {{percent}}٪).'
};

/** …and when none was (a card refund, or a fee rate set to 0). */
const REFUND_AMOUNT_NO_FEE_LINE: Record<Language, string> = {
    en: 'You receive {{net}} {{currency}}.',
    fr: 'Vous recevez {{net}} {{currency}}.',
    pt: 'Recebe {{net}} {{currency}}.',
    es: 'Recibes {{net}} {{currency}}.',
    ar: 'ستستلم {{net}} {{currency}}.'
};

/**
 * "You receive 4,900 XAF (5,000 minus a 2% transfer fee)." — what reaches the customer, and why
 * it is less than the refund (R-3: 2% off every refund paid by transfer; D-1: paid externally too).
 *
 * ⚠ **Returns a whole sentence, never an empty string**, like `ticketReopenLine`: it is a WhatsApp
 * template parameter, and Meta refuses an empty one. With no fee it says only what is received —
 * a card refund never mentions a fee, because there is none (Stripe returns the full amount).
 */
export function refundAmountLine(
    input: { netAmount: number; grossAmount: number; feeAmount: number; feePercent: number; currency: string },
    lang: Language
): string {
    const fmt = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n));
    const variants = input.feeAmount > 0 ? REFUND_AMOUNT_WITH_FEE_LINE : REFUND_AMOUNT_NO_FEE_LINE;
    return renderTemplate(variants[lang] ?? variants[DEFAULT_LANGUAGE], {
        net: fmt(input.netAmount),
        gross: fmt(input.grossAmount),
        percent: String(input.feePercent),
        currency: input.currency
    });
}

/** Where a transfer goes when the number is unknown to the copy — never an empty parameter. */
const REFUND_DESTINATION_FALLBACK: Record<Language, string> = {
    en: 'your mobile money number',
    fr: 'votre numéro mobile money',
    pt: 'o seu número de dinheiro móvel',
    es: 'tu número de dinero móvil',
    ar: 'رقم محفظتك المالية'
};

/** The masked number a refund goes to (`+•••••••••512`), or a localized fallback. */
export function refundDestinationLabel(masked: string | null | undefined, lang: Language): string {
    return masked && masked.trim() !== ''
        ? masked
        : REFUND_DESTINATION_FALLBACK[lang] ?? REFUND_DESTINATION_FALLBACK[DEFAULT_LANGUAGE];
}

// ─── The catalog ─────────────────────────────────────────────────────────────

export const CUSTOMER_NOTIFICATION_CATALOG: Record<CustomerNotificationType, CustomerSituationMessages> = {
    // ══ Bookings ═════════════════════════════════════════════════════════════

    // `{{confirmationLine}}` is substituted by the handler, already localized,
    // because whether this booking is confirmed or waiting depends on the
    // vendor's booking mode and the customer must not have to guess which.
    'booking.created': {
        base: {
            en: {
                subject: 'Booking requested: {{serviceName}}',
                body: 'You booked {{serviceName}} with {{vendorName}} for {{startAt}}. {{confirmationLine}}'
            },
            fr: {
                subject: 'Réservation demandée : {{serviceName}}',
                body: 'Vous avez réservé {{serviceName}} chez {{vendorName}} pour le {{startAt}}. {{confirmationLine}}'
            },
            pt: {
                subject: 'Reserva solicitada: {{serviceName}}',
                body: 'Reservou {{serviceName}} com {{vendorName}} para {{startAt}}. {{confirmationLine}}'
            },
            es: {
                subject: 'Reserva solicitada: {{serviceName}}',
                body: 'Reservaste {{serviceName}} con {{vendorName}} para el {{startAt}}. {{confirmationLine}}'
            },
            ar: {
                subject: 'تم طلب الحجز: {{serviceName}}',
                body: 'لقد حجزت {{serviceName}} مع {{vendorName}} في {{startAt}}. {{confirmationLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_created',
                bodyParams: ['{{serviceName}}', '{{vendorName}}', '{{startAt}}']
            }
        },
        button: BOOKING_BUTTON
    },

    'booking.confirmed': {
        base: {
            en: {
                subject: 'Booking confirmed: {{serviceName}}',
                body: '{{vendorName}} accepted your booking for {{serviceName}} on {{startAt}}. It is now confirmed — see you then.'
            },
            fr: {
                subject: 'Réservation confirmée : {{serviceName}}',
                body: '{{vendorName}} a accepté votre réservation pour {{serviceName}} le {{startAt}}. Elle est confirmée — à bientôt.'
            },
            pt: {
                subject: 'Reserva confirmada: {{serviceName}}',
                body: '{{vendorName}} aceitou a sua reserva de {{serviceName}} em {{startAt}}. Está confirmada — até lá.'
            },
            es: {
                subject: 'Reserva confirmada: {{serviceName}}',
                body: '{{vendorName}} aceptó tu reserva de {{serviceName}} el {{startAt}}. Está confirmada — nos vemos.'
            },
            ar: {
                subject: 'تم تأكيد الحجز: {{serviceName}}',
                body: 'قبلت {{vendorName}} حجزك لـ {{serviceName}} في {{startAt}}. تم التأكيد — نراك حينها.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_confirmed',
                bodyParams: ['{{vendorName}}', '{{serviceName}}', '{{startAt}}']
            }
        },
        button: BOOKING_BUTTON
    },

    // Both the old and the new time, always. A message carrying only the new one
    // is unverifiable — the customer cannot tell it apart from a duplicate.
    'booking.rescheduled': {
        base: {
            en: {
                subject: 'Booking moved: {{serviceName}}',
                body: 'Your {{serviceName}} booking has moved from {{previousStartAt}} to {{startAt}}. If that does not work for you, you can cancel or move it again.'
            },
            fr: {
                subject: 'Réservation déplacée : {{serviceName}}',
                body: 'Votre réservation {{serviceName}} est passée du {{previousStartAt}} au {{startAt}}. Si cela ne vous convient pas, vous pouvez l\'annuler ou la déplacer.'
            },
            pt: {
                subject: 'Reserva alterada: {{serviceName}}',
                body: 'A sua reserva de {{serviceName}} passou de {{previousStartAt}} para {{startAt}}. Se não lhe der jeito, pode cancelar ou alterar de novo.'
            },
            es: {
                subject: 'Reserva movida: {{serviceName}}',
                body: 'Tu reserva de {{serviceName}} pasó del {{previousStartAt}} al {{startAt}}. Si no te viene bien, puedes cancelarla o moverla otra vez.'
            },
            ar: {
                subject: 'تم نقل الحجز: {{serviceName}}',
                body: 'تم نقل حجزك لـ {{serviceName}} من {{previousStartAt}} إلى {{startAt}}. إذا لم يناسبك ذلك، يمكنك الإلغاء أو النقل مرة أخرى.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_rescheduled',
                bodyParams: ['{{serviceName}}', '{{previousStartAt}}', '{{startAt}}']
            }
        },
        button: BOOKING_BUTTON,
        actions: [
            /**
             * ⛔ **"That works" (`yes:bkmove:`) WITHDRAWN** — `yes` is sub-dispatched and no
             * stream registers `bkmove`, so the tap reached the unknown-action refusal. The
             * token shape is correct, so this is a registration away: re-add it unchanged the
             * moment the bookings owner claims the key.
             *
             * ⚠ **"Ask to change" carries `tkt:new`, NOT `tkt:new:bk:<bookingId>`.** The
             * ticket parser's topic codes are `rd`/`ad`/`hp` and its third segment must be an
             * ORDER id, so a booking topic does not exist — and passing a booking id where an
             * order id is expected would have been worse than a refusal, since it parses.
             * `tkt:new` opens the support form with nothing pre-selected: it loses the
             * pre-fill, not the button. It also carries no placeholder, so it can never render
             * empty.
             */
            { token: 'tkt:new', label: ASK_TO_CHANGE_LABEL }
        ]
    },

    // `{{refundLine}}` is substituted by the handler: a paid booking must say
    // where the money went in the SAME message, not a separate one that may
    // arrive later or not at all.
    'booking.cancelled': {
        base: {
            en: {
                subject: 'Booking cancelled: {{serviceName}}',
                body: 'Your {{serviceName}} booking on {{startAt}} was cancelled by {{cancelledBy}}. {{refundLine}}'
            },
            fr: {
                subject: 'Réservation annulée : {{serviceName}}',
                body: 'Votre réservation {{serviceName}} du {{startAt}} a été annulée par {{cancelledBy}}. {{refundLine}}'
            },
            pt: {
                subject: 'Reserva cancelada: {{serviceName}}',
                body: 'A sua reserva de {{serviceName}} em {{startAt}} foi cancelada por {{cancelledBy}}. {{refundLine}}'
            },
            es: {
                subject: 'Reserva cancelada: {{serviceName}}',
                body: 'Tu reserva de {{serviceName}} del {{startAt}} fue cancelada por {{cancelledBy}}. {{refundLine}}'
            },
            ar: {
                subject: 'تم إلغاء الحجز: {{serviceName}}',
                body: 'تم إلغاء حجزك لـ {{serviceName}} في {{startAt}} بواسطة {{cancelledBy}}. {{refundLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_cancelled',
                bodyParams: ['{{serviceName}}', '{{startAt}}', '{{cancelledBy}}']
            }
        },
        button: BOOKING_BUTTON,
        actions: [{ token: 'book:{{productId}}', label: BOOK_AGAIN_LABEL, templateFallback: 'open:bl' }]
    },

    'booking.completed': {
        base: {
            en: {
                subject: 'Thanks for visiting {{vendorName}}',
                body: 'Your {{serviceName}} booking is complete. Final price: {{currency}} {{finalPriceFormatted}}. {{balanceLine}}'
            },
            fr: {
                subject: 'Merci de votre visite chez {{vendorName}}',
                body: 'Votre réservation {{serviceName}} est terminée. Prix final : {{currency}} {{finalPriceFormatted}}. {{balanceLine}}'
            },
            pt: {
                subject: 'Obrigado por visitar {{vendorName}}',
                body: 'A sua reserva de {{serviceName}} está concluída. Preço final: {{currency}} {{finalPriceFormatted}}. {{balanceLine}}'
            },
            es: {
                subject: 'Gracias por visitar {{vendorName}}',
                body: 'Tu reserva de {{serviceName}} está completa. Precio final: {{currency}} {{finalPriceFormatted}}. {{balanceLine}}'
            },
            ar: {
                subject: 'شكرًا لزيارتك {{vendorName}}',
                body: 'اكتمل حجزك لـ {{serviceName}}. السعر النهائي: {{currency}} {{finalPriceFormatted}}. {{balanceLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_completed',
                bodyParams: ['{{serviceName}}', '{{vendorName}}', '{{currency}}', '{{finalPriceFormatted}}']
            }
        },
        button: BOOKING_BUTTON
    },

    // The message that stops a `no-show` being recorded against someone who
    // simply forgot. `{{whenPhrase}}` is a pre-localized "tomorrow at 14:00" /
    // "in 2 hours" — a bare timestamp is exactly what a forgetful reader skims.
    'booking.reminder': {
        base: {
            en: {
                subject: 'Reminder: {{serviceName}} {{whenPhrase}}',
                body: 'Your {{serviceName}} booking with {{vendorName}} is {{whenPhrase}} ({{startAt}}). If you cannot make it, please cancel so the slot can go to someone else.'
            },
            fr: {
                subject: 'Rappel : {{serviceName}} {{whenPhrase}}',
                body: 'Votre réservation {{serviceName}} chez {{vendorName}} est {{whenPhrase}} ({{startAt}}). Si vous ne pouvez pas venir, annulez pour libérer le créneau.'
            },
            pt: {
                subject: 'Lembrete: {{serviceName}} {{whenPhrase}}',
                body: 'A sua reserva de {{serviceName}} com {{vendorName}} é {{whenPhrase}} ({{startAt}}). Se não puder ir, cancele para libertar o horário.'
            },
            es: {
                subject: 'Recordatorio: {{serviceName}} {{whenPhrase}}',
                body: 'Tu reserva de {{serviceName}} con {{vendorName}} es {{whenPhrase}} ({{startAt}}). Si no puedes ir, cancélala para liberar el hueco.'
            },
            ar: {
                subject: 'تذكير: {{serviceName}} {{whenPhrase}}',
                body: 'حجزك لـ {{serviceName}} مع {{vendorName}} هو {{whenPhrase}} ({{startAt}}). إذا تعذر عليك الحضور، فيرجى الإلغاء ليستفيد شخص آخر من الموعد.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_reminder',
                bodyParams: ['{{serviceName}}', '{{vendorName}}', '{{startAt}}', '{{whenPhrase}}']
            }
        },
        button: BOOKING_BUTTON
    },

    'booking.payment.received': {
        base: {
            en: {
                subject: 'Payment received: {{currency}} {{amountFormatted}}',
                body: 'We received your {{currency}} {{amountFormatted}} payment for {{serviceName}} on {{startAt}}. Nothing else to do — see you then.'
            },
            fr: {
                subject: 'Paiement reçu : {{currency}} {{amountFormatted}}',
                body: 'Nous avons reçu votre paiement de {{currency}} {{amountFormatted}} pour {{serviceName}} le {{startAt}}. Rien d\'autre à faire — à bientôt.'
            },
            pt: {
                subject: 'Pagamento recebido: {{currency}} {{amountFormatted}}',
                body: 'Recebemos o seu pagamento de {{currency}} {{amountFormatted}} por {{serviceName}} em {{startAt}}. Nada mais a fazer — até lá.'
            },
            es: {
                subject: 'Pago recibido: {{currency}} {{amountFormatted}}',
                body: 'Recibimos tu pago de {{currency}} {{amountFormatted}} por {{serviceName}} el {{startAt}}. Nada más que hacer — nos vemos.'
            },
            ar: {
                subject: 'تم استلام الدفعة: {{currency}} {{amountFormatted}}',
                body: 'استلمنا دفعتك بقيمة {{currency}} {{amountFormatted}} مقابل {{serviceName}} في {{startAt}}. لا شيء آخر مطلوب — نراك حينها.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_payment_received',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{serviceName}}', '{{startAt}}']
            }
        },
        button: BOOKING_BUTTON
    },

    /**
     * ⭐ **A BALANCE paid after the appointment — the last silence in the booking payment set.**
     *
     * `handleBookingPaymentReceived` returned early on `purpose === 'booking_balance'`, so a
     * customer who had just paid the outstanding amount was told **nothing at all**. The early
     * return was not careless: `booking.payment.received` ends *"Nothing else to do — see you
     * then"*, and a balance is settled AFTER the service, so reusing it would have promised an
     * appointment that already happened. The fix is a second situation, not a looser sentence.
     *
     * Three rules the copy obeys:
     *   - ⚠ **No future tense and no `{{startAt}}`.** The appointment is over; every word here
     *     is about money that has arrived.
     *   - ⚠ **It says the account is SETTLED**, which is the customer's actual question — the
     *     balance request (`booking.balance.due`) is the only message that ever asked them for
     *     more, and this is its closing half.
     *   - It names the amount, because a partial balance payment is possible and the figure is
     *     what tells the two apart.
     *
     * ⚠ **Its template is NOT approved** (stage 2). Out of window this cannot be delivered on
     * WhatsApp until `customer_booking_balance_received` is submitted — the same state
     * `customer_booking_payment_failed` is in. In window, and on Telegram, it works today.
     */
    'booking.balance.received': {
        base: {
            en: {
                subject: 'Balance paid: {{currency}} {{amountFormatted}}',
                body: 'We received your {{currency}} {{amountFormatted}} balance payment for {{serviceName}}. Your booking is now fully paid — thank you.'
            },
            fr: {
                subject: 'Solde payé : {{currency}} {{amountFormatted}}',
                body: 'Nous avons reçu votre paiement de solde de {{currency}} {{amountFormatted}} pour {{serviceName}}. Votre réservation est désormais entièrement payée — merci.'
            },
            pt: {
                subject: 'Saldo pago: {{currency}} {{amountFormatted}}',
                body: 'Recebemos o seu pagamento de saldo de {{currency}} {{amountFormatted}} por {{serviceName}}. A sua reserva está totalmente paga — obrigado.'
            },
            es: {
                subject: 'Saldo pagado: {{currency}} {{amountFormatted}}',
                body: 'Recibimos tu pago de saldo de {{currency}} {{amountFormatted}} por {{serviceName}}. Tu reserva está totalmente pagada — gracias.'
            },
            ar: {
                subject: 'تم دفع الرصيد: {{currency}} {{amountFormatted}}',
                body: 'استلمنا دفعة الرصيد بقيمة {{currency}} {{amountFormatted}} مقابل {{serviceName}}. حجزك مدفوع بالكامل الآن — شكرًا لك.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_balance_received',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{serviceName}}']
            }
        },
        button: BOOKING_BUTTON
    },

    /**
     * ⚠ **The silence `order.payment_failed` closed, one product type over.** An online booking
     * payment was never announced either way: success published an event only the vendor heard,
     * and a failure published nothing. The customer turned up for an appointment the vendor saw as
     * unpaid, having been told nothing at all.
     *
     * ⚠ **ONE sentence, true for the original price AND for a balance paid later** — which is why
     * it carries no `{{startAt}}` and no "see you then". A balance is paid after the appointment
     * has happened, and a line about the future would be false for exactly the payment that most
     * needs to be clear. (`booking.payment.received` has that problem, which is why balances do
     * not reuse it — see the handler.)
     *
     * The same three rules as the order entry, each load-bearing:
     *   - **It never says cancelled** — a failed charge cancels nothing.
     *   - **It blames nobody** — the usual causes are an unapproved prompt and a timeout.
     *   - **It names the amount and the service**, and says nothing was charged, which is the
     *     customer's actual first question.
     *
     * ⚠ **A WhatsApp TEMPLATE, because it fires outside the 24-hour window**: the charge is
     * approved on a handset minutes after the customer last wrote. Generated locally only; nothing
     * is submitted to Meta from here.
     */
    'booking.payment_failed': {
        base: {
            en: {
                subject: 'Payment did not go through for {{serviceName}}',
                body: 'We could not take the {{currency}} {{amountFormatted}} for your {{serviceName}} booking. Nothing has been charged — open the booking to try again.'
            },
            fr: {
                subject: 'Paiement non abouti pour {{serviceName}}',
                body: "Nous n'avons pas pu encaisser les {{currency}} {{amountFormatted}} pour votre réservation {{serviceName}}. Rien n'a été débité — ouvrez la réservation pour réessayer."
            },
            pt: {
                subject: 'O pagamento não foi concluído para {{serviceName}}',
                body: 'Não conseguimos cobrar os {{currency}} {{amountFormatted}} da sua reserva de {{serviceName}}. Nada foi debitado — abra a reserva para tentar de novo.'
            },
            es: {
                subject: 'El pago no se completó para {{serviceName}}',
                body: 'No pudimos cobrar los {{currency}} {{amountFormatted}} de tu reserva de {{serviceName}}. No se ha cobrado nada — abre la reserva para intentarlo otra vez.'
            },
            ar: {
                subject: 'لم يتم الدفع لحجز {{serviceName}}',
                body: 'لم نتمكن من تحصيل {{currency}} {{amountFormatted}} لحجز {{serviceName}}. لم يُخصم أي مبلغ — افتح الحجز لإعادة المحاولة.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_payment_failed',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{serviceName}}']
            }
        },
        button: BOOKING_BUTTON,
        actions: [RETRY_BOOKING_PRICE, RETRY_BOOKING_BALANCE]
    },

    // The platform never charges this silently — this message IS the request, so
    // it has to explain WHY more is owed, not just that it is.
    'booking.balance.due': {
        base: {
            en: {
                subject: 'Balance due: {{currency}} {{balanceFormatted}}',
                body: '{{vendorName}} settled your {{serviceName}} booking at {{currency}} {{finalPriceFormatted}}, which is {{currency}} {{balanceFormatted}} more than you have paid. {{reasonLine}} You can pay the balance here, or settle it directly with {{vendorName}}.'
            },
            fr: {
                subject: 'Solde à payer : {{currency}} {{balanceFormatted}}',
                body: '{{vendorName}} a clôturé votre réservation {{serviceName}} à {{currency}} {{finalPriceFormatted}}, soit {{currency}} {{balanceFormatted}} de plus que ce que vous avez payé. {{reasonLine}} Vous pouvez payer le solde ici ou directement auprès de {{vendorName}}.'
            },
            pt: {
                subject: 'Saldo em dívida: {{currency}} {{balanceFormatted}}',
                body: '{{vendorName}} fechou a sua reserva de {{serviceName}} em {{currency}} {{finalPriceFormatted}}, ou seja {{currency}} {{balanceFormatted}} acima do que pagou. {{reasonLine}} Pode pagar o saldo aqui ou diretamente a {{vendorName}}.'
            },
            es: {
                subject: 'Saldo pendiente: {{currency}} {{balanceFormatted}}',
                body: '{{vendorName}} cerró tu reserva de {{serviceName}} en {{currency}} {{finalPriceFormatted}}, que es {{currency}} {{balanceFormatted}} más de lo que pagaste. {{reasonLine}} Puedes pagar el saldo aquí o directamente con {{vendorName}}.'
            },
            ar: {
                subject: 'رصيد مستحق: {{currency}} {{balanceFormatted}}',
                body: 'أنهت {{vendorName}} حجزك لـ {{serviceName}} بمبلغ {{currency}} {{finalPriceFormatted}}، أي {{currency}} {{balanceFormatted}} أكثر مما دفعت. {{reasonLine}} يمكنك دفع الرصيد هنا أو مباشرة مع {{vendorName}}.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_balance_due',
                bodyParams: ['{{vendorName}}', '{{serviceName}}', '{{currency}}', '{{balanceFormatted}}', '{{finalPriceFormatted}}']
            }
        },
        /**
         * The URL button stays — it is what email, the inbox and the approved WhatsApp TEMPLATE
         * carry (a template's buttons are frozen at approval and only that URL button is sent
         * outside the window). The quick reply is the in-chat door: the storefront page needs a
         * web session a chat customer does not have.
         */
        button: PAY_BALANCE_BUTTON,
        actions: [PAY_BOOKING_BALANCE]
    },

    'booking.refunded': {
        base: {
            en: {
                subject: 'Refunded: {{currency}} {{amountFormatted}}',
                body: 'We have refunded {{currency}} {{amountFormatted}} for your cancelled {{serviceName}} booking. It goes back to the way you paid, and usually appears within a few working days.'
            },
            fr: {
                subject: 'Remboursé : {{currency}} {{amountFormatted}}',
                body: 'Nous avons remboursé {{currency}} {{amountFormatted}} pour votre réservation {{serviceName}} annulée. Le montant retourne par votre moyen de paiement et apparaît généralement sous quelques jours ouvrés.'
            },
            pt: {
                subject: 'Reembolsado: {{currency}} {{amountFormatted}}',
                body: 'Reembolsámos {{currency}} {{amountFormatted}} pela sua reserva cancelada de {{serviceName}}. Volta pelo mesmo meio de pagamento e costuma aparecer em poucos dias úteis.'
            },
            es: {
                subject: 'Reembolsado: {{currency}} {{amountFormatted}}',
                body: 'Hemos reembolsado {{currency}} {{amountFormatted}} por tu reserva cancelada de {{serviceName}}. Vuelve por tu medio de pago y suele aparecer en unos días hábiles.'
            },
            ar: {
                subject: 'تم الاسترداد: {{currency}} {{amountFormatted}}',
                body: 'قمنا برد {{currency}} {{amountFormatted}} مقابل حجزك الملغى لـ {{serviceName}}. يعود المبلغ بنفس طريقة الدفع وعادة ما يظهر خلال أيام عمل قليلة.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_refunded',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{serviceName}}']
            }
        },
        button: BOOKING_BUTTON
    },

    // LEGACY name (its WhatsApp template is already submitted to Meta — keep it). Since
    // 2026-10-05 `refund_pending` means "a refund request is open" (REFUND-FLOW-PLAN § 4), so the
    // copy no longer promises a person paying it by hand. Unreachable today: refund news comes
    // from the request's own situations (`booking.refund.requested` and the rest, below).
    'booking.refund.pending': {
        base: {
            en: {
                subject: 'Refund on the way: {{currency}} {{amountFormatted}}',
                body: 'We owe you {{currency}} {{amountFormatted}} for your cancelled {{serviceName}} booking. A refund request is open — you do not need to do anything, and we will tell you when the money is sent.'
            },
            fr: {
                subject: 'Remboursement en cours : {{currency}} {{amountFormatted}}',
                body: 'Nous vous devons {{currency}} {{amountFormatted}} pour votre réservation {{serviceName}} annulée. Une demande de remboursement est ouverte : vous n\'avez rien à faire, nous vous préviendrons dès que l\'argent sera envoyé.'
            },
            pt: {
                subject: 'Reembolso a caminho: {{currency}} {{amountFormatted}}',
                body: 'Devemos-lhe {{currency}} {{amountFormatted}} pela sua reserva cancelada de {{serviceName}}. Há um pedido de reembolso aberto — não precisa de fazer nada e avisamos quando o dinheiro for enviado.'
            },
            es: {
                subject: 'Reembolso en camino: {{currency}} {{amountFormatted}}',
                body: 'Te debemos {{currency}} {{amountFormatted}} por tu reserva cancelada de {{serviceName}}. Hay una solicitud de reembolso abierta — no tienes que hacer nada y te avisaremos cuando se envíe el dinero.'
            },
            ar: {
                subject: 'الاسترداد في الطريق: {{currency}} {{amountFormatted}}',
                body: 'ندين لك بمبلغ {{currency}} {{amountFormatted}} مقابل حجزك الملغى لـ {{serviceName}}. يوجد طلب استرداد مفتوح — لا داعي لفعل أي شيء وسنخبرك عند إرسال المبلغ.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_refund_pending',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{serviceName}}']
            }
        },
        button: BOOKING_BUTTON
    },

    // ── The refund request lifecycle (REFUND-FLOW-PLAN § 8, R9) ─────────────────
    // Raised from `refund.status_changed` (requested · sending · declined) and `payment.refunded`
    // (completed · paid externally). A card refund that completes keeps `booking.refunded` above —
    // full amount, no fee. `{{amountLine}}` is `refundAmountLine`: the NET and, when a transfer fee
    // was taken, the 2% line. A booking is never cash on delivery, so it has no "waiting for cash".

    'booking.refund.requested': {
        base: {
            en: {
                subject: 'Refund requested: {{currency}} {{amountFormatted}}',
                body: 'A refund of {{currency}} {{amountFormatted}} has been requested for your {{serviceName}} booking. Our team is reviewing it — you do not need to do anything, and we will tell you when it is sent.'
            },
            fr: {
                subject: 'Remboursement demandé : {{currency}} {{amountFormatted}}',
                body: 'Un remboursement de {{currency}} {{amountFormatted}} a été demandé pour votre réservation {{serviceName}}. Notre équipe l’examine — vous n’avez rien à faire, nous vous préviendrons dès qu’il sera envoyé.'
            },
            pt: {
                subject: 'Reembolso pedido: {{currency}} {{amountFormatted}}',
                body: 'Foi pedido um reembolso de {{currency}} {{amountFormatted}} pela sua reserva de {{serviceName}}. A nossa equipa está a analisá-lo — não precisa de fazer nada e avisamos quando for enviado.'
            },
            es: {
                subject: 'Reembolso solicitado: {{currency}} {{amountFormatted}}',
                body: 'Se ha solicitado un reembolso de {{currency}} {{amountFormatted}} por tu reserva de {{serviceName}}. Nuestro equipo lo está revisando — no tienes que hacer nada y te avisaremos cuando se envíe.'
            },
            ar: {
                subject: 'تم طلب الاسترداد: {{currency}} {{amountFormatted}}',
                body: 'تم طلب استرداد {{currency}} {{amountFormatted}} لحجزك لـ {{serviceName}}. يقوم فريقنا بمراجعته — لا داعي لفعل أي شيء وسنخبرك عند إرساله.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_refund_requested',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{serviceName}}']
            }
        },
        button: BOOKING_BUTTON
    },

    'booking.refund.sending': {
        base: {
            en: {
                subject: 'Refund on its way — {{serviceName}}',
                body: 'We are sending the refund for your {{serviceName}} booking to {{destination}}. {{amountLine}} It usually arrives within minutes.'
            },
            fr: {
                subject: 'Remboursement en route — {{serviceName}}',
                body: 'Nous envoyons le remboursement de votre réservation {{serviceName}} au {{destination}}. {{amountLine}} Il arrive généralement en quelques minutes.'
            },
            pt: {
                subject: 'Reembolso a caminho — {{serviceName}}',
                body: 'Estamos a enviar o reembolso da sua reserva de {{serviceName}} para {{destination}}. {{amountLine}} Costuma chegar em poucos minutos.'
            },
            es: {
                subject: 'Reembolso en camino — {{serviceName}}',
                body: 'Estamos enviando el reembolso de tu reserva de {{serviceName}} a {{destination}}. {{amountLine}} Suele llegar en pocos minutos.'
            },
            ar: {
                subject: 'الاسترداد في الطريق — {{serviceName}}',
                body: 'نقوم بإرسال استرداد حجزك لـ {{serviceName}} إلى {{destination}}. {{amountLine}} يصل عادةً خلال دقائق.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_refund_sending',
                bodyParams: ['{{serviceName}}', '{{destination}}', '{{amountLine}}']
            }
        },
        button: BOOKING_BUTTON
    },

    'booking.refund.completed': {
        base: {
            en: {
                subject: 'Refund sent — {{serviceName}}',
                body: 'The refund for your {{serviceName}} booking has been sent to {{destination}}. {{amountLine}} If it has not reached you within a day, reply here or open the booking.'
            },
            fr: {
                subject: 'Remboursement envoyé — {{serviceName}}',
                body: 'Le remboursement de votre réservation {{serviceName}} a été envoyé au {{destination}}. {{amountLine}} S’il ne vous est pas parvenu d’ici un jour, répondez ici ou ouvrez la réservation.'
            },
            pt: {
                subject: 'Reembolso enviado — {{serviceName}}',
                body: 'O reembolso da sua reserva de {{serviceName}} foi enviado para {{destination}}. {{amountLine}} Se não o receber dentro de um dia, responda aqui ou abra a reserva.'
            },
            es: {
                subject: 'Reembolso enviado — {{serviceName}}',
                body: 'El reembolso de tu reserva de {{serviceName}} se ha enviado a {{destination}}. {{amountLine}} Si no te llega en un día, responde aquí o abre la reserva.'
            },
            ar: {
                subject: 'تم إرسال الاسترداد — {{serviceName}}',
                body: 'تم إرسال استرداد حجزك لـ {{serviceName}} إلى {{destination}}. {{amountLine}} إذا لم يصلك خلال يوم، فرد هنا أو افتح الحجز.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_refund_completed',
                bodyParams: ['{{serviceName}}', '{{destination}}', '{{amountLine}}']
            }
        },
        button: BOOKING_BUTTON
    },

    'booking.refund.paid_externally': {
        base: {
            en: {
                subject: 'Refund paid — {{serviceName}}',
                body: 'Our team has paid the refund for your {{serviceName}} booking directly, outside the app. {{amountLine}} If it has not reached you, reply here or open the booking.'
            },
            fr: {
                subject: 'Remboursement payé — {{serviceName}}',
                body: 'Notre équipe vous a payé directement le remboursement de votre réservation {{serviceName}}, en dehors de l’application. {{amountLine}} Si vous ne l’avez pas reçu, répondez ici ou ouvrez la réservation.'
            },
            pt: {
                subject: 'Reembolso pago — {{serviceName}}',
                body: 'A nossa equipa pagou-lhe diretamente o reembolso da sua reserva de {{serviceName}}, fora da aplicação. {{amountLine}} Se não o recebeu, responda aqui ou abra a reserva.'
            },
            es: {
                subject: 'Reembolso pagado — {{serviceName}}',
                body: 'Nuestro equipo te ha pagado directamente el reembolso de tu reserva de {{serviceName}}, fuera de la aplicación. {{amountLine}} Si no lo has recibido, responde aquí o abre la reserva.'
            },
            ar: {
                subject: 'تم دفع الاسترداد — {{serviceName}}',
                body: 'دفع لك فريقنا استرداد حجزك لـ {{serviceName}} مباشرةً خارج التطبيق. {{amountLine}} إذا لم يصلك، فرد هنا أو افتح الحجز.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_refund_paid_externally',
                bodyParams: ['{{serviceName}}', '{{amountLine}}']
            }
        },
        button: BOOKING_BUTTON
    },

    // The reason an administrator typed is NOT quoted: it is internal free text written for the
    // team, the same rule `order.delivery_failed` applies to an agent's `failureNote`.
    'booking.refund.declined': {
        base: {
            en: {
                subject: 'Refund declined — {{serviceName}}',
                body: 'The refund requested for your {{serviceName}} booking was declined after review. If you think this is a mistake, reply here or open a support request from the booking.'
            },
            fr: {
                subject: 'Remboursement refusé — {{serviceName}}',
                body: 'Le remboursement demandé pour votre réservation {{serviceName}} a été refusé après examen. Si vous pensez qu’il s’agit d’une erreur, répondez ici ou ouvrez une demande d’assistance depuis la réservation.'
            },
            pt: {
                subject: 'Reembolso recusado — {{serviceName}}',
                body: 'O reembolso pedido para a sua reserva de {{serviceName}} foi recusado após análise. Se acha que é um erro, responda aqui ou abra um pedido de apoio a partir da reserva.'
            },
            es: {
                subject: 'Reembolso rechazado — {{serviceName}}',
                body: 'El reembolso solicitado para tu reserva de {{serviceName}} se rechazó tras revisarlo. Si crees que es un error, responde aquí o abre una solicitud de soporte desde la reserva.'
            },
            ar: {
                subject: 'تم رفض الاسترداد — {{serviceName}}',
                body: 'تم رفض الاسترداد المطلوب لحجزك لـ {{serviceName}} بعد المراجعة. إذا كنت تعتقد أن هذا خطأ، فرد هنا أو افتح طلب دعم من الحجز.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_booking_refund_declined',
                bodyParams: ['{{serviceName}}']
            }
        },
        button: BOOKING_BUTTON
    },

    // ══ Orders ═══════════════════════════════════════════════════════════════

    'order.created': {
        base: {
            en: {
                subject: 'Order {{orderNumber}} placed',
                body: 'Your order {{orderNumber}} with {{vendorName}} is placed — {{itemCount}} item(s), {{currency}} {{amountFormatted}}. {{paymentLine}}'
            },
            fr: {
                subject: 'Commande {{orderNumber}} passée',
                body: 'Votre commande {{orderNumber}} chez {{vendorName}} est enregistrée — {{itemCount}} article(s), {{currency}} {{amountFormatted}}. {{paymentLine}}'
            },
            pt: {
                subject: 'Encomenda {{orderNumber}} efetuada',
                body: 'A sua encomenda {{orderNumber}} com {{vendorName}} foi efetuada — {{itemCount}} artigo(s), {{currency}} {{amountFormatted}}. {{paymentLine}}'
            },
            es: {
                subject: 'Pedido {{orderNumber}} realizado',
                body: 'Tu pedido {{orderNumber}} con {{vendorName}} está hecho — {{itemCount}} artículo(s), {{currency}} {{amountFormatted}}. {{paymentLine}}'
            },
            ar: {
                subject: 'تم إنشاء الطلب {{orderNumber}}',
                body: 'تم تسجيل طلبك {{orderNumber}} مع {{vendorName}} — {{itemCount}} منتج، {{currency}} {{amountFormatted}}. {{paymentLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_created',
                bodyParams: ['{{orderNumber}}', '{{vendorName}}', '{{itemCount}}', '{{currency}}', '{{amountFormatted}}']
            }
        },
        button: ORDER_BUTTON
    },

    'order.payment.received': {
        base: {
            en: {
                subject: 'Payment received for {{orderNumber}}',
                body: 'We received your {{currency}} {{amountFormatted}} payment for order {{orderNumber}}. {{vendorName}} is preparing it now.'
            },
            fr: {
                subject: 'Paiement reçu pour {{orderNumber}}',
                body: 'Nous avons reçu votre paiement de {{currency}} {{amountFormatted}} pour la commande {{orderNumber}}. {{vendorName}} la prépare.'
            },
            pt: {
                subject: 'Pagamento recebido para {{orderNumber}}',
                body: 'Recebemos o seu pagamento de {{currency}} {{amountFormatted}} pela encomenda {{orderNumber}}. {{vendorName}} está a prepará-la.'
            },
            es: {
                subject: 'Pago recibido para {{orderNumber}}',
                body: 'Recibimos tu pago de {{currency}} {{amountFormatted}} por el pedido {{orderNumber}}. {{vendorName}} lo está preparando.'
            },
            ar: {
                subject: 'تم استلام الدفعة للطلب {{orderNumber}}',
                body: 'استلمنا دفعتك بقيمة {{currency}} {{amountFormatted}} للطلب {{orderNumber}}. تقوم {{vendorName}} بتجهيزه الآن.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_payment_received',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}', '{{vendorName}}']
            }
        },
        button: ORDER_BUTTON
    },

    // ⚠ **The only situation here the automation layer RAISES rather than observes**, and
    // the only one whose button does not point at an order. It carries a card payment page
    // (GAP-008) to a customer whose chat window has closed, which is the exact shape
    // GAP-012 describes: a flow that cannot finish where it started.
    //
    // The copy says the amount and that the link expires, and deliberately does NOT say
    // "your order is waiting" — a customer who has already paid by another route must not be
    // told they owe money. The link's own page answers `state: 'settled'` in that case, but
    // the message arrives first.
    'order.payment_link': {
        base: {
            en: {
                subject: 'Finish paying {{currency}} {{amountFormatted}}',
                body: 'Open this page to pay {{currency}} {{amountFormatted}} for {{orderNumber}} by card. The link works for {{expiresInMinutes}} minutes — ask me for a new one if it runs out.'
            },
            fr: {
                subject: 'Terminez le paiement de {{currency}} {{amountFormatted}}',
                body: 'Ouvrez cette page pour payer {{currency}} {{amountFormatted}} pour {{orderNumber}} par carte. Le lien est valable {{expiresInMinutes}} minutes — demandez-m\'en un nouveau s\'il expire.'
            },
            pt: {
                subject: 'Conclua o pagamento de {{currency}} {{amountFormatted}}',
                body: 'Abra esta página para pagar {{currency}} {{amountFormatted}} de {{orderNumber}} com cartão. O link é válido durante {{expiresInMinutes}} minutos — peça-me um novo se expirar.'
            },
            es: {
                subject: 'Termina el pago de {{currency}} {{amountFormatted}}',
                body: 'Abre esta página para pagar {{currency}} {{amountFormatted}} de {{orderNumber}} con tarjeta. El enlace dura {{expiresInMinutes}} minutos — pídeme otro si caduca.'
            },
            ar: {
                subject: 'أكمل دفع {{currency}} {{amountFormatted}}',
                body: 'افتح هذه الصفحة لدفع {{currency}} {{amountFormatted}} مقابل {{orderNumber}} بالبطاقة. الرابط صالح لمدة {{expiresInMinutes}} دقيقة — اطلب مني رابطًا جديدًا إذا انتهت صلاحيته.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_payment_link',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}', '{{expiresInMinutes}}']
            }
        },
        // ⚠ The ONE button in this catalog that does not lead to a record the customer
        // already owns — it leads to a page that can take their money. That is why the
        // token in it is single-purpose, expiring, and revoked by the next mint: see
        // `payments/domain/pay-link.ts`.
        button: PAY_LINK_BUTTON
    },

    /**
     * ⚠ **The silence this closes was the defect.** Every other checkout outcome said
     * something; a failed payment said nothing, so it was indistinguishable from a successful
     * one that had gone quiet. The customer waits for an order that is not coming.
     *
     * Three rules the copy obeys, and each is load-bearing:
     *
     *   - **It does not say the order is cancelled**, because it is not. The basket survives
     *     and the charge is retryable, so announcing a cancellation would destroy a recoverable
     *     sale and send the customer to start again from nothing.
     *   - **It blames nobody.** "Declined" reads as an accusation about the customer's money;
     *     the common causes here are an unapproved push prompt and a timeout, neither of which
     *     is a judgement on them.
     *   - **It names the amount**, so a customer with two orders in flight knows which one this
     *     is about — the same reason every other entry carries `orderNumber`.
     *
     * `ORDER_BUTTON` rather than a fresh pay link: at failure time there may be no valid
     * token to mint one from, and a button that opens a dead payment page is worse than one
     * that opens the order the retry lives on.
     */
    'order.payment_failed': {
        base: {
            en: {
                subject: 'Payment did not go through for {{orderNumber}}',
                body: 'We could not take the {{currency}} {{amountFormatted}} for {{orderNumber}}. Nothing has been charged and your items are still waiting — open the order to try again.'
            },
            fr: {
                subject: 'Paiement non abouti pour {{orderNumber}}',
                body: "Nous n'avons pas pu encaisser les {{currency}} {{amountFormatted}} pour {{orderNumber}}. Rien n'a été débité et vos articles vous attendent toujours — ouvrez la commande pour réessayer."
            },
            pt: {
                subject: 'O pagamento não foi concluído para {{orderNumber}}',
                body: 'Não conseguimos cobrar os {{currency}} {{amountFormatted}} de {{orderNumber}}. Nada foi debitado e os seus artigos continuam à espera — abra a encomenda para tentar de novo.'
            },
            es: {
                subject: 'El pago no se completó para {{orderNumber}}',
                body: 'No pudimos cobrar los {{currency}} {{amountFormatted}} de {{orderNumber}}. No se ha cobrado nada y tus artículos siguen esperando — abre el pedido para intentarlo otra vez.'
            },
            ar: {
                subject: 'لم يتم الدفع للطلب {{orderNumber}}',
                body: 'لم نتمكن من تحصيل {{currency}} {{amountFormatted}} للطلب {{orderNumber}}. لم يُخصم أي مبلغ ولا تزال منتجاتك في انتظارك — افتح الطلب لإعادة المحاولة.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_payment_failed',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON,
        actions: [TRY_PAYMENT_AGAIN]
    },

    'order.shipped': {
        base: {
            en: {
                subject: 'Order {{orderNumber}} is on its way',
                body: 'Your order {{orderNumber}} has left {{vendorName}} and is on its way to you. Track it any time with {{trackingNumber}}.'
            },
            fr: {
                subject: 'Commande {{orderNumber}} en route',
                body: 'Votre commande {{orderNumber}} a quitté {{vendorName}} et est en route. Suivez-la à tout moment avec {{trackingNumber}}.'
            },
            pt: {
                subject: 'Encomenda {{orderNumber}} a caminho',
                body: 'A sua encomenda {{orderNumber}} saiu de {{vendorName}} e está a caminho. Acompanhe a qualquer momento com {{trackingNumber}}.'
            },
            es: {
                subject: 'Pedido {{orderNumber}} en camino',
                body: 'Tu pedido {{orderNumber}} salió de {{vendorName}} y está en camino. Síguelo cuando quieras con {{trackingNumber}}.'
            },
            ar: {
                subject: 'الطلب {{orderNumber}} في الطريق',
                body: 'غادر طلبك {{orderNumber}} من {{vendorName}} وهو في طريقه إليك. تتبعه في أي وقت باستخدام {{trackingNumber}}.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_shipped',
                bodyParams: ['{{orderNumber}}', '{{vendorName}}', '{{trackingNumber}}']
            }
        },
        button: TRACK_BUTTON,
        actions: [{ token: 'ord:{{orderId}}', label: ORDER_DETAILS_LABEL, templateFallback: 'open:ol' }]
    },

    // The one message worth interrupting someone for — it is the only prompt to
    // physically be somewhere.
    'order.out_for_delivery': {
        base: {
            en: {
                subject: 'Out for delivery: {{orderNumber}}',
                body: 'Your order {{orderNumber}} is out for delivery today. Please make sure someone can receive it. {{codLine}}'
            },
            fr: {
                subject: 'En cours de livraison : {{orderNumber}}',
                body: 'Votre commande {{orderNumber}} est en cours de livraison aujourd\'hui. Assurez-vous que quelqu\'un puisse la réceptionner. {{codLine}}'
            },
            pt: {
                subject: 'Em entrega: {{orderNumber}}',
                body: 'A sua encomenda {{orderNumber}} está em entrega hoje. Garanta que alguém a pode receber. {{codLine}}'
            },
            es: {
                subject: 'En reparto: {{orderNumber}}',
                body: 'Tu pedido {{orderNumber}} está en reparto hoy. Asegúrate de que alguien pueda recibirlo. {{codLine}}'
            },
            ar: {
                subject: 'قيد التوصيل: {{orderNumber}}',
                body: 'طلبك {{orderNumber}} قيد التوصيل اليوم. يرجى التأكد من وجود شخص لاستلامه. {{codLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_out_for_delivery',
                bodyParams: ['{{orderNumber}}']
            }
        },
        button: TRACK_BUTTON
    },

    'order.delivered': {
        base: {
            en: {
                subject: 'Delivered: {{orderNumber}}',
                body: 'Your order {{orderNumber}} has been delivered. If anything is wrong with it, open the order and tell us within the vendor\'s return window.'
            },
            fr: {
                subject: 'Livrée : {{orderNumber}}',
                body: 'Votre commande {{orderNumber}} a été livrée. En cas de problème, ouvrez la commande et signalez-le pendant le délai de retour du vendeur.'
            },
            pt: {
                subject: 'Entregue: {{orderNumber}}',
                body: 'A sua encomenda {{orderNumber}} foi entregue. Se algo estiver errado, abra a encomenda e avise-nos dentro do prazo de devolução do vendedor.'
            },
            es: {
                subject: 'Entregado: {{orderNumber}}',
                body: 'Tu pedido {{orderNumber}} ha sido entregado. Si algo va mal, abre el pedido y avísanos dentro del plazo de devolución del vendedor.'
            },
            ar: {
                subject: 'تم التسليم: {{orderNumber}}',
                body: 'تم تسليم طلبك {{orderNumber}}. إذا كان هناك أي خطأ، افتح الطلب وأخبرنا خلال فترة الإرجاع الخاصة بالبائع.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivered',
                bodyParams: ['{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON,
        actions: [
            /**
             * ✅ **"Leave a review" RESTORED.** It was withdrawn when `rate` was a declared verb
             * that no stream registered. That stopped being true in `c39bff7` (2026-09-21):
             * `REVIEW_ACTION_HANDLERS` in `bot-review.controller.ts` registers `rate`, and
             * `rate:<orderId>` is exactly its invitation arity — it checks the order is the
             * caller's (a miss is 404) and answers with the five-star picker. The withdrawal
             * then sat here, obsolete, for six days, because nothing re-checked it;
             * `test:bot-surface` now resolves every token in this file against the routed set.
             *
             * ⚠ **Still withdrawn on `booking.completed`.** `handleRateTap` resolves an ORDER, a
             * booking carries no order id, and a booking id where an order id is expected would
             * parse. Reviewing a service needs its own subject path.
             *
             * Positive action first, as `order.delivery_failed` orders its two.
             *
             * ⚠ **`hp`, not `ord`.** Topic codes are `rd`/`ad`/`hp` only; `hp` is the
             * SHIPPING_ISSUE topic the in-chat "Get help" button already uses.
             */
            { token: 'rate:{{orderId}}', label: LEAVE_REVIEW_LABEL, templateFallback: 'open:ol' },
            { token: 'tkt:new:hp:{{orderId}}', label: SOMETHING_WRONG_LABEL, templateFallback: 'tkt:new' }
        ]
    },

    'order.delivery_failed': {
        base: {
            en: {
                subject: 'Delivery attempt failed: {{orderNumber}}',
                body: 'We could not deliver order {{orderNumber}} today. {{reasonLine}} We will try again — check the order for the next attempt, or contact us to arrange a better time.'
            },
            fr: {
                subject: 'Échec de livraison : {{orderNumber}}',
                body: 'Nous n\'avons pas pu livrer la commande {{orderNumber}} aujourd\'hui. {{reasonLine}} Nous réessaierons — consultez la commande pour la prochaine tentative ou contactez-nous pour convenir d\'un meilleur moment.'
            },
            pt: {
                subject: 'Tentativa de entrega falhou: {{orderNumber}}',
                body: 'Não conseguimos entregar a encomenda {{orderNumber}} hoje. {{reasonLine}} Vamos tentar de novo — veja a encomenda para a próxima tentativa ou contacte-nos para combinar melhor horário.'
            },
            es: {
                subject: 'Entrega fallida: {{orderNumber}}',
                body: 'No pudimos entregar el pedido {{orderNumber}} hoy. {{reasonLine}} Lo intentaremos otra vez — revisa el pedido para el próximo intento o contáctanos para acordar mejor hora.'
            },
            ar: {
                subject: 'فشلت محاولة التوصيل: {{orderNumber}}',
                body: 'لم نتمكن من توصيل الطلب {{orderNumber}} اليوم. {{reasonLine}} سنحاول مرة أخرى — راجع الطلب لمعرفة المحاولة التالية أو تواصل معنا لتحديد وقت أنسب.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_failed',
                bodyParams: ['{{orderNumber}}']
            }
        },
        button: TRACK_BUTTON,
        /**
         * The owner's three asks, as TWO buttons — and both halves of that are decisions.
         *
         * ⚠ **"Where is it now" was REMOVED as a duplicate, not dropped as an ask.** This
         * situation's link button is `TRACK_BUTTON`, which already opens the tracking page and
         * already says "Track delivery". A tap button beside it going to the same place is two
         * controls for one intent — and it mattered here because WhatsApp renders at most one
         * link plus two taps, so the duplicate was the thing squeezing out a real ask.
         *
         * ⚠ **`tkt:new:rd:` / `tkt:new:ad:`, NOT a four-segment `tkt:new:dlv:<order>:<reason>`.**
         * The tickets stream owns the `tkt` verb, and its parser accepts three segments at most
         * — a four-segment argument is refused outright, so the earlier shape would have reached
         * the dispatcher's unknown-action answer. On a message about a FAILED DELIVERY, "I did
         * not understand that" is the worst possible reply, and Telegram reports nothing for an
         * unhandled callback, so it would have been invisible from this side.
         *
         * The labels stayed: they say what HAPPENED rather than naming an action the platform
         * cannot promise. There is no reschedule endpoint anywhere and the delivery address is
         * snapshotted onto the order at checkout, so a button reading "Reschedule" or "Change
         * address" would be a promise we cannot keep. `rd` files DELIVERY_DELAY, `ad` files
         * ADDRESS_CHANGE, and both pre-fill the order.
         */
        actions: [
            { token: 'tkt:new:rd:{{orderId}}', label: NOT_THERE_LABEL, templateFallback: 'tkt:new' },
            { token: 'tkt:new:ad:{{orderId}}', label: ADDRESS_WRONG_LABEL, templateFallback: 'tkt:new' }
        ]
    },

    'order.cancelled': {
        base: {
            en: {
                subject: 'Order {{orderNumber}} cancelled',
                body: 'Your order {{orderNumber}} has been cancelled. {{refundLine}}'
            },
            fr: {
                subject: 'Commande {{orderNumber}} annulée',
                body: 'Votre commande {{orderNumber}} a été annulée. {{refundLine}}'
            },
            pt: {
                subject: 'Encomenda {{orderNumber}} cancelada',
                body: 'A sua encomenda {{orderNumber}} foi cancelada. {{refundLine}}'
            },
            es: {
                subject: 'Pedido {{orderNumber}} cancelado',
                body: 'Tu pedido {{orderNumber}} ha sido cancelado. {{refundLine}}'
            },
            ar: {
                subject: 'تم إلغاء الطلب {{orderNumber}}',
                body: 'تم إلغاء طلبك {{orderNumber}}. {{refundLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_cancelled',
                bodyParams: ['{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON
    },

    'order.refunded': {
        base: {
            en: {
                subject: 'Refunded: {{currency}} {{amountFormatted}}',
                body: 'We have refunded {{currency}} {{amountFormatted}} for order {{orderNumber}}. It goes back to the way you paid, and usually appears within a few working days.'
            },
            fr: {
                subject: 'Remboursé : {{currency}} {{amountFormatted}}',
                body: 'Nous avons remboursé {{currency}} {{amountFormatted}} pour la commande {{orderNumber}}. Le montant retourne par votre moyen de paiement et apparaît généralement sous quelques jours ouvrés.'
            },
            pt: {
                subject: 'Reembolsado: {{currency}} {{amountFormatted}}',
                body: 'Reembolsámos {{currency}} {{amountFormatted}} pela encomenda {{orderNumber}}. Volta pelo mesmo meio de pagamento e costuma aparecer em poucos dias úteis.'
            },
            es: {
                subject: 'Reembolsado: {{currency}} {{amountFormatted}}',
                body: 'Hemos reembolsado {{currency}} {{amountFormatted}} por el pedido {{orderNumber}}. Vuelve por tu medio de pago y suele aparecer en unos días hábiles.'
            },
            ar: {
                subject: 'تم الاسترداد: {{currency}} {{amountFormatted}}',
                body: 'قمنا برد {{currency}} {{amountFormatted}} مقابل الطلب {{orderNumber}}. يعود المبلغ بنفس طريقة الدفع وعادة ما يظهر خلال أيام عمل قليلة.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_refunded',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON
    },

    // ── The refund request lifecycle (REFUND-FLOW-PLAN § 8, R9) ─────────────────
    // Raised from `refund.status_changed` (requested · waiting for cash · sending · declined) and
    // `payment.refunded` (completed · paid externally). A CARD refund keeps `order.refunded` above:
    // the full amount goes back to the card and no fee is mentioned, because none is taken.
    // `{{amountLine}}` is `refundAmountLine` — the NET, and the 2% line when a fee was taken.

    'order.refund.requested': {
        base: {
            en: {
                subject: 'Refund requested: {{currency}} {{amountFormatted}}',
                body: 'A refund of {{currency}} {{amountFormatted}} has been requested for your order {{orderNumber}}. Our team is reviewing it — you do not need to do anything, and we will tell you when it is sent.'
            },
            fr: {
                subject: 'Remboursement demandé : {{currency}} {{amountFormatted}}',
                body: 'Un remboursement de {{currency}} {{amountFormatted}} a été demandé pour votre commande {{orderNumber}}. Notre équipe l’examine — vous n’avez rien à faire, nous vous préviendrons dès qu’il sera envoyé.'
            },
            pt: {
                subject: 'Reembolso pedido: {{currency}} {{amountFormatted}}',
                body: 'Foi pedido um reembolso de {{currency}} {{amountFormatted}} pela sua encomenda {{orderNumber}}. A nossa equipa está a analisá-lo — não precisa de fazer nada e avisamos quando for enviado.'
            },
            es: {
                subject: 'Reembolso solicitado: {{currency}} {{amountFormatted}}',
                body: 'Se ha solicitado un reembolso de {{currency}} {{amountFormatted}} por tu pedido {{orderNumber}}. Nuestro equipo lo está revisando — no tienes que hacer nada y te avisaremos cuando se envíe.'
            },
            ar: {
                subject: 'تم طلب الاسترداد: {{currency}} {{amountFormatted}}',
                body: 'تم طلب استرداد {{currency}} {{amountFormatted}} لطلبك {{orderNumber}}. يقوم فريقنا بمراجعته — لا داعي لفعل أي شيء وسنخبرك عند إرساله.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_refund_requested',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON
    },

    // R-4 / R-5: a cash-on-delivery refund waits until the cash the customer paid has reached the
    // platform. Said plainly, so a customer does not read the wait as the platform stalling.
    'order.refund.waiting_for_cash': {
        base: {
            en: {
                subject: 'Refund approved: {{currency}} {{amountFormatted}}',
                body: 'Your refund of {{currency}} {{amountFormatted}} for order {{orderNumber}} is approved. You paid in cash, and the delivery company has not yet handed that cash over to us — we will send your refund as soon as it does. You do not need to do anything.'
            },
            fr: {
                subject: 'Remboursement approuvé : {{currency}} {{amountFormatted}}',
                body: 'Votre remboursement de {{currency}} {{amountFormatted}} pour la commande {{orderNumber}} est approuvé. Vous avez payé en espèces et la société de livraison ne nous a pas encore remis cet argent — nous enverrons votre remboursement dès que ce sera fait. Vous n’avez rien à faire.'
            },
            pt: {
                subject: 'Reembolso aprovado: {{currency}} {{amountFormatted}}',
                body: 'O seu reembolso de {{currency}} {{amountFormatted}} pela encomenda {{orderNumber}} foi aprovado. Pagou em dinheiro e a empresa de entregas ainda não nos entregou esse dinheiro — enviaremos o reembolso assim que o fizer. Não precisa de fazer nada.'
            },
            es: {
                subject: 'Reembolso aprobado: {{currency}} {{amountFormatted}}',
                body: 'Tu reembolso de {{currency}} {{amountFormatted}} del pedido {{orderNumber}} está aprobado. Pagaste en efectivo y la empresa de reparto aún no nos ha entregado ese dinero — enviaremos tu reembolso en cuanto lo haga. No tienes que hacer nada.'
            },
            ar: {
                subject: 'تمت الموافقة على الاسترداد: {{currency}} {{amountFormatted}}',
                body: 'تمت الموافقة على استرداد {{currency}} {{amountFormatted}} للطلب {{orderNumber}}. لقد دفعت نقدًا ولم تسلّمنا شركة التوصيل هذا المبلغ بعد — سنرسل الاسترداد فور حدوث ذلك. لا داعي لفعل أي شيء.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_refund_waiting_for_cash',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON
    },

    'order.refund.sending': {
        base: {
            en: {
                subject: 'Refund on its way — {{orderNumber}}',
                body: 'We are sending the refund for your order {{orderNumber}} to {{destination}}. {{amountLine}} It usually arrives within minutes.'
            },
            fr: {
                subject: 'Remboursement en route — {{orderNumber}}',
                body: 'Nous envoyons le remboursement de votre commande {{orderNumber}} au {{destination}}. {{amountLine}} Il arrive généralement en quelques minutes.'
            },
            pt: {
                subject: 'Reembolso a caminho — {{orderNumber}}',
                body: 'Estamos a enviar o reembolso da sua encomenda {{orderNumber}} para {{destination}}. {{amountLine}} Costuma chegar em poucos minutos.'
            },
            es: {
                subject: 'Reembolso en camino — {{orderNumber}}',
                body: 'Estamos enviando el reembolso de tu pedido {{orderNumber}} a {{destination}}. {{amountLine}} Suele llegar en pocos minutos.'
            },
            ar: {
                subject: 'الاسترداد في الطريق — {{orderNumber}}',
                body: 'نقوم بإرسال استرداد طلبك {{orderNumber}} إلى {{destination}}. {{amountLine}} يصل عادةً خلال دقائق.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_refund_sending',
                bodyParams: ['{{orderNumber}}', '{{destination}}', '{{amountLine}}']
            }
        },
        button: ORDER_BUTTON
    },

    'order.refund.completed': {
        base: {
            en: {
                subject: 'Refund sent — {{orderNumber}}',
                body: 'The refund for your order {{orderNumber}} has been sent to {{destination}}. {{amountLine}} If it has not reached you within a day, reply here or open the order.'
            },
            fr: {
                subject: 'Remboursement envoyé — {{orderNumber}}',
                body: 'Le remboursement de votre commande {{orderNumber}} a été envoyé au {{destination}}. {{amountLine}} S’il ne vous est pas parvenu d’ici un jour, répondez ici ou ouvrez la commande.'
            },
            pt: {
                subject: 'Reembolso enviado — {{orderNumber}}',
                body: 'O reembolso da sua encomenda {{orderNumber}} foi enviado para {{destination}}. {{amountLine}} Se não o receber dentro de um dia, responda aqui ou abra a encomenda.'
            },
            es: {
                subject: 'Reembolso enviado — {{orderNumber}}',
                body: 'El reembolso de tu pedido {{orderNumber}} se ha enviado a {{destination}}. {{amountLine}} Si no te llega en un día, responde aquí o abre el pedido.'
            },
            ar: {
                subject: 'تم إرسال الاسترداد — {{orderNumber}}',
                body: 'تم إرسال استرداد طلبك {{orderNumber}} إلى {{destination}}. {{amountLine}} إذا لم يصلك خلال يوم، فرد هنا أو افتح الطلب.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_refund_completed',
                bodyParams: ['{{orderNumber}}', '{{destination}}', '{{amountLine}}']
            }
        },
        button: ORDER_BUTTON
    },

    'order.refund.paid_externally': {
        base: {
            en: {
                subject: 'Refund paid — {{orderNumber}}',
                body: 'Our team has paid the refund for your order {{orderNumber}} directly, outside the app. {{amountLine}} If it has not reached you, reply here or open the order.'
            },
            fr: {
                subject: 'Remboursement payé — {{orderNumber}}',
                body: 'Notre équipe vous a payé directement le remboursement de votre commande {{orderNumber}}, en dehors de l’application. {{amountLine}} Si vous ne l’avez pas reçu, répondez ici ou ouvrez la commande.'
            },
            pt: {
                subject: 'Reembolso pago — {{orderNumber}}',
                body: 'A nossa equipa pagou-lhe diretamente o reembolso da sua encomenda {{orderNumber}}, fora da aplicação. {{amountLine}} Se não o recebeu, responda aqui ou abra a encomenda.'
            },
            es: {
                subject: 'Reembolso pagado — {{orderNumber}}',
                body: 'Nuestro equipo te ha pagado directamente el reembolso de tu pedido {{orderNumber}}, fuera de la aplicación. {{amountLine}} Si no lo has recibido, responde aquí o abre el pedido.'
            },
            ar: {
                subject: 'تم دفع الاسترداد — {{orderNumber}}',
                body: 'دفع لك فريقنا استرداد طلبك {{orderNumber}} مباشرةً خارج التطبيق. {{amountLine}} إذا لم يصلك، فرد هنا أو افتح الطلب.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_refund_paid_externally',
                bodyParams: ['{{orderNumber}}', '{{amountLine}}']
            }
        },
        button: ORDER_BUTTON
    },

    // The administrator's reason is NOT quoted — internal free text, as with `failureNote`.
    'order.refund.declined': {
        base: {
            en: {
                subject: 'Refund declined — {{orderNumber}}',
                body: 'The refund requested for your order {{orderNumber}} was declined after review. If you think this is a mistake, reply here or open a support request from the order.'
            },
            fr: {
                subject: 'Remboursement refusé — {{orderNumber}}',
                body: 'Le remboursement demandé pour votre commande {{orderNumber}} a été refusé après examen. Si vous pensez qu’il s’agit d’une erreur, répondez ici ou ouvrez une demande d’assistance depuis la commande.'
            },
            pt: {
                subject: 'Reembolso recusado — {{orderNumber}}',
                body: 'O reembolso pedido para a sua encomenda {{orderNumber}} foi recusado após análise. Se acha que é um erro, responda aqui ou abra um pedido de apoio a partir da encomenda.'
            },
            es: {
                subject: 'Reembolso rechazado — {{orderNumber}}',
                body: 'El reembolso solicitado para tu pedido {{orderNumber}} se rechazó tras revisarlo. Si crees que es un error, responde aquí o abre una solicitud de soporte desde el pedido.'
            },
            ar: {
                subject: 'تم رفض الاسترداد — {{orderNumber}}',
                body: 'تم رفض الاسترداد المطلوب لطلبك {{orderNumber}} بعد المراجعة. إذا كنت تعتقد أن هذا خطأ، فرد هنا أو افتح طلب دعم من الطلب.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_refund_declined',
                bodyParams: ['{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON
    },

    // ══ Delivery-fee changes after checkout (ADR-A11, W-E) ═══════════════════
    //
    // All seven are MONEY situations: no key in `SITUATION_PREFERENCE`, so no setting silences
    // them — the customer is the counterparty to somebody else's change to what they pay. The
    // optional sentences (`{{reasonLine}}`, `{{moneyLine}}`, `{{answerLine}}`) are composed in
    // `delivery-fee-proposals/services/customer-fee-notifier.ts` in the customer's language.
    // ⚠ Templates generated, NOT submitted to Meta (owner action) — see whatsapp-templates.md.

    'order.delivery_fee.approval_needed': {
        base: {
            en: {
                subject: 'Delivery fee change to approve — {{orderNumber}}',
                body: 'The delivery company asks {{currency}} {{proposedFeeFormatted}} instead of {{currency}} {{feeBeforeFormatted}} to deliver your order {{orderNumber}}. {{reasonLine}} Open the order to approve or decline — your parcel waits for your answer.'
            },
            fr: {
                subject: 'Changement des frais de livraison à valider — {{orderNumber}}',
                body: 'La société de livraison demande {{currency}} {{proposedFeeFormatted}} au lieu de {{currency}} {{feeBeforeFormatted}} pour livrer votre commande {{orderNumber}}. {{reasonLine}} Ouvrez la commande pour accepter ou refuser — votre colis attend votre réponse.'
            },
            pt: {
                subject: 'Alteração da taxa de entrega para aprovar — {{orderNumber}}',
                body: 'A empresa de entregas pede {{currency}} {{proposedFeeFormatted}} em vez de {{currency}} {{feeBeforeFormatted}} para entregar a sua encomenda {{orderNumber}}. {{reasonLine}} Abra a encomenda para aceitar ou recusar — a encomenda aguarda a sua resposta.'
            },
            es: {
                subject: 'Cambio de tarifa de envío por aprobar — {{orderNumber}}',
                body: 'La empresa de envíos pide {{currency}} {{proposedFeeFormatted}} en lugar de {{currency}} {{feeBeforeFormatted}} para entregar tu pedido {{orderNumber}}. {{reasonLine}} Abre el pedido para aceptar o rechazar — tu paquete espera tu respuesta.'
            },
            ar: {
                subject: 'تغيير في رسوم التوصيل بانتظار موافقتك — {{orderNumber}}',
                body: 'تطلب شركة التوصيل {{currency}} {{proposedFeeFormatted}} بدلًا من {{currency}} {{feeBeforeFormatted}} لتوصيل طلبك {{orderNumber}}. {{reasonLine}} افتح الطلب للموافقة أو الرفض — طردك ينتظر ردك.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_fee_approval_needed',
                bodyParams: ['{{currency}}', '{{proposedFeeFormatted}}', '{{feeBeforeFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON,
        actions: [SEE_DELIVERY_FEE]
    },

    'order.delivery_fee.topup_due': {
        base: {
            en: {
                subject: 'Pay {{currency}} {{amountFormatted}} to confirm your delivery — {{orderNumber}}',
                body: 'You approved a delivery fee of {{currency}} {{proposedFeeFormatted}} for order {{orderNumber}}. Pay the difference of {{currency}} {{amountFormatted}} and your parcel can be collected.'
            },
            fr: {
                subject: 'Payez {{currency}} {{amountFormatted}} pour confirmer votre livraison — {{orderNumber}}',
                body: 'Vous avez accepté des frais de livraison de {{currency}} {{proposedFeeFormatted}} pour la commande {{orderNumber}}. Payez la différence de {{currency}} {{amountFormatted}} et votre colis pourra être enlevé.'
            },
            pt: {
                subject: 'Pague {{currency}} {{amountFormatted}} para confirmar a entrega — {{orderNumber}}',
                body: 'Aceitou uma taxa de entrega de {{currency}} {{proposedFeeFormatted}} para a encomenda {{orderNumber}}. Pague a diferença de {{currency}} {{amountFormatted}} e a encomenda poderá ser recolhida.'
            },
            es: {
                subject: 'Paga {{currency}} {{amountFormatted}} para confirmar tu envío — {{orderNumber}}',
                body: 'Aceptaste una tarifa de envío de {{currency}} {{proposedFeeFormatted}} para el pedido {{orderNumber}}. Paga la diferencia de {{currency}} {{amountFormatted}} y tu paquete podrá recogerse.'
            },
            ar: {
                subject: 'ادفع {{currency}} {{amountFormatted}} لتأكيد التوصيل — {{orderNumber}}',
                body: 'وافقت على رسوم توصيل قدرها {{currency}} {{proposedFeeFormatted}} للطلب {{orderNumber}}. ادفع الفرق البالغ {{currency}} {{amountFormatted}} ليتم استلام طردك.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_fee_topup_due',
                bodyParams: ['{{currency}}', '{{proposedFeeFormatted}}', '{{orderNumber}}', '{{amountFormatted}}']
            }
        },
        button: ORDER_BUTTON,
        actions: [PAY_DELIVERY_TOPUP]
    },

    'order.delivery_fee.lowered': {
        base: {
            en: {
                subject: 'Your delivery fee went down — {{orderNumber}}',
                body: 'The delivery fee for your order {{orderNumber}} is now {{currency}} {{feeAfterFormatted}} instead of {{currency}} {{feeBeforeFormatted}}. {{moneyLine}}'
            },
            fr: {
                subject: 'Vos frais de livraison ont baissé — {{orderNumber}}',
                body: 'Les frais de livraison de votre commande {{orderNumber}} sont maintenant de {{currency}} {{feeAfterFormatted}} au lieu de {{currency}} {{feeBeforeFormatted}}. {{moneyLine}}'
            },
            pt: {
                subject: 'A sua taxa de entrega baixou — {{orderNumber}}',
                body: 'A taxa de entrega da sua encomenda {{orderNumber}} é agora {{currency}} {{feeAfterFormatted}} em vez de {{currency}} {{feeBeforeFormatted}}. {{moneyLine}}'
            },
            es: {
                subject: 'Tu tarifa de envío bajó — {{orderNumber}}',
                body: 'La tarifa de envío de tu pedido {{orderNumber}} ahora es {{currency}} {{feeAfterFormatted}} en lugar de {{currency}} {{feeBeforeFormatted}}. {{moneyLine}}'
            },
            ar: {
                subject: 'انخفضت رسوم التوصيل — {{orderNumber}}',
                body: 'أصبحت رسوم توصيل طلبك {{orderNumber}} الآن {{currency}} {{feeAfterFormatted}} بدلًا من {{currency}} {{feeBeforeFormatted}}. {{moneyLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_fee_lowered',
                bodyParams: ['{{orderNumber}}', '{{currency}}', '{{feeAfterFormatted}}', '{{feeBeforeFormatted}}']
            }
        },
        button: ORDER_BUTTON
    },

    'order.delivery_fee.updated': {
        base: {
            en: {
                subject: 'New delivery fee confirmed — {{orderNumber}}',
                body: 'The delivery fee for your order {{orderNumber}} is now {{currency}} {{feeAfterFormatted}}. {{moneyLine}}'
            },
            fr: {
                subject: 'Nouveaux frais de livraison confirmés — {{orderNumber}}',
                body: 'Les frais de livraison de votre commande {{orderNumber}} sont maintenant de {{currency}} {{feeAfterFormatted}}. {{moneyLine}}'
            },
            pt: {
                subject: 'Nova taxa de entrega confirmada — {{orderNumber}}',
                body: 'A taxa de entrega da sua encomenda {{orderNumber}} é agora {{currency}} {{feeAfterFormatted}}. {{moneyLine}}'
            },
            es: {
                subject: 'Nueva tarifa de envío confirmada — {{orderNumber}}',
                body: 'La tarifa de envío de tu pedido {{orderNumber}} ahora es {{currency}} {{feeAfterFormatted}}. {{moneyLine}}'
            },
            ar: {
                subject: 'تم تأكيد رسوم التوصيل الجديدة — {{orderNumber}}',
                body: 'أصبحت رسوم توصيل طلبك {{orderNumber}} الآن {{currency}} {{feeAfterFormatted}}. {{moneyLine}}'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_fee_updated',
                bodyParams: ['{{orderNumber}}', '{{currency}}', '{{feeAfterFormatted}}']
            }
        },
        button: ORDER_BUTTON
    },

    // Sent when delivery money owed back could NOT be returned automatically. Silence here is
    // indistinguishable from money kept, so this says a person is on it.
    'order.delivery_fee.refund_pending': {
        base: {
            en: {
                subject: 'Refund on the way: {{currency}} {{amountFormatted}}',
                body: 'We owe you {{currency}} {{amountFormatted}} of delivery money on order {{orderNumber}}. It has to be sent by hand, so our team is processing it — you do not need to do anything, and we will confirm when it is done.'
            },
            fr: {
                subject: 'Remboursement en cours : {{currency}} {{amountFormatted}}',
                body: 'Nous vous devons {{currency}} {{amountFormatted}} de frais de livraison sur la commande {{orderNumber}}. Ce montant doit être envoyé manuellement : notre équipe s’en occupe. Vous n’avez rien à faire, nous confirmerons dès que c’est fait.'
            },
            pt: {
                subject: 'Reembolso a caminho: {{currency}} {{amountFormatted}}',
                body: 'Devemos-lhe {{currency}} {{amountFormatted}} de taxa de entrega na encomenda {{orderNumber}}. Tem de ser enviado manualmente e a nossa equipa está a tratar disso — não precisa de fazer nada e confirmaremos quando estiver concluído.'
            },
            es: {
                subject: 'Reembolso en camino: {{currency}} {{amountFormatted}}',
                body: 'Te debemos {{currency}} {{amountFormatted}} de envío en el pedido {{orderNumber}}. Debe enviarse a mano y nuestro equipo lo está gestionando — no tienes que hacer nada y te confirmaremos cuando esté listo.'
            },
            ar: {
                subject: 'الاسترداد في الطريق: {{currency}} {{amountFormatted}}',
                body: 'ندين لك بمبلغ {{currency}} {{amountFormatted}} من رسوم التوصيل على الطلب {{orderNumber}}. يجب إرساله يدويًا وفريقنا يعمل عليه — لا داعي لفعل أي شيء وسنؤكد لك عند الانتهاء.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_fee_refund_pending',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON
    },

    // W-E2 — the confirmation `refund_pending` promises ("we will confirm when it is done"): an
    // administrator recorded that the delivery money owed back was paid by hand. Not sent when the
    // money had already come back through a refund of the whole order (`order.refunded` said so).
    'order.delivery_fee.refund_settled': {
        base: {
            en: {
                subject: 'Refund sent: {{currency}} {{amountFormatted}}',
                body: 'We have sent you {{currency}} {{amountFormatted}} of delivery money for order {{orderNumber}}. If it has not reached you within a few days, reply here or open the order.'
            },
            fr: {
                subject: 'Remboursement envoyé : {{currency}} {{amountFormatted}}',
                body: 'Nous vous avons envoyé {{currency}} {{amountFormatted}} de frais de livraison pour la commande {{orderNumber}}. Si vous ne l’avez pas reçu d’ici quelques jours, répondez ici ou ouvrez la commande.'
            },
            pt: {
                subject: 'Reembolso enviado: {{currency}} {{amountFormatted}}',
                body: 'Enviámos-lhe {{currency}} {{amountFormatted}} de taxa de entrega da encomenda {{orderNumber}}. Se não o receber dentro de alguns dias, responda aqui ou abra a encomenda.'
            },
            es: {
                subject: 'Reembolso enviado: {{currency}} {{amountFormatted}}',
                body: 'Te hemos enviado {{currency}} {{amountFormatted}} de envío del pedido {{orderNumber}}. Si no te llega en unos días, responde aquí o abre el pedido.'
            },
            ar: {
                subject: 'تم إرسال الاسترداد: {{currency}} {{amountFormatted}}',
                body: 'أرسلنا إليك {{currency}} {{amountFormatted}} من رسوم التوصيل للطلب {{orderNumber}}. إذا لم يصلك خلال بضعة أيام، فرد هنا أو افتح الطلب.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_fee_refund_settled',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON
    },

    'order.delivery_fee.topup_failed': {
        base: {
            en: {
                subject: 'Delivery payment did not go through — {{orderNumber}}',
                body: 'We could not take the {{currency}} {{amountFormatted}} delivery difference for order {{orderNumber}}. Nothing was charged; your parcel waits until it is paid — open the order to try again.'
            },
            fr: {
                subject: 'Paiement de livraison non abouti — {{orderNumber}}',
                body: 'Nous n’avons pas pu encaisser la différence de livraison de {{currency}} {{amountFormatted}} pour la commande {{orderNumber}}. Rien n’a été débité ; votre colis attend ce paiement — ouvrez la commande pour réessayer.'
            },
            pt: {
                subject: 'O pagamento da entrega não foi concluído — {{orderNumber}}',
                body: 'Não conseguimos cobrar a diferença de entrega de {{currency}} {{amountFormatted}} da encomenda {{orderNumber}}. Nada foi debitado; a encomenda aguarda esse pagamento — abra a encomenda para tentar de novo.'
            },
            es: {
                subject: 'El pago del envío no se completó — {{orderNumber}}',
                body: 'No pudimos cobrar la diferencia de envío de {{currency}} {{amountFormatted}} del pedido {{orderNumber}}. No se cobró nada; tu paquete espera ese pago — abre el pedido para intentarlo otra vez.'
            },
            ar: {
                subject: 'لم يتم دفع رسوم التوصيل — {{orderNumber}}',
                body: 'لم نتمكن من تحصيل فرق التوصيل البالغ {{currency}} {{amountFormatted}} للطلب {{orderNumber}}. لم يُخصم أي مبلغ؛ طردك ينتظر هذا الدفع — افتح الطلب لإعادة المحاولة.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_delivery_fee_topup_failed',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{orderNumber}}']
            }
        },
        button: ORDER_BUTTON,
        actions: [RETRY_DELIVERY_TOPUP]
    },

    'order.combined_delivery.answered': {
        base: {
            en: {
                subject: 'Answer to your combined delivery request — {{orderNumber}}',
                body: '{{agencyName}} {{answerLine}} Open the order to see your delivery fees.'
            },
            fr: {
                subject: 'Réponse à votre demande de livraison groupée — {{orderNumber}}',
                body: '{{agencyName}} {{answerLine}} Ouvrez la commande pour voir vos frais de livraison.'
            },
            pt: {
                subject: 'Resposta ao seu pedido de entrega conjunta — {{orderNumber}}',
                body: '{{agencyName}} {{answerLine}} Abra a encomenda para ver as taxas de entrega.'
            },
            es: {
                subject: 'Respuesta a tu solicitud de envío combinado — {{orderNumber}}',
                body: '{{agencyName}} {{answerLine}} Abre el pedido para ver tus tarifas de envío.'
            },
            ar: {
                subject: 'رد على طلب التوصيل المجمّع — {{orderNumber}}',
                body: '{{agencyName}} {{answerLine}} افتح الطلب لعرض رسوم التوصيل.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_order_combined_delivery_answered',
                bodyParams: ['{{orderNumber}}', '{{agencyName}}', '{{answerLine}}']
            }
        },
        button: ORDER_BUTTON
    },

    // ══ Support requests (GAP-012) ═══════════════════════════════════════════
    //
    // ⚠ **The copy never quotes the reply, and that is a decision rather than an
    // omission.** A ticket note can be 5000 characters, may be written by a
    // vendor about another customer's order, and reaches a lock screen and a
    // WhatsApp template with a fixed parameter budget. A Meta template parameter
    // additionally cannot contain a newline, so a pasted reply would fail the
    // send outright. The notification says an answer arrived and links to it.
    //
    // `{{subject}}` is the customer's OWN words — they wrote the request — so it
    // is the one piece of content safe to echo. The handler truncates it.

    'ticket.replied': {
        base: {
            en: {
                subject: 'We replied about "{{subject}}"',
                body: 'There is a new reply on your support request about "{{subject}}". Open it to read the answer.'
            },
            fr: {
                subject: 'Nous avons répondu à « {{subject}} »',
                body: 'Il y a une nouvelle réponse à votre demande d\'assistance concernant « {{subject}} ». Ouvrez-la pour lire la réponse.'
            },
            pt: {
                subject: 'Respondemos sobre "{{subject}}"',
                body: 'Há uma nova resposta ao seu pedido de apoio sobre "{{subject}}". Abra-o para ler a resposta.'
            },
            es: {
                subject: 'Respondimos sobre "{{subject}}"',
                body: 'Hay una nueva respuesta en tu solicitud de soporte sobre "{{subject}}". Ábrela para leer la respuesta.'
            },
            ar: {
                subject: 'لقد رددنا بخصوص "{{subject}}"',
                body: 'هناك رد جديد على طلب الدعم الخاص بك بخصوص "{{subject}}". افتحه لقراءة الرد.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_ticket_replied',
                bodyParams: ['{{subject}}']
            }
        },
        button: TICKET_BUTTON,
        /**
         * ⚠ **`tkt:<id>:rp`, NOT `tkt:reply:<id>` — the two the other way round.** The ticket
         * parser requires a 24-hex id as the FIRST segment and reads a sub-word second
         * (`rp`/`ph`/`cl`), so the reversed form returned null and the tap was refused. This
         * is the shape `ticketReplyActionId` builds and the one the request card already draws.
         */
        actions: [{ token: 'tkt:{{ticketId}}:rp', label: REPLY_HERE_LABEL, templateFallback: 'tkt:new' }]
    },

    'ticket.awaiting_customer': {
        base: {
            en: {
                subject: 'We need something from you: "{{subject}}"',
                body: 'We cannot go further with your request about "{{subject}}" until you reply. Open it and let us know.'
            },
            fr: {
                subject: 'Nous avons besoin de vous : « {{subject}} »',
                body: 'Nous ne pouvons pas avancer sur votre demande concernant « {{subject}} » tant que vous n\'avez pas répondu. Ouvrez-la pour nous répondre.'
            },
            pt: {
                subject: 'Precisamos de algo de si: "{{subject}}"',
                body: 'Não conseguimos avançar com o seu pedido sobre "{{subject}}" enquanto não responder. Abra-o e diga-nos.'
            },
            es: {
                subject: 'Necesitamos algo de tu parte: "{{subject}}"',
                body: 'No podemos avanzar con tu solicitud sobre "{{subject}}" hasta que respondas. Ábrela y cuéntanos.'
            },
            ar: {
                subject: 'نحتاج منك شيئًا: "{{subject}}"',
                body: 'لا يمكننا المتابعة في طلبك بخصوص "{{subject}}" حتى ترد علينا. افتحه وأخبرنا.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'customer_ticket_awaiting_customer',
                bodyParams: ['{{subject}}']
            }
        },
        button: TICKET_BUTTON,
        /**
         * ⚠ **`tkt:<id>:rp`, NOT `tkt:reply:<id>` — the two the other way round.** The ticket
         * parser requires a 24-hex id as the FIRST segment and reads a sub-word second
         * (`rp`/`ph`/`cl`), so the reversed form returned null and the tap was refused. This
         * is the shape `ticketReplyActionId` builds and the one the request card already draws.
         */
        actions: [{ token: 'tkt:{{ticketId}}:rp', label: REPLY_HERE_LABEL, templateFallback: 'tkt:new' }]
    },

    // `{{reopenLine}}` is substituted by the handler, already localized, because
    // whether a customer may still reply depends on which terminal status this
    // is — `resolved` can be reopened, `closed` cannot — and telling them to
    // "reply if this is not sorted" on a closed request sends them nowhere.
    'ticket.resolved': {
        base: {
            en: {
                subject: 'Sorted: "{{subject}}"',
                body: 'We have marked your request about "{{subject}}" as done. {{reopenLine}}'
            },
            fr: {
                subject: 'Résolu : « {{subject}} »',
                body: 'Nous avons marqué votre demande concernant « {{subject}} » comme terminée. {{reopenLine}}'
            },
            pt: {
                subject: 'Resolvido: "{{subject}}"',
                body: 'Marcámos o seu pedido sobre "{{subject}}" como concluído. {{reopenLine}}'
            },
            es: {
                subject: 'Resuelto: "{{subject}}"',
                body: 'Hemos marcado tu solicitud sobre "{{subject}}" como terminada. {{reopenLine}}'
            },
            ar: {
                subject: 'تم الحل: "{{subject}}"',
                body: 'لقد وضعنا علامة على طلبك بخصوص "{{subject}}" بأنه منتهٍ. {{reopenLine}}'
            }
        },
        whatsapp: {
            text: {},
            // ⚠ TWO params, and the second is `reopenLine`. A Meta template's parameter
            // count must match what was approved, and `reopenLine` is a whole sentence
            // that varies by outcome — so it travels as a parameter rather than being
            // baked into the approved body, which would make one of the two outcomes a lie.
            template: {
                name: 'customer_ticket_resolved',
                bodyParams: ['{{subject}}', '{{reopenLine}}']
            }
        },
        button: TICKET_BUTTON,
        /**
         * ⚠ **`tkt:<id>`, because there is NO REOPEN SHAPE AT ALL.** This was not a misspelling:
         * `TicketTap` has seven kinds and reopen is not among them, so the feature behind the
         * button did not exist. Opening the request card is the honest answer — the card carries
         * the request's state and its own controls, including Reply, which is how a resolved
         * request is actually reopened (`ticketReopenLine` says exactly that).
         *
         * ⚠ **`{{reopenableTicketId}}` is kept deliberately.** It is set only for a RESOLVED
         * request and never a closed one, so the button still appears exactly where the copy
         * promises a reply will be read, and vanishes at a door the platform has shut. Both are
         * still driven by one boolean.
         */
        actions: [{ token: 'tkt:{{reopenableTicketId}}', label: NOT_SORTED_LABEL, templateFallback: 'tkt:new' }]
    },

    // ══ The basket ═══════════════════════════════════════════════════════════

    /**
     * ⭐ The abandoned-basket reminder — raised by `AbandonedCartWorker`, never by an event.
     *
     * ⛔ **NO TEMPLATE, on purpose** (owner's ruling 2026-09-27, plan Q-6). It is sent inside
     * the customer's own 24-hour window or not on WhatsApp at all: a basket built in the chat
     * was built by messaging, which opened the window. Outside it, the in-app row and
     * Telegram still go; WhatsApp sends nothing. Listed in `IN_WINDOW_ONLY_SITUATIONS`, which
     * the boot check requires of any situation without a template.
     *
     * ⚠ **Never a price.** A price in a reminder is a promise the catalogue can break before
     * they come back. `{{itemSummary}}` names what is in it and nothing else.
     */
    'cart.abandoned': {
        base: {
            en: {
                subject: 'Still thinking it over?',
                body: 'Your basket is waiting: {{itemSummary}}. Pick up where you left off whenever you like.'
            },
            fr: {
                subject: 'Toujours en réflexion ?',
                body: 'Votre panier vous attend : {{itemSummary}}. Reprenez là où vous en étiez quand vous voulez.'
            },
            pt: {
                subject: 'Ainda a pensar?',
                body: 'O seu cesto está à sua espera: {{itemSummary}}. Continue de onde parou quando quiser.'
            },
            es: {
                subject: '¿Sigues pensándolo?',
                body: 'Tu carrito te espera: {{itemSummary}}. Continúa donde lo dejaste cuando quieras.'
            },
            ar: {
                subject: 'هل ما زلت تفكر؟',
                body: 'سلتك بانتظارك: {{itemSummary}}. أكمل من حيث توقفت متى شئت.'
            }
        },
        whatsapp: { text: {} },
        button: CART_BUTTON,
        /**
         * `cart:view` carries no placeholder, so it can never render empty — and its handler
         * returns the basket in the chat, where checkout is one more tap.
         */
        actions: [{ token: 'cart:view', label: SHOW_BASKET_LABEL }]
    },

    // ══ The account itself (ADR-A10 role closure) ════════════════════════════

    /**
     * An administrator asked to close this customer account. UNMUTABLE (no
     * `SITUATION_PREFERENCE` key). Copy shared with the three dashboard stacks
     * (`closureRequestedBase`) — "close", never "delete" (ADR-A02 D-2).
     *
     * The quick reply opens the bot's own closure preview, where the customer confirms or
     * declines in the chat; the URL button opens the storefront's account-closure page. The
     * token `acct:close` is pinned to `accountActionId('close')` at boot (see `REVIEW_CLOSURE`).
     */
    'account.closure_requested': {
        base: closureRequestedBase(CLOSURE_SUBJECT.customer),
        whatsapp: {
            text: {},
            template: {
                name: 'customer_account_closure_requested',
                bodyParams: ['{{reason}}', '{{expiresAt}}']
            }
        },
        button: CLOSURE_BUTTON,
        actions: [REVIEW_CLOSURE]
    }
};

/**
 * The situations that deliberately have NO WhatsApp template — sent on WhatsApp only inside
 * the customer's 24-hour window. The boot check requires a template of every situation NOT
 * listed here, so a template cannot go missing by accident; it can only be left out on purpose.
 */
export const IN_WINDOW_ONLY_SITUATIONS: ReadonlySet<CustomerNotificationType> = new Set(['cart.abandoned']);

/**
 * "Blue dress" · "Blue dress and 2 more", localized. The basket reminder's one value: what is
 * in the basket, never what it costs. Titles are the cart's own snapshots.
 */
export function cartItemSummary(titles: string[], lang: Language): string {
    const first = titles[0] ?? '';
    const more = titles.length - 1;
    if (more <= 0) return first;
    const tail: Record<Language, string> = {
        en: `and ${more} more`,
        fr: `et ${more} autre${more > 1 ? 's' : ''}`,
        pt: `e mais ${more}`,
        es: `y ${more} más`,
        ar: `و${more} أخرى`,
    };
    return `${first} ${tail[lang] ?? tail.en}`;
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

/**
 * Fail fast if any situation is missing a base translation for a supported
 * language. Called at notification consumer startup, so a half-translated
 * catalog stops the boot rather than silently sending English to everyone.
 */
export function assertCustomerCatalogComplete(): void {
    for (const situation of Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[]) {
        const hasTemplate = CUSTOMER_NOTIFICATION_CATALOG[situation].whatsapp.template !== undefined;
        if (hasTemplate === IN_WINDOW_ONLY_SITUATIONS.has(situation)) {
            throw createAppError(
                ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE,
                500,
                hasTemplate
                    ? `'${situation}' is listed as in-window-only but names a template`
                    : `'${situation}' has no WhatsApp template and is not listed in IN_WINDOW_ONLY_SITUATIONS — out of window it would reach nobody`
            );
        }
        for (const lang of SUPPORTED_LANGUAGES) {
            if (!CUSTOMER_NOTIFICATION_CATALOG[situation].base[lang]) {
                throw createAppError(
                    ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE,
                    500,
                    `Missing '${lang}' base copy for customer notification situation '${situation}'`
                );
            }
        }
    }
    assertCustomerQuickRepliesSendable();
    // The closure quick reply is a literal for the § 20 token scan; the builder owns its grammar.
    if (REVIEW_CLOSURE.token !== accountActionId('close')) {
        throw createAppError(
            ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE,
            500,
            `account.closure_requested quick reply '${REVIEW_CLOSURE.token}' disagrees with accountActionId('close') = '${accountActionId('close')}'`
        );
    }
    // The delivery-fee quick replies (ADR-A11, W-H): literals for the same scan, the builders' grammar.
    for (const def of [SEE_DELIVERY_FEE, PAY_DELIVERY_TOPUP, RETRY_DELIVERY_TOPUP]) {
        if (def.token !== deliveryFeeOrderActionId('{{orderId}}') || def.templateFallback !== deliveryFeeListActionId()) {
            throw createAppError(
                ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE,
                500,
                `delivery-fee quick reply '${def.token}' / '${def.templateFallback}' disagrees with deliveryFeeOrderActionId / deliveryFeeListActionId`
            );
        }
    }
}

/**
 * The three caps a quick reply must satisfy on the tightest channel that renders
 * it, checked at boot rather than discovered on a customer's handset.
 *
 * Each of these fails SILENTLY in production if it is not checked here:
 *
 *  - an over-long **label** is truncated by the WhatsApp builder, so the customer
 *    reads a clipped word rather than seeing an error;
 *  - an over-long **token** is refused by Telegram as `BUTTON_DATA_INVALID`,
 *    which fails the whole `sendMessage` — the message does not arrive at all;
 *  - a **fourth button** is refused by WhatsApp for the whole interactive
 *    message, same outcome.
 *
 * ⚠ **The token budget is measured with every placeholder expanded to a 24-character
 * Mongo id**, which is what all of them actually carry. Measuring the literal
 * `{{bookingId}}` would pass a token that cannot fit its own argument — the
 * placeholder is 13 characters and its value is 24.
 */
export function assertCustomerQuickRepliesSendable(): void {
    /** Telegram `callback_data`. The binding cap: WhatsApp's reply-button id allows 256. */
    const MAX_TOKEN_BYTES = 64;
    /** `WA_LIMITS.BUTTON_REPLY_TITLE`. Not imported — the notifications stack does not depend on the WhatsApp module. */
    const MAX_LABEL_CHARS = 20;
    /** One WhatsApp interactive message. */
    const MAX_ACTIONS = 3;
    const SAMPLE_ID = 'a'.repeat(24);

    const fail = (message: string): never => {
        throw createAppError(ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE, 500, message);
    };

    for (const situation of Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[]) {
        const actions = CUSTOMER_NOTIFICATION_CATALOG[situation].actions;
        if (!actions) continue;

        if (actions.length > MAX_ACTIONS) {
            fail(`Situation '${situation}' has ${actions.length} quick replies; WhatsApp renders at most ${MAX_ACTIONS}`);
        }

        const seen = new Set<string>();
        for (const action of actions) {
            const placeholders = tokenPlaceholders(action.token);

            // A token with no placeholder is legal (a bare verb such as `cart:view`), but a
            // token that is ONLY a placeholder, or carries none of our verb grammar, is not.
            if (!/^[a-z]+:/.test(action.token)) {
                fail(`Quick-reply token '${action.token}' on '${situation}' does not start with a verb`);
            }
            if (/\s/.test(action.token)) {
                fail(`Quick-reply token '${action.token}' on '${situation}' contains whitespace`);
            }

            let widest = action.token;
            for (const key of placeholders) {
                // `key` came from `tokenPlaceholders`, whose pattern captures `(\w+)` — so it
                // is word characters BY CONSTRUCTION and cannot carry regex syntax. This runs
                // at boot over the catalogue's own literals; no request value reaches it.
                // Line-wise with the reason, as the ban's comment prescribes for a static
                // pattern — never file-wide, which would drop the other two bans here.
                // eslint-disable-next-line no-restricted-syntax
                widest = widest.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), SAMPLE_ID);
            }
            const bytes = Buffer.byteLength(widest, 'utf8');
            if (bytes > MAX_TOKEN_BYTES) {
                fail(`Quick-reply token '${action.token}' on '${situation}' is ${bytes} bytes with ids expanded; Telegram allows ${MAX_TOKEN_BYTES}`);
            }

            if (seen.has(action.token)) {
                fail(`Situation '${situation}' repeats quick-reply token '${action.token}'`);
            }
            seen.add(action.token);

            for (const lang of SUPPORTED_LANGUAGES) {
                const label = action.label[lang];
                if (!label) {
                    fail(`Quick reply '${action.token}' on '${situation}' is missing its '${lang}' label`);
                }
                if ([...label].length > MAX_LABEL_CHARS) {
                    fail(`Quick-reply label '${label}' (${lang}) on '${situation}' is ${[...label].length} characters; the cap is ${MAX_LABEL_CHARS}`);
                }
            }

            // ⛔ Out of window a template button cannot be dropped — see `templateFallback`.
            if (placeholders.length > 0 && !action.templateFallback) {
                fail(`Quick reply '${action.token}' on '${situation}' carries a placeholder but no templateFallback; out of window its button would be shown with no payload`);
            }
            if (action.templateFallback !== undefined
                && (tokenPlaceholders(action.templateFallback).length > 0
                    || !/^[a-z]+:\S+$/.test(action.templateFallback))) {
                fail(`templateFallback '${action.templateFallback}' on '${situation}' must be a placeholder-free verb token`);
            }
        }

        /**
         * WhatsApp desktop does not render a template holding 4+ buttons or a URL + quick-reply
         * mix beyond one URL and two quick replies. Counted in TEMPLATE buttons, which is what
         * the approved template holds — not in chat actions.
         */
        const templateButtons = customerTemplateQuickReplyLabels(situation).length;
        if (CUSTOMER_NOTIFICATION_CATALOG[situation].button && templateButtons > MAX_TEMPLATE_QUICK_REPLIES_WITH_URL) {
            fail(`Situation '${situation}' would give its template ${templateButtons} quick replies beside a URL button; WhatsApp desktop renders at most ${MAX_TEMPLATE_QUICK_REPLIES_WITH_URL}`);
        }
    }
}

/** 1 URL + 2 quick replies — the desktop-rendering limit, not Meta's larger caps. */
const MAX_TEMPLATE_QUICK_REPLIES_WITH_URL = 2;

/**
 * A situation's quick replies as the approved TEMPLATE holds them: adjacent actions that share
 * one label object are ONE template button.
 *
 * ⚠ **Why grouping exists.** A chat message draws only the actions whose ids resolved, so two
 * mutually exclusive actions with one label (`booking.payment_failed`'s price and balance
 * "Try again") show as one button there. A template's buttons are fixed at approval, so
 * listing both would approve a template with "Try again" twice. The group is the button; the
 * member that resolves at send time supplies its payload.
 *
 * Grouping is by label IDENTITY (the same `Record` object), deliberately not by equal text:
 * two different actions that merely translate alike must stay two buttons.
 */
function templateButtonGroups(situation: CustomerNotificationType): QuickReplyDef[][] {
    const groups: QuickReplyDef[][] = [];
    for (const action of CUSTOMER_NOTIFICATION_CATALOG[situation].actions ?? []) {
        const last = groups[groups.length - 1];
        if (last && last[0].label === action.label) last.push(action);
        else groups.push([action]);
    }
    return groups;
}

/**
 * The quick-reply button labels the approved template carries, in order — what the generator
 * submits. Read from the same groups the send path fills, so the two agree by construction.
 */
export function customerTemplateQuickReplyLabels(situation: CustomerNotificationType): Array<Record<Language, string>> {
    return templateButtonGroups(situation).map(group => group[0].label);
}

/**
 * The payload each template quick-reply button carries on THIS send, one per button, in the
 * template's order — never fewer, because a template button cannot be dropped.
 *
 * Per button: the first member whose placeholders all resolve, else the group's
 * `templateFallback`. The boot assertion guarantees one of the two exists.
 */
export function renderCustomerTemplateQuickReplies(
    situation: CustomerNotificationType,
    ctx: RenderContext
): string[] {
    return templateButtonGroups(situation).map(group => {
        for (const action of group) {
            const supplied = tokenPlaceholders(action.token).every(key => {
                const value = ctx[key];
                return value !== undefined && value !== null && String(value).length > 0;
            });
            if (supplied) return renderTemplate(action.token, ctx);
        }
        const fallback = group.find(action => action.templateFallback)?.templateFallback;
        if (!fallback) {
            throw createAppError(ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE, 500,
                `No payload for a '${situation}' template quick reply: no member resolved and none declares templateFallback`);
        }
        return fallback;
    });
}

/** Pick a language's text, falling back to the default language. */
function pickLang<T>(map: Partial<Record<Language, T>>, lang: Language): T | undefined {
    return map[lang] ?? map[DEFAULT_LANGUAGE];
}

/** Render the in-app (base) title/message for a situation in the given language. */
export function renderCustomerInApp(
    situation: CustomerNotificationType,
    lang: Language,
    ctx: RenderContext
): { title: string; message: string } {
    const base = pickLang(CUSTOMER_NOTIFICATION_CATALOG[situation].base, lang)!;
    return {
        title: renderTemplate(base.subject, ctx),
        message: renderTemplate(base.body, ctx)
    };
}

/**
 * Render a secondary-channel's text in the given language, applying the
 * channel + language override over the language's base.
 */
export function renderCustomerChannelText(
    situation: CustomerNotificationType,
    channel: 'email' | 'telegram' | 'whatsapp',
    lang: Language,
    ctx: RenderContext
): ChannelText {
    const entry = CUSTOMER_NOTIFICATION_CATALOG[situation];
    const base = pickLang(entry.base, lang)!;

    const overrideMap =
        channel === 'email'
            ? entry.email
            : channel === 'telegram'
                ? entry.telegram
                : entry.whatsapp.text;

    const override = overrideMap ? pickLang(overrideMap, lang) : undefined;

    return {
        subject: renderTemplate(override?.subject ?? base.subject, ctx),
        body: renderTemplate(override?.body ?? base.body, ctx)
    };
}

/** The Meta template name for a situation. */
export function customerWhatsAppTemplateName(situation: CustomerNotificationType): string | null {
    // null for an in-window-only situation (`IN_WINDOW_ONLY_SITUATIONS`), which has none.
    return CUSTOMER_NOTIFICATION_CATALOG[situation].whatsapp.template?.name ?? null;
}

/** Render the ordered WhatsApp template body parameters for a situation. */
export function renderCustomerWhatsAppTemplateParams(
    situation: CustomerNotificationType,
    lang: Language,
    ctx: RenderContext
): string[] {
    const tpl = CUSTOMER_NOTIFICATION_CATALOG[situation].whatsapp.template;
    if (!tpl) return [];
    const inApp = renderCustomerInApp(situation, lang, ctx);
    const merged: RenderContext = { ...ctx, title: inApp.title, message: inApp.message };
    return tpl.bodyParams.map(param => renderTemplate(param, merged));
}

/**
 * Resolve a situation's action button into a localized label + absolute URL.
 * Returns null when the situation has no button.
 *
 * ── Three addresses out, and they are NOT interchangeable ────────────────────
 *
 * The same button is delivered four ways and two of them prepend something of
 * their own, so one string cannot serve all of them:
 *
 * | field | shape | who reads it |
 * |---|---|---|
 * | `url` | absolute, **locale-prefixed** | the email button, the Telegram button, and `action.url` on the inbox row |
 * | `whatsappSuffix` | relative, **locale-prefixed**, no leading slash | the Meta template's dynamic URL suffix parameter |
 * | `urlSuffix` | relative, **locale-FREE** | `action.path` on the inbox row |
 *
 * ⚠ **`urlSuffix` must stay locale-free.** It is stored as `action.path`, and
 * the bot surface resolves that through `botStorefrontLink`, which adds the
 * locale itself — so a prefix baked in here reaches a customer as `/fr/fr/…`.
 *
 * ⚠ **`whatsappSuffix` must stay leading-slash-free.** Meta's approved button
 * URL is `{STOREFRONT_URL}/{{1}}` and Meta supplies the separator.
 *
 * The locale was missing from all of these until 2026-09-07: every button in
 * every email, WhatsApp and Telegram message opened the ENGLISH page, whatever
 * language the sentence beside it was written in. That fails nothing and logs
 * nothing — the page renders, in the wrong language.
 */
export function renderCustomerButton(
    situation: CustomerNotificationType,
    lang: Language,
    ctx: RenderContext,
    baseUrl: string | undefined
): { label: string; url: string; urlSuffix: string; whatsappSuffix: string } | null {
    const button = CUSTOMER_NOTIFICATION_CATALOG[situation].button;
    if (!button) return null;

    const urlSuffix = renderTemplate(button.urlSuffix, ctx);
    const label = button.label[lang] ?? button.label[DEFAULT_LANGUAGE];

    // `storefrontPath` always returns a leading slash; the WhatsApp parameter
    // must not carry one, so it is stripped for that field alone.
    const localizedPath = storefrontPath(urlSuffix, lang);
    const whatsappSuffix = localizedPath.slice(1);

    const trimmedBase = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
    const url = trimmedBase ? `${trimmedBase}${localizedPath}` : whatsappSuffix;

    return { label, url, urlSuffix, whatsappSuffix };
}

// ─── Quick replies: rendering (phase 10, stage 1) ────────────────────────────

/** Placeholder names inside a quick-reply token. Mirrors `renderTemplate`'s own syntax. */
const TOKEN_PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Names of every placeholder in a token, in order. A fresh regex per call —
 * `TOKEN_PLACEHOLDER` is a module-level `/g` regex and `matchAll` would otherwise
 * inherit a `lastIndex` from a previous caller.
 */
export function tokenPlaceholders(token: string): string[] {
    // Re-flagging a MODULE CONSTANT's own source, which is the exception the ban's comment
    // names explicitly (alongside core/logging/scrub.ts). The argument is `TOKEN_PLACEHOLDER`
    // three lines above, never the token being searched.
    // eslint-disable-next-line no-restricted-syntax
    return [...token.matchAll(new RegExp(TOKEN_PLACEHOLDER.source, 'g'))].map(m => m[1]);
}

/**
 * Resolve a situation's quick replies into `{ token, label }` pairs for a chat channel.
 *
 * ⛔ **THE DEAD-BUTTON GUARD CANNOT LOOK FOR A LEFTOVER `{{`.** `renderTemplate`
 * fills a missing key with an **EMPTY string** — so `pay:rt:{{transactionId}}`
 * becomes `pay:rt:`, **well formed, pointing at nothing**, with no `{{` left to
 * notice. A customer tapping it gets the dispatcher's unknown-action refusal,
 * which reads as *"this button expired"* on a message that arrived seconds ago.
 *
 * So the check is on the **CONTEXT**: a quick reply whose token has an unsupplied
 * placeholder is DROPPED, not sent.
 *
 * ⭐ **Two situations use this deliberately as their CONDITION**, rather than
 * growing a second mechanism for conditional buttons — and because
 * `{{reopenableTicketId}}` / `{{productId}}` then drive both the button and the
 * sentence from ONE boolean, the two cannot contradict each other:
 *
 *  - `ticket.resolved` — the token names `{{reopenableTicketId}}`, which the
 *    handler sets ONLY for a *resolved* request and never for a *closed* one. So
 *    "Not sorted" appears exactly where `reopenLine` already promises a reply
 *    will be read, and a closed request shows no button at a door we have shut.
 *  - `booking.cancelled` — `{{productId}}` is absent when the booking's product
 *    no longer exists, so "Book again" cannot offer a service that is gone.
 *
 * An empty string counts as unsupplied, because that is what a missing id
 * actually looks like by the time it reaches a context.
 */
export function renderCustomerQuickReplies(
    situation: CustomerNotificationType,
    lang: Language,
    ctx: RenderContext
): Array<{ token: string; label: string }> {
    const actions = CUSTOMER_NOTIFICATION_CATALOG[situation].actions;
    if (!actions || actions.length === 0) return [];

    const resolved: Array<{ token: string; label: string }> = [];
    for (const action of actions) {
        const supplied = tokenPlaceholders(action.token).every(key => {
            const value = ctx[key];
            return value !== undefined && value !== null && String(value).length > 0;
        });
        if (!supplied) continue;

        resolved.push({
            token: renderTemplate(action.token, ctx),
            label: action.label[lang] ?? action.label[DEFAULT_LANGUAGE]
        });
    }
    return resolved;
}

/**
 * The "and here is the link" line appended to a chat message whose URL button was
 * displaced by quick replies.
 *
 * ── Why this is composed and NOT a per-language copy key ────────────────────
 *
 * It was specified as one shared `viewLine` key × five languages. Composing it
 * from `renderCustomerButton`'s own output is the stronger form of that same
 * intent: the label and the URL are **the same two values the CTA button would
 * have carried**, read from one place, so the line and the button it replaces
 * cannot drift — there is no second string to update when a suffix moves.
 *
 * **The only translated part is the label, which is already localized on the
 * `ButtonDef`, so five keys would add a drift surface and buy no translation.**
 *
 * ⚠ **Only where a quick reply actually displaced the button.** WhatsApp's
 * interactive message is either reply buttons or a CTA URL — never both — so
 * this line exists to stop the link disappearing. A situation with no quick
 * reply keeps its CTA button and must NOT gain this line.
 */
export function viewLineFor(
    button: { label: string; url: string } | null
): string {
    return button ? `${button.label}: ${button.url}` : '';
}
