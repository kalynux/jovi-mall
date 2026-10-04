import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from '../domain/bot-error-copy';

/**
 * Every word the in-app screens render, in five languages.
 *
 * ── WHY A FIFTH COPY TABLE AND NOT A SIXTH SET OF KEYS ON AN EXISTING ONE ───
 * The four that exist are each scoped to a surface with its own constraints:
 * `bot-error-copy` words refusals, `bot-onboarding-copy` words a checklist,
 * `bot-chrome-copy` words CHAT CONTROLS and is capped at WhatsApp's twenty characters, and
 * `miniapp-copy` words the old product rail.
 *
 * ⚠ **The chrome table's caps are the reason this is separate.** A screen is a web page: it
 * has room for a sentence, a heading and an empty-state explanation, none of which fit in
 * twenty characters. Putting page copy in the chrome table would mean either exempting keys
 * from the cap — which is how the cap stops meaning anything — or writing page copy to a chat
 * button's budget.
 *
 * ⚠ **The PURCHASE button's label is deliberately NOT here.** It comes from
 * `resolvePurchaseAffordance().labelKey` and is resolved through `botChrome()` server-side, so
 * the word on the screen's button and the word on the chat card are the same word. Duplicating
 * it here is how a customer gets "Add to cart" in the chat and "Buy" on the screen for one
 * product.
 *
 * ⚠ **Declared in one pass, including keys whose screens are a later milestone**, for the
 * reason `bot-chrome-copy.ts` gives about its own table: several streams read this file and
 * `assertInAppCopyComplete` runs at BOOT, so a session adding a key mid-flight and missing a
 * translation stops the server for everyone.
 */

type Copy = Record<BotCopyLanguage, string>;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared — every screen can reach these
// ─────────────────────────────────────────────────────────────────────────────

const LOADING: Copy = {
    en: 'Loading…',
    fr: 'Chargement…',
    pt: 'A carregar…',
    es: 'Cargando…',
    ar: 'جارٍ التحميل…',
};

/** A request that failed for a reason the page cannot explain. */
const FAILED: Copy = {
    en: 'Something went wrong. Close this and ask me again in the chat.',
    fr: "Une erreur s'est produite. Fermez cette page et redemandez-moi dans la discussion.",
    pt: 'Algo falhou. Feche esta página e pergunte-me outra vez na conversa.',
    es: 'Algo salió mal. Cierra esta página y vuelve a pedírmelo en el chat.',
    ar: 'حدث خطأ ما. أغلق هذه الصفحة واطلب مني مرة أخرى في المحادثة.',
};

/**
 * The handle has lapsed.
 *
 * ⚠ **Worded as "ask again", never as "expired"**, and the distinction matters: the customer
 * did nothing wrong and has nothing to fix, so naming a session timeout tells them about our
 * plumbing. What they need is the one action that works.
 */
const EXPIRED: Copy = {
    en: 'This page is no longer available. Ask me again in the chat and I will open a fresh one.',
    fr: "Cette page n'est plus disponible. Redemandez-moi dans la discussion et j'en ouvrirai une nouvelle.",
    pt: 'Esta página já não está disponível. Pergunte-me outra vez na conversa e abro uma nova.',
    es: 'Esta página ya no está disponible. Pídemelo otra vez en el chat y abriré una nueva.',
    ar: 'هذه الصفحة لم تعد متاحة. اطلب مني مرة أخرى في المحادثة وسأفتح صفحة جديدة.',
};

const RETRY: Copy = {
    en: 'Try again',
    fr: 'Réessayer',
    pt: 'Tentar de novo',
    es: 'Reintentar',
    ar: 'حاول مجددًا',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Product listing
// ─────────────────────────────────────────────────────────────────────────────

const LISTING_HEADING: Copy = {
    en: 'Browse',
    fr: 'Parcourir',
    pt: 'Explorar',
    es: 'Explorar',
    ar: 'تصفّح',
};

const LISTING_EMPTY: Copy = {
    en: 'Nothing here yet. Ask me in the chat and I will look for something else.',
    fr: "Rien ici pour le moment. Demandez-moi dans la discussion et je chercherai autre chose.",
    pt: 'Ainda não há nada aqui. Pergunte-me na conversa e procuro outra coisa.',
    es: 'Aquí no hay nada todavía. Pídemelo en el chat y buscaré otra cosa.',
    ar: 'لا يوجد شيء هنا بعد. اسألني في المحادثة وسأبحث عن شيء آخر.',
};

const LOAD_MORE: Copy = {
    en: 'Load more',
    fr: 'Afficher plus',
    pt: 'Carregar mais',
    es: 'Cargar más',
    ar: 'تحميل المزيد',
};

const OUT_OF_STOCK: Copy = {
    en: 'Out of stock',
    fr: 'Épuisé',
    pt: 'Esgotado',
    es: 'Agotado',
    ar: 'غير متوفر',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Product detail
// ─────────────────────────────────────────────────────────────────────────────

/** The options picker's own heading — the reason this screen exists. */
const DETAIL_CHOOSE: Copy = {
    en: 'Choose',
    fr: 'Choisissez',
    pt: 'Escolha',
    es: 'Elige',
    ar: 'اختر',
};

/** Section heading over the similar-items strip on the detail screen. */
const DETAIL_SIMILAR: Copy = {
    en: 'Similar items',
    fr: 'Articles similaires',
    pt: 'Artigos semelhantes',
    es: 'Artículos similares',
    ar: 'منتجات مشابهة',
};

const DETAIL_NO_SIMILAR: Copy = {
    en: 'Nothing similar to show right now.',
    fr: 'Rien de similaire à afficher pour le moment.',
    pt: 'Nada de semelhante para mostrar de momento.',
    es: 'Nada similar que mostrar por ahora.',
    ar: 'لا يوجد شيء مشابه لعرضه حاليًا.',
};

const DETAIL_REVIEWS: Copy = {
    en: 'Reviews',
    fr: 'Avis',
    pt: 'Opiniões',
    es: 'Opiniones',
    ar: 'التقييمات',
};

const DETAIL_MORE_REVIEWS: Copy = {
    en: 'More reviews',
    fr: "Plus d'avis",
    pt: 'Mais opiniões',
    es: 'Más opiniones',
    ar: 'المزيد من التقييمات',
};

const DETAIL_NO_REVIEWS: Copy = {
    en: 'No reviews yet.',
    fr: "Pas encore d'avis.",
    pt: 'Ainda sem opiniões.',
    es: 'Aún no hay opiniones.',
    ar: 'لا توجد تقييمات بعد.',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Bookings — ONLY what a FORM needs and a page does not
//
//  ⚠ **Six keys landed here and four were deleted the same day.** `bookingsHeading`,
//  `bookingWhen`, `bookingPickTime` and `bookingConfirm` duplicated `listTitle`, `pickDay`,
//  `pickTime` and `confirm` in `domain/bot-booking-copy.ts`, which `bookingScreenCopy()` serves
//  to the Telegram pages AND the WhatsApp forms. Two tables for one screen is how a form and a
//  page start saying different things about the same appointment — so the request was withdrawn
//  by the stream that made it, which is the right way for a duplicate to die.
//
//  ⚠ **The two below are NOT duplicates and must survive the next sweep.** They exist only
//  because a FORM has a footer button and a page does not: a page's rows are tapped directly,
//  so nothing on the Telegram side ever needs the word "Open" or "See times". Delete them only
//  if the forms stop having footers.
// ─────────────────────────────────────────────────────────────────────────────

/** A Flow footer button. No page equivalent: a page row is tapped, not confirmed by a footer. */
const BOOKING_OPEN: Copy = {
    en: 'Open',
    fr: 'Ouvrir',
    pt: 'Abrir',
    es: 'Abrir',
    ar: 'فتح',
};

/** The other Flow footer button, on the day picker. Same reason. */
const BOOKING_SEE_TIMES: Copy = {
    en: 'See times',
    fr: 'Voir les horaires',
    pt: 'Ver horários',
    es: 'Ver horarios',
    ar: 'عرض الأوقات',
};

const DETAIL_DESCRIPTION: Copy = {
    en: 'Description',
    fr: 'Description',
    pt: 'Descrição',
    es: 'Descripción',
    ar: 'الوصف',
};

/** Shown when a variant must be picked before the purchase button does anything. */
const DETAIL_PICK_FIRST: Copy = {
    en: 'Pick an option first',
    fr: "Choisissez d'abord une option",
    pt: 'Escolha primeiro uma opção',
    es: 'Elige primero una opción',
    ar: 'اختر خيارًا أولاً',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Checkout
// ─────────────────────────────────────────────────────────────────────────────

const CHECKOUT_HEADING: Copy = {
    en: 'Checkout',
    fr: 'Commander',
    pt: 'Finalizar',
    es: 'Pagar',
    ar: 'إتمام الطلب',
};

const CHECKOUT_TOTAL: Copy = {
    en: 'Total',
    fr: 'Total',
    pt: 'Total',
    es: 'Total',
    ar: 'الإجمالي',
};

const CHECKOUT_ADDRESS: Copy = {
    en: 'Deliver to',
    fr: 'Livrer à',
    pt: 'Entregar em',
    es: 'Entregar en',
    ar: 'التوصيل إلى',
};

/**
 * ⚠ **The screen requires an EXISTING address and says so rather than collecting one.**
 * Capturing an address here would drag the whole geocoding candidate flow into a WebView. So
 * this is a real state with a real instruction, not an error.
 *
 * ⚠ **The instruction is the WEBSITE, not the chat** — the owner's rule of 2026-09-22: a new
 * delivery address is added on the website, and the chat CHOOSES among saved ones. This used to
 * say "send me your address in the chat", which contradicted that rule.
 */
const CHECKOUT_NO_ADDRESS: Copy = {
    en: 'You have no saved delivery address yet. Add one on our website, then come back to the chat and I will reopen checkout.',
    fr: "Vous n'avez pas encore d'adresse de livraison enregistrée. Ajoutez-en une sur notre site, puis revenez dans la discussion et je rouvrirai la commande.",
    pt: 'Ainda não tem uma morada de entrega guardada. Adicione uma no nosso site e volte à conversa — depois reabro a finalização.',
    es: 'Todavía no tienes una dirección de entrega guardada. Añade una en nuestra web y vuelve al chat; después reabriré el pago.',
    ar: 'لا يوجد لديك عنوان توصيل محفوظ بعد. أضف عنوانًا على موقعنا، ثم عُد إلى المحادثة وسأعيد فتح إتمام الطلب.',
};

/** The link under that message, to the website's address book. Kept short: it is a button. */
const CHECKOUT_ADD_ADDRESS: Copy = {
    en: 'Add an address',
    fr: 'Ajouter une adresse',
    pt: 'Adicionar morada',
    es: 'Añadir dirección',
    ar: 'إضافة عنوان',
};

/** Mobile money is the only live method, so the one field is a phone number. */
const CHECKOUT_PHONE: Copy = {
    en: 'Mobile money number',
    fr: 'Numéro mobile money',
    pt: 'Número de mobile money',
    es: 'Número de mobile money',
    ar: 'رقم المحفظة المحمولة',
};

/**
 * The address block's label when there is nothing to deliver.
 *
 * ⚠ **A LABEL, not a sentence, and that is the whole reason it exists.** A digital basket has
 * no delivery address, so `checkoutAddress` ("Deliver to") over a masked email is simply wrong.
 * The first attempt at this filled the address *value* with the masked identifier and left the
 * heading alone, which read as the shop promising to carry a download somewhere.
 *
 * Rendered, a digital basket reads:
 *
 *     Sent to your account
 *     j••••t@example.com
 *
 * The masked identifier underneath answers the only question a customer has there — *which
 * account* — which is why a full sentence would be worse: it would leave the panel below it
 * empty and looking broken.
 *
 * ⚠ **"Sent", never "Delivered".** Nothing is carried anywhere; for a download the account IS
 * the destination and there is no journey to describe.
 */
const CHECKOUT_DIGITAL_DELIVERY: Copy = {
    en: 'Sent to your account',
    fr: 'Envoyé sur votre compte',
    pt: 'Enviado para a sua conta',
    es: 'Enviado a tu cuenta',
    ar: 'يُرسل إلى حسابك',
};

/**
 * The checkout screen's own submit control.
 *
 * ⚠ **Not a rung of the purchase ladder, which is why it may live here at all.** The four
 * ladder labels come from `resolvePurchaseAffordance().labelKey` through `botChrome()`, so the
 * word on a product's button is the same word in the chat and on the screen. This one is
 * different in kind: it belongs to the checkout page, appears nowhere in chat, and has no
 * chat control to agree with.
 *
 * ⚠ **It says "pay", not "confirm" or "place order".** Mobile money is the only live method,
 * so the very next thing that happens is a prompt on the customer's handset asking them to
 * approve a charge — and a button that did not say so would make that prompt a surprise.
 */
const CHECKOUT_PAY: Copy = {
    en: 'Pay now',
    fr: 'Payer',
    pt: 'Pagar agora',
    es: 'Pagar ahora',
    ar: 'ادفع الآن',
};

/**
 * ⚠ **Said BEFORE the charge starts, because the screen cannot wait for it.** A Mini App is a
 * page the customer will leave and a Flow is a closed session; neither can hold the line open
 * while somebody approves a push on their handset. So the screen promises the answer in the
 * chat, and the chat delivers it.
 */
const CHECKOUT_WATCH_CHAT: Copy = {
    en: 'Approve the payment on your phone. I will tell you in the chat as soon as it lands.',
    fr: "Validez le paiement sur votre téléphone. Je vous le dirai dans la discussion dès qu'il est reçu.",
    pt: 'Aprove o pagamento no seu telefone. Digo-lhe na conversa assim que entrar.',
    es: 'Aprueba el pago en tu teléfono. Te lo diré en el chat en cuanto llegue.',
    ar: 'وافق على الدفع من هاتفك. سأخبرك في المحادثة بمجرد وصوله.',
};

/** The checkout screen's second button, beside Pay now (owner decision, 2026-09-27). */
const CHECKOUT_PAY_ON_DELIVERY: Copy = {
    en: 'Pay on delivery',
    fr: 'Payer à la livraison',
    pt: 'Pagar na entrega',
    es: 'Pagar al recibir',
    ar: 'الدفع عند الاستلام',
};

/**
 * After a pay-on-delivery order is placed from the screen. ⚠ "You will receive", not "I will
 * send": the delivery code goes to the customer's notification channel, not always this chat.
 */
const CHECKOUT_COD_PLACED: Copy = {
    en: 'Order placed. Pay the delivery agent in cash when it arrives — you will receive a delivery code for each parcel.',
    fr: 'Commande passée. Payez le livreur en espèces à la réception — vous recevrez un code de livraison pour chaque colis.',
    pt: 'Encomenda feita. Pague ao estafeta em dinheiro quando chegar — vai receber um código de entrega para cada encomenda.',
    es: 'Pedido hecho. Paga al repartidor en efectivo cuando llegue — recibirás un código de entrega por cada paquete.',
    ar: 'تم الطلب. ادفع لمندوب التوصيل نقدًا عند الاستلام — ستتلقى رمز توصيل لكل طرد.',
};

/**
 * Cash for delivery (W-F, ADR-A11 § Cash for delivery): the checkbox that pays the items now and
 * the delivery fee in cash to the rider. `{{toRider}}` is filled by the page with the SERVER's
 * formatted amount (`deliveryFeeCash.toRiderText`) — a string substitution, never arithmetic.
 */
const CHECKOUT_DELIVERY_CASH: Copy = {
    en: 'Pay the delivery fee ({{toRider}}) in cash to the rider',
    fr: 'Payer les frais de livraison ({{toRider}}) en espèces au livreur',
    pt: 'Pagar a taxa de entrega ({{toRider}}) em dinheiro ao estafeta',
    es: 'Pagar la tarifa de envío ({{toRider}}) en efectivo al repartidor',
    ar: 'ادفع رسوم التوصيل ({{toRider}}) نقدًا لمندوب التوصيل',
};

const CHECKOUT_DELIVERY_CASH_NOW: Copy = {
    en: 'Paid now',
    fr: 'Payé maintenant',
    pt: 'Pago agora',
    es: 'Pagado ahora',
    ar: 'المدفوع الآن',
};

// ─────────────────────────────────────────────────────────────────────────────
//  Orders and stores — screens are a later milestone, contract frozen here
// ─────────────────────────────────────────────────────────────────────────────

const ORDERS_HEADING: Copy = {
    en: 'Your orders',
    fr: 'Vos commandes',
    pt: 'As suas encomendas',
    es: 'Tus pedidos',
    ar: 'طلباتك',
};

const STORES_HEADING: Copy = {
    en: 'Shops',
    fr: 'Boutiques',
    pt: 'Lojas',
    es: 'Tiendas',
    ar: 'المتاجر',
};

// ── The WhatsApp forms (Stream F, 2026-09-16) ──────────────────────────────────
//
// ⚠ **These four land in WhatsApp Flow CONTROLS, which have hard character caps and fail at
// PUBLISH when a label is over** — see `FLOW_CAPS` below. Every other string in this file is a web
// page and wraps. The rest of what the forms show reuses keys already here (`listingHeading`,
// `detailChoose`, `outOfStock`, `checkoutPay`, …), so a French customer sees the same words on the
// Telegram screen and in the WhatsApp form.

/** Footer button that opens the chosen product. `loadMore` and `detailChoose` are the wrong verbs. */
const FLOW_OPEN_PRODUCT: Copy = {
    en: 'View product',
    fr: 'Voir le produit',
    pt: 'Ver produto',
    es: 'Ver producto',
    ar: 'عرض المنتج',
};

/** Footer button closing a form back to the chat — on the empty, gone and done screens. */
const FLOW_BACK_TO_CHAT: Copy = {
    en: 'Back to chat',
    fr: 'Retour à la discussion',
    pt: 'Voltar à conversa',
    es: 'Volver al chat',
    ar: 'العودة إلى المحادثة',
};

/**
 * The phone field's LABEL on the form.
 *
 * ⚠ **A separate key from `checkoutPhone`, because that one does not fit.** It is 22 characters in
 * Portuguese and Spanish, and a WhatsApp text-input label caps at 20 and refuses to publish over
 * it. Truncating mid-word was not an option. Longest here is 19.
 */
const FLOW_PHONE_LABEL: Copy = {
    en: 'Mobile money number',
    fr: 'Numéro mobile money',
    pt: 'Nº de mobile money',
    es: 'Nº de mobile money',
    ar: 'رقم الهاتف للدفع',
};

/**
 * The caption under that field.
 *
 * ⚠ **It no longer asks for the country code (2026-10-01).** The form and the page carry a country
 * picker beside the number (`core/validation/dial-codes.ts`), defaulting to the country of the
 * number on the account, so the customer types only their own number. The sentence still says what
 * an EMPTY field means, which nothing else on the screen does.
 */
const FLOW_PHONE_HINT: Copy = {
    en: 'Leave this empty to use the number on your account, or choose your country and type your number.',
    fr: 'Laissez vide pour utiliser le numéro de votre compte, ou choisissez votre pays et saisissez votre numéro.',
    pt: 'Deixe em branco para usar o número da sua conta, ou escolha o seu país e escreva o seu número.',
    es: 'Déjalo vacío para usar el número de tu cuenta, o elige tu país y escribe tu número.',
    ar: 'اتركه فارغًا لاستخدام الرقم المسجل في حسابك، أو اختر بلدك واكتب رقمك.',
};

/**
 * The country picker's label, on the form AND the page. ⚠ A Flow dropdown label caps at 20, like a
 * text input's; the longest here is 7.
 */
const CHECKOUT_COUNTRY: Copy = {
    en: 'Country',
    fr: 'Pays',
    pt: 'País',
    es: 'País',
    ar: 'البلد',
};

/**
 * Every page string.
 *
 * ⚠ **No caps — except the keys that ALSO land in a WhatsApp form control.** A screen is a web page
 * and wraps; the cap machinery for chat controls belongs to `bot-chrome-copy.ts`. That asymmetry is
 * the whole reason these are two tables. But a WhatsApp Flow renders some of these same strings
 * into controls with hard limits, and those few are listed in `FLOW_CAPS` rather than moved: a
 * French customer must see the same word on the Telegram screen and in the WhatsApp form, which
 * only one table can guarantee.
 */
const PAGE = Object.freeze({
    loading: LOADING,
    failed: FAILED,
    expired: EXPIRED,
    retry: RETRY,

    listingHeading: LISTING_HEADING,
    listingEmpty: LISTING_EMPTY,
    loadMore: LOAD_MORE,
    outOfStock: OUT_OF_STOCK,

    detailChoose: DETAIL_CHOOSE,
    detailDescription: DETAIL_DESCRIPTION,
    detailPickFirst: DETAIL_PICK_FIRST,
    detailSimilar: DETAIL_SIMILAR,
    detailNoSimilar: DETAIL_NO_SIMILAR,
    detailReviews: DETAIL_REVIEWS,
    detailMoreReviews: DETAIL_MORE_REVIEWS,
    detailNoReviews: DETAIL_NO_REVIEWS,

    // Flow footers only — every other booking word comes from `bookingScreenCopy()`.
    bookingOpen: BOOKING_OPEN,
    bookingSeeTimes: BOOKING_SEE_TIMES,

    checkoutHeading: CHECKOUT_HEADING,
    checkoutTotal: CHECKOUT_TOTAL,
    checkoutAddress: CHECKOUT_ADDRESS,
    checkoutDigitalDelivery: CHECKOUT_DIGITAL_DELIVERY,
    checkoutNoAddress: CHECKOUT_NO_ADDRESS,
    checkoutAddAddress: CHECKOUT_ADD_ADDRESS,
    checkoutPhone: CHECKOUT_PHONE,
    checkoutPay: CHECKOUT_PAY,
    checkoutWatchChat: CHECKOUT_WATCH_CHAT,
    checkoutPayOnDelivery: CHECKOUT_PAY_ON_DELIVERY,
    checkoutCodPlaced: CHECKOUT_COD_PLACED,
    checkoutDeliveryCash: CHECKOUT_DELIVERY_CASH,
    checkoutDeliveryCashNow: CHECKOUT_DELIVERY_CASH_NOW,

    ordersHeading: ORDERS_HEADING,
    storesHeading: STORES_HEADING,

    flowOpenProduct: FLOW_OPEN_PRODUCT,
    flowBackToChat: FLOW_BACK_TO_CHAT,
    flowPhoneLabel: FLOW_PHONE_LABEL,
    flowPhoneHint: FLOW_PHONE_HINT,
    checkoutCountry: CHECKOUT_COUNTRY,
});

export type InAppCopyKey = keyof typeof PAGE;
export type InAppCopy = Record<InAppCopyKey, string>;

/**
 * The whole table flattened to one language, for handing to a page.
 *
 * Per-key English fallback rather than a whole-table one: a single missing translation should
 * cost one string, not nineteen. `assertInAppCopyComplete` makes that unreachable at boot, so
 * this is the belt to that braces.
 */
export function inAppCopy(language: string | null | undefined): InAppCopy {
    const lang = toBotCopyLanguage(language);
    const out = {} as InAppCopy;
    for (const key of Object.keys(PAGE) as InAppCopyKey[]) {
        out[key] = PAGE[key][lang] ?? PAGE[key].en;
    }
    return out;
}

/**
 * Refuse to boot on a missing translation.
 *
 * No cap check, unlike `assertBotChromeCopyFits` — there is no control here to overflow. A
 * bare `Error`: this runs beside the other boot assertions with no request in flight.
 */
/**
 * Character caps for the keys that ALSO land in a WhatsApp Flow control.
 *
 * ⚠ **This moves a failure from Meta's PUBLISH step to process start.** A Flow control label over
 * its limit is refused when the Flow is published — which is a live-account action nobody runs
 * locally, so the mistake would otherwise surface on deploy day, at the one step that cannot be
 * rehearsed. Counted in CHARACTERS (code points), which is what the platform measures — not bytes.
 *
 *   35  a Footer label · 20  a TextInput label · 409  a TextCaption
 *
 * A key absent here is uncapped. The day another page string is put into a form control, give it a
 * cap here — an uncapped entry is never checked.
 */
const FLOW_CAPS: Partial<Record<InAppCopyKey, number>> = Object.freeze({
    flowOpenProduct: 35,
    flowBackToChat: 35,
    flowPhoneLabel: 20,
    flowPhoneHint: 409,
    checkoutCountry: 20,
});

export function assertInAppCopyComplete(): void {
    const gaps: string[] = [];

    for (const key of Object.keys(PAGE) as InAppCopyKey[]) {
        const cap = FLOW_CAPS[key];
        for (const lang of BOT_COPY_LANGUAGES) {
            const value = PAGE[key][lang];
            if (typeof value !== 'string' || value.trim().length === 0) {
                gaps.push(`${key}:${lang}`);
            } else if (cap !== undefined && Array.from(value).length > cap) {
                gaps.push(`${key}:${lang} is ${Array.from(value).length} characters, over the form cap of ${cap}`);
            }
        }
    }

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] in-app copy is incomplete or over a form cap: ${gaps.join(', ')}`);
    }
}

/** ⚠ Exported for the suites, which assert the key set against the screens that render it. */
export const __IN_APP_COPY = PAGE;
