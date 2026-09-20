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
 * Capturing an address here would drag the whole geocoding candidate flow into a WebView; the
 * chat already does it well, with a map pin and a candidate picker. So this is a real state
 * with a real instruction, not an error.
 */
const CHECKOUT_NO_ADDRESS: Copy = {
    en: 'You have no saved delivery address yet. Close this and send me your address in the chat — then I will reopen checkout.',
    fr: "Vous n'avez pas encore d'adresse de livraison enregistrée. Fermez cette page et envoyez-moi votre adresse dans la discussion — je rouvrirai ensuite la commande.",
    pt: 'Ainda não tem uma morada de entrega guardada. Feche esta página e envie-me a sua morada na conversa — depois reabro a finalização.',
    es: 'Todavía no tienes una dirección de entrega guardada. Cierra esta página y envíame tu dirección en el chat — después reabriré el pago.',
    ar: 'لا يوجد لديك عنوان توصيل محفوظ بعد. أغلق هذه الصفحة وأرسل لي عنوانك في المحادثة — ثم سأعيد فتح إتمام الطلب.',
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
 * ⚠ **The country code is stated because nothing else on WhatsApp states it.** The platform's phone
 * schema refuses a local number without `+237`; on the Telegram screen a keyboard hint helps, and in
 * a WhatsApp form this sentence is the only thing between the customer and a refusal they cannot
 * explain.
 */
const FLOW_PHONE_HINT: Copy = {
    en: 'Leave this empty to use the number on your account. If you type one, include the country code, for example +237.',
    fr: "Laissez vide pour utiliser le numéro de votre compte. Si vous en saisissez un, ajoutez l'indicatif du pays, par exemple +237.",
    pt: 'Deixe em branco para usar o número da sua conta. Se escrever um, inclua o código do país, por exemplo +237.',
    es: 'Déjalo vacío para usar el número de tu cuenta. Si escribes uno, incluye el código de país, por ejemplo +237.',
    ar: 'اتركه فارغًا لاستخدام الرقم المسجل في حسابك. إذا كتبت رقمًا، فأضف رمز الدولة، مثل +237.',
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

    checkoutHeading: CHECKOUT_HEADING,
    checkoutTotal: CHECKOUT_TOTAL,
    checkoutAddress: CHECKOUT_ADDRESS,
    checkoutDigitalDelivery: CHECKOUT_DIGITAL_DELIVERY,
    checkoutNoAddress: CHECKOUT_NO_ADDRESS,
    checkoutPhone: CHECKOUT_PHONE,
    checkoutPay: CHECKOUT_PAY,
    checkoutWatchChat: CHECKOUT_WATCH_CHAT,

    ordersHeading: ORDERS_HEADING,
    storesHeading: STORES_HEADING,

    flowOpenProduct: FLOW_OPEN_PRODUCT,
    flowBackToChat: FLOW_BACK_TO_CHAT,
    flowPhoneLabel: FLOW_PHONE_LABEL,
    flowPhoneHint: FLOW_PHONE_HINT,
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
