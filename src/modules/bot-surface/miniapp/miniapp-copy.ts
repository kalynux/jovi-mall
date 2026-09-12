import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from '../domain/bot-error-copy';

/**
 * Every word on the Mini App page.
 *
 * ── A FOURTH COPY TABLE, AND THE REASON IS THE SAME AS THE OTHER THREE ──────
 * `bot-error-copy` words a failure, `bot-onboarding-copy` a question, `bot-chrome-copy` a
 * control. This words a **page**, and it is here rather than in the HTML for exactly the
 * argument that put the other three on this side of the wire: the file that renders is not
 * the file that knows what language the customer reads.
 *
 * `page.html` is a static asset the build copies verbatim — nothing is templated into it per
 * request, which is what makes it safe to serve to anyone holding a handle. So the words
 * arrive with the data, from here, where a missing translation refuses the boot.
 *
 * ⚠ **`dir` travels with them.** Arabic is one of the five and a right-to-left page whose
 * `dir` says `ltr` puts the price on the wrong side of the card and the tick in the wrong
 * corner. It is derived here rather than guessed in the browser, because the browser is told
 * the language by us in the first place.
 */

type Copy = Record<BotCopyLanguage, string>;

/** What the page is. Deliberately not "Products" — it names what the customer just asked for. */
const HEADING: Copy = {
    en: 'What I found',
    fr: 'Ce que j’ai trouvé',
    pt: 'O que encontrei',
    es: 'Lo que he encontrado',
    ar: 'ما وجدته',
};

/** The one instruction on the page. Says that several may be picked, which is the whole point. */
const SUBHEADING: Copy = {
    en: 'Tap the ones you want, then add them to your basket.',
    fr: 'Touchez ceux qui vous intéressent, puis ajoutez-les à votre panier.',
    pt: 'Toque nos que quiser e adicione-os ao seu carrinho.',
    es: 'Toca los que quieras y añádelos a tu cesta.',
    ar: 'اضغط على ما يعجبك ثم أضفه إلى سلتك.',
};

/** The button before anything is chosen. Disabled, so it reads as a label rather than a promise. */
const ADD_NONE: Copy = {
    en: 'Choose a product',
    fr: 'Choisissez un produit',
    pt: 'Escolha um produto',
    es: 'Elige un producto',
    ar: 'اختر منتجًا',
};

/**
 * The button once something is chosen. `{n}` is the count.
 *
 * ⚠ **One string with a placeholder, and it is the only interpolation in any of the four
 * copy tables.** `bot-chrome-copy` refuses them on the stated ground that a half-filled
 * placeholder reaches the customer as `{{email}}` — true of a sentence assembled server-side
 * from optional data. Here the value is a count the page itself is holding, it can never be
 * absent, and the alternative is a singular and a plural per language plus a rule for Arabic's
 * dual, none of which a button this size needs.
 */
const ADD_SOME: Copy = {
    en: 'Add {n} to basket',
    fr: 'Ajouter {n} au panier',
    pt: 'Adicionar {n} ao carrinho',
    es: 'Añadir {n} a la cesta',
    ar: 'أضف {n} إلى السلة',
};

/** The link to the product's own storefront page. */
const DETAILS: Copy = {
    en: 'See details',
    fr: 'Voir les détails',
    pt: 'Ver detalhes',
    es: 'Ver detalles',
    ar: 'عرض التفاصيل',
};

/** The badge on a product that is listed but not in stock. It is still choosable. */
const OUT_OF_STOCK: Copy = {
    en: 'Out of stock',
    fr: 'Rupture de stock',
    pt: 'Esgotado',
    es: 'Agotado',
    ar: 'غير متوفر',
};

const ADDING: Copy = {
    en: 'Adding…',
    fr: 'Ajout en cours…',
    pt: 'A adicionar…',
    es: 'Añadiendo…',
    ar: 'جارٍ الإضافة…',
};

/** ⚠ Says the basket, not the order. Nothing here places one. */
const ADDED: Copy = {
    en: 'Added to your basket.',
    fr: 'Ajouté à votre panier.',
    pt: 'Adicionado ao seu carrinho.',
    es: 'Añadido a tu cesta.',
    ar: 'أُضيف إلى سلتك.',
};

/**
 * The generic failure, used only when the response carried no `customerMessage`.
 *
 * The page prefers the backend's own sentence whenever there is one — that is where every
 * specific remedy is written, in the customer's language, by the same table the chat uses.
 */
const FAILED: Copy = {
    en: 'That did not work. Please try again.',
    fr: "Cela n’a pas fonctionné. Veuillez réessayer.",
    pt: 'Não resultou. Tente novamente.',
    es: 'No ha funcionado. Inténtalo de nuevo.',
    ar: 'لم تنجح العملية. يُرجى المحاولة مرة أخرى.',
};

/** Every product in the set went off sale between the message and the tap. Rare, and real. */
const EMPTY: Copy = {
    en: 'These are no longer available. Ask me again and I will look for something else.',
    fr: 'Ceux-ci ne sont plus disponibles. Redemandez-moi et je chercherai autre chose.',
    pt: 'Estes já não estão disponíveis. Pergunte-me outra vez e procuro outra coisa.',
    es: 'Estos ya no están disponibles. Pregúntame otra vez y buscaré otra cosa.',
    ar: 'لم تعد هذه متاحة. اسألني مرة أخرى وسأبحث عن شيء آخر.',
};

const PAGE = Object.freeze({
    heading: HEADING,
    subheading: SUBHEADING,
    addNone: ADD_NONE,
    addSome: ADD_SOME,
    details: DETAILS,
    outOfStock: OUT_OF_STOCK,
    adding: ADDING,
    added: ADDED,
    failed: FAILED,
    empty: EMPTY,
} as const);

export type MiniAppCopyKey = keyof typeof PAGE;
export type MiniAppCopy = Record<MiniAppCopyKey, string>;

/** The whole page, in one language. Sent with the data so nothing is templated into the HTML. */
export function miniAppCopy(language: string | null | undefined): MiniAppCopy {
    const lang = toBotCopyLanguage(language);
    const out = {} as MiniAppCopy;
    for (const key of Object.keys(PAGE) as MiniAppCopyKey[]) {
        out[key] = PAGE[key][lang] ?? PAGE[key].en;
    }
    return out;
}

/** ⚠ Arabic is the only right-to-left language of the five. */
export function miniAppDirection(language: string | null | undefined): 'ltr' | 'rtl' {
    return toBotCopyLanguage(language) === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Refuse to boot on a missing translation — the same completeness assert the three chat copy
 * tables and the four notification catalogues run, for the same reason: a gap here is silent
 * until somebody who reads that language opens the page.
 */
export function assertMiniAppCopyComplete(): void {
    const gaps: string[] = [];
    for (const key of Object.keys(PAGE) as MiniAppCopyKey[]) {
        for (const lang of BOT_COPY_LANGUAGES) {
            const value = PAGE[key][lang];
            if (typeof value !== 'string' || value.trim().length === 0) {
                gaps.push(`${key}:${lang}`);
            }
        }
    }
    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] mini-app copy is incomplete: ${gaps.join(', ')}`);
    }
}

/** ⚠ Exported for `test:bot-surface`, which drives the completeness assert. */
export const __MINIAPP_COPY = PAGE;
