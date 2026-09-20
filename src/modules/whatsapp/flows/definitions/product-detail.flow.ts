import type { FlowDefinition, FlowScreen } from './flow-definition.types';
import { FLOW_SCREEN_TITLE, NOTICE_SCREEN, noticeScreen } from './notice.screen';

/**
 * The product detail, as a WhatsApp Flow — the port of the Telegram `pd` screen.
 *
 * ── ⚠ THE OPTION MATRIX CANNOT CROSS, SO IT IS FLATTENED ────────────────────
 * `pd.html` draws one chip row per option and matches the customer's selections against
 * `variants[].valueIds` **positionally** to find the variant. A Flow screen can't search an
 * array or reprice between taps, so the matrix becomes **one list of variants**, each named by
 * `buildVariantDisplayName` (format "Size: M, Colour: Red") and priced in its own row. No
 * positional matching exists on this channel at all, so the misalignment defect `pd.html`'s own
 * comment warns about can't happen here.
 *
 *   | Telegram (`pd.html`)              | WhatsApp (this Flow)                             |
 *   |-----------------------------------|--------------------------------------------------|
 *   | chip rows per option              | one drop-down list of variants                    |
 *   | price updates as you choose       | price shown per row                               |
 *   | sold-out variant greyed           | the same, **disabled** (`enabled: false`)         |
 *   | button label follows the variant  | one label, from the default variant's affordance  |
 *
 * ⚠ **`Dropdown`, not `RadioButtonsGroup`, because of a cap.** Meta caps a radio group at 20
 * options and a drop-down at 200 (100 with images). A product with more than 20 variants would
 * lose the rest silently, and silently dropping something a customer could buy is not a trade
 * this platform makes. A drop-down takes one more tap to open. It never hides a variant.
 *
 * ── ⚠ TWO PRODUCT SCREENS, ONE DEFINITION ───────────────────────────────────
 * Meta's reference documents no `visible` property, so an `Image` can't be hidden when a
 * product has no picture, and an `Image` with no bytes is not a valid component. So there are
 * two screens, `PRODUCT` and `PRODUCT_NO_IMAGE`, and the endpoint picks one. Both are built by
 * `productScreen()` below from **one** list of children, with the image prepended or not. Two
 * hand-written screens would drift the first time one gained a caption.
 *
 * ⚠ **The image is base64 bytes, never a URL.** Meta's component reference: `src` is "Base64
 * of an image", "up to 300kb". The endpoint reads the bytes from storage only for a file whose
 * `access` is `public`, and **before** encoding, so a `quota_blocked` picture can't reach a
 * customer through the Flow after the platform stopped serving its address.
 *
 * ── THE FOOTER WRITES, AND WHY THAT IS SAFE HERE ────────────────────────────
 * The Telegram page performs the purchase itself (`POST /act`), so this Flow does too: the
 * footer is a `data_exchange` and the endpoint calls the same purchase core. ⚠ **Meta retries
 * an exchange on its own schedule**, which a browser does not, so the write must be idempotent
 * **per open Flow** — see `openRef` below and `flow-screens.ts`.
 *
 * ⚠ **"Per open", not "per handle", and the difference is a customer's second kettle.** The
 * cart ADDS rather than sets, so the guard's key decides what a repeat means. Keyed on the
 * handle and the variant alone, a customer who reopens the form ten minutes later and adds the
 * same variant again would be told "added" while nothing was added — the Telegram page adds
 * twice for two presses. So every open draws a fresh `openRef` and the footer sends it back:
 * a double submit inside ONE open is one add, the same variant in a LATER open is a new one.
 */

/** The data both product screens declare. `image` is present only on `PRODUCT`. */
function productData(withImage: boolean): FlowScreen['data'] {
    return {
        ...(withImage
            ? { image: { type: 'string' as const, __example__: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } }
            : {}),
        title: { type: 'string', __example__: 'Electric kettle 1.7L' },
        /** Store name and city. ⚠ City only — a ship-from address is private. */
        storeLine: { type: 'string', __example__: 'Chez Awa · Douala' },
        description: { type: 'string', __example__: 'Stainless steel, auto shut-off.' },
        chooseLabel: { type: 'string', __example__: 'Choose' },
        variants: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    /** ⚠ The VARIANT id, unlike the listing, which sends a product id. */
                    id: { type: 'string' },
                    /** ⚠ Capped at 30 by Meta; the adapter truncates and repeats the full name below. */
                    title: { type: 'string' },
                    /** Price, and the full name when the title was cut, and "Out of stock". */
                    description: { type: 'string' },
                    enabled: { type: 'boolean' },
                },
            },
            __example__: [
                { id: '66f1a2b3c4d5e6f708192a40', title: 'Size: M, Colour: Red', description: '12 500 FCFA', enabled: true },
                { id: '66f1a2b3c4d5e6f708192a41', title: 'Size: L, Colour: Red', description: '12 500 FCFA · Out of stock', enabled: false },
            ],
        },
        /** Bargain · Add to cart · Buy now · Book. Resolved server-side, capped at 20 upstream. */
        actionLabel: { type: 'string', __example__: 'Add to cart' },
        /**
         * A fresh random reference per open, echoed back by the footer. Carries no authority:
         * the only thing a forged one can do is make the customer's OWN retry count as a new
         * add to their OWN basket. It exists for the idempotency key and nothing else.
         */
        openRef: { type: 'string', __example__: 'k3J9xQ2mWp1aZ8rT' },
    };
}

function productScreen(id: string, withImage: boolean): FlowScreen {
    return {
        id,
        title: FLOW_SCREEN_TITLE,
        data: productData(withImage),
        layout: {
            type: 'SingleColumnLayout',
            children: [
                ...(withImage
                    ? [{ type: 'Image', src: '${data.image}', height: 240, 'scale-type': 'contain' }]
                    : []),
                { type: 'TextHeading', text: '${data.title}' },
                { type: 'TextCaption', text: '${data.storeLine}' },
                { type: 'TextBody', text: '${data.description}' },
                {
                    type: 'Dropdown',
                    name: 'variant',
                    label: '${data.chooseLabel}',
                    required: true,
                    'data-source': '${data.variants}',
                },
                {
                    type: 'Footer',
                    label: '${data.actionLabel}',
                    /**
                     * ⚠ **`data_exchange`: the endpoint performs the purchase**, as `POST /act`
                     * does for the Telegram page. The result is shown on the notice screen,
                     * which is why that screen is this screen's only route.
                     */
                    'on-click-action': {
                        name: 'data_exchange',
                        /**
                         * ⚠ `openRef` is `${data.…}`, not `${form.…}`: it is the value this open
                         * was drawn with, not something the customer chose.
                         */
                        payload: { variantId: '${form.variant}', openRef: '${data.openRef}' },
                    },
                },
            ],
        },
    };
}

export const PRODUCT_DETAIL_SCREEN = 'PRODUCT';
export const PRODUCT_DETAIL_NO_IMAGE_SCREEN = 'PRODUCT_NO_IMAGE';

export const PRODUCT_DETAIL_FLOW: FlowDefinition = {
    version: '6.0',
    data_api_version: '3.0',
    routing_model: {
        [PRODUCT_DETAIL_SCREEN]: [NOTICE_SCREEN],
        [PRODUCT_DETAIL_NO_IMAGE_SCREEN]: [NOTICE_SCREEN],
        [NOTICE_SCREEN]: [],
    },
    screens: [
        productScreen(PRODUCT_DETAIL_SCREEN, true),
        productScreen(PRODUCT_DETAIL_NO_IMAGE_SCREEN, false),
        noticeScreen('pd'),
    ],
};
