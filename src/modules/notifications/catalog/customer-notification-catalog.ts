import { CustomerNotificationType } from '../models/customer-notification.model';
import type { ShipmentFailureReason } from '../../shipments/shipment.model';
import { renderTemplate, RenderContext } from './message-renderer';
import { Language, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './notification-i18n';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ChannelText, SituationMessages, ButtonDef } from './notification-catalog';
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

// ─── The catalog ─────────────────────────────────────────────────────────────

export const CUSTOMER_NOTIFICATION_CATALOG: Record<CustomerNotificationType, SituationMessages> = {
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
        button: BOOKING_BUTTON
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
        button: BOOKING_BUTTON
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
        button: PAY_BALANCE_BUTTON
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

    // Sent when the money could NOT be returned automatically. Silence here is
    // indistinguishable from a stolen payment, so this says a person is on it.
    'booking.refund.pending': {
        base: {
            en: {
                subject: 'Refund on the way: {{currency}} {{amountFormatted}}',
                body: 'We owe you {{currency}} {{amountFormatted}} for your cancelled {{serviceName}} booking. This one needs to be sent by hand, so our team is processing it — you do not need to do anything, and we will confirm when it is done.'
            },
            fr: {
                subject: 'Remboursement en cours : {{currency}} {{amountFormatted}}',
                body: 'Nous vous devons {{currency}} {{amountFormatted}} pour votre réservation {{serviceName}} annulée. Ce remboursement doit être envoyé manuellement : notre équipe s\'en occupe. Vous n\'avez rien à faire, nous confirmerons dès que c\'est fait.'
            },
            pt: {
                subject: 'Reembolso a caminho: {{currency}} {{amountFormatted}}',
                body: 'Devemos-lhe {{currency}} {{amountFormatted}} pela sua reserva cancelada de {{serviceName}}. Este reembolso tem de ser enviado manualmente e a nossa equipa está a tratar disso — não precisa de fazer nada e confirmaremos quando estiver concluído.'
            },
            es: {
                subject: 'Reembolso en camino: {{currency}} {{amountFormatted}}',
                body: 'Te debemos {{currency}} {{amountFormatted}} por tu reserva cancelada de {{serviceName}}. Este reembolso debe enviarse a mano y nuestro equipo lo está gestionando — no tienes que hacer nada y te confirmaremos cuando esté listo.'
            },
            ar: {
                subject: 'الاسترداد في الطريق: {{currency}} {{amountFormatted}}',
                body: 'ندين لك بمبلغ {{currency}} {{amountFormatted}} مقابل حجزك الملغى لـ {{serviceName}}. يجب إرسال هذا المبلغ يدويًا وفريقنا يعمل عليه — لا داعي لفعل أي شيء وسنؤكد لك عند الانتهاء.'
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
        button: TRACK_BUTTON
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
        button: ORDER_BUTTON
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
        button: TRACK_BUTTON
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
        button: TICKET_BUTTON
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
        button: TICKET_BUTTON
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
        button: TICKET_BUTTON
    }
};

// ─── Rendering helpers ───────────────────────────────────────────────────────

/**
 * Fail fast if any situation is missing a base translation for a supported
 * language. Called at notification consumer startup, so a half-translated
 * catalog stops the boot rather than silently sending English to everyone.
 */
export function assertCustomerCatalogComplete(): void {
    for (const situation of Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[]) {
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
export function customerWhatsAppTemplateName(situation: CustomerNotificationType): string {
    return CUSTOMER_NOTIFICATION_CATALOG[situation].whatsapp.template.name;
}

/** Render the ordered WhatsApp template body parameters for a situation. */
export function renderCustomerWhatsAppTemplateParams(
    situation: CustomerNotificationType,
    lang: Language,
    ctx: RenderContext
): string[] {
    const tpl = CUSTOMER_NOTIFICATION_CATALOG[situation].whatsapp.template;
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
