import type { FlowDefinition } from './flow-definition.types';

/**
 * The product detail, as a WhatsApp Flow — the port of the Telegram `pd` screen.
 *
 * ── ⚠ THE OPTION MATRIX CANNOT CROSS, AND THIS IS WHAT REPLACES IT ──────────
 * `pd.html` draws one chip row per option — Size, Colour — and matches the customer's
 * selections against `variants[].valueIds` **positionally** to find the variant, then updates
 * the price and enables the button. That algorithm is client-side array matching, and a Flow
 * screen cannot do it: a Flow renders declared data and submits a form, with no way to search
 * an array or recompute a price between taps.
 *
 * There were two ways across and the flatter one won:
 *
 *   **(a) Keep the option chips and resolve server-side.** Dropdowns per option, footer fires
 *   `data_exchange`, the endpoint matches the variant and returns the screen again with a
 *   price. Faithful to Telegram, and it costs **an encrypted round trip per selection** on a
 *   mobile connection — with the screen re-rendering under the customer each time.
 *
 *   **(b) Flatten the matrix into one list of variants.** One row per buyable variant, named
 *   by `buildVariantDisplayName` (*"Large · Blue"*), priced in its own description. One
 *   selection, no round trip, and — the part that decided it — **no positional matching
 *   anywhere**, so the defect `pd.html`'s own comment warns about (derive `valueIds` from the
 *   full option list while sending a filtered one, and every comparison silently misaligns,
 *   no variant ever matches, and nothing fails for anybody to find) cannot exist on this
 *   channel at all.
 *
 * (b), and the option list is not sent to this screen at all. It is a real difference and it
 * is stated where somebody will look for it rather than discovered:
 *
 *   | Telegram (`pd.html`)              | WhatsApp (this Flow)                        |
 *   |-----------------------------------|---------------------------------------------|
 *   | chip rows per option              | one flat list of variants                    |
 *   | price updates as you choose       | price shown per row, all at once             |
 *   | out-of-stock variant shown greyed | **omitted, with a line saying how many**     |
 *   | button label follows the variant  | one label, from the default variant          |
 *
 * ⚠ **Out-of-stock variants are OMITTED rather than shown disabled**, and this one is worth
 * the owner's eye. A Flow cannot disable one row of a selector, so the alternatives were to
 * list a variant the customer can select and then refuse — telling somebody *after* they
 * chose that they cannot have it — or to leave it out. Leaving it out cannot produce a dead
 * selection, and the count is reported (`soldOutNote`) so *"the blue one is sold out"* is
 * still answerable. **A product with NO buyable variant must not open this Flow at all**; the
 * chat says so instead, where it can offer something else.
 *
 * ⚠ **One footer label, taken from the default variant's affordance.** The four labels —
 * Bargain · Add to cart · Buy now · Book — are resolved server-side from the product's type
 * and negotiability, which are product-level facts, so a per-variant label would differ only
 * in constructed cases. `affordance.enabled` is what decides whether the Flow opens.
 */
export const PRODUCT_DETAIL_FLOW: FlowDefinition = {
    version: '6.0',
    data_api_version: '3.0',
    routing_model: { PRODUCT: [] },

    screens: [
        {
            id: 'PRODUCT',
            title: 'Product',
            terminal: true,

            data: {
                title: { type: 'string', __example__: 'Electric kettle 1.7L' },
                /** Store name and city on one line. ⚠ City only — a ship-from address is private. */
                storeLine: { type: 'string', __example__: 'Chez Awa · Douala' },
                description: { type: 'string', __example__: 'Stainless steel, auto shut-off.' },
                /**
                 * ⚠ **Sent as a URL and fetched by META'S SERVERS, not the handset.** A
                 * loopback, RFC1918 or carrier-NAT host is not a slow image — the fetch fails
                 * and the component fails with it. `isReachableByPlatformServers` already
                 * guards this for the chat cards and must guard it here too; an unreachable
                 * image is sent as an empty string and the component is skipped.
                 */
                imageUrl: { type: 'string', __example__: '' },
                variants: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            /** ⚠ The VARIANT id here — unlike the listing, which sends a product id. */
                            id: { type: 'string', __example__: '' },
                            /** `buildVariantDisplayName` — the same rule the Mini App uses. */
                            title: { type: 'string', __example__: '' },
                            /** The price, already formatted. Never a number: see `product-listing.flow.ts`. */
                            description: { type: 'string', __example__: '' },
                        },
                    },
                    __example__: [
                        { id: '66f1a2b3c4d5e6f708192a40', title: '1.7L · Steel', description: '12 500 FCFA' },
                        { id: '66f1a2b3c4d5e6f708192a41', title: '1.7L · Black', description: '12 500 FCFA' },
                    ],
                },
                /**
                 * *"2 options are sold out"*, or empty.
                 *
                 * ⚠ **Composed by the endpoint, in the customer's language, never assembled
                 * here.** A Flow cannot pluralise or translate — `${data.x}` renders what it
                 * is handed — and this platform keeps its copy in one place per audience.
                 */
                soldOutNote: { type: 'string', __example__: '' },
                /** Bargain · Add to cart · Buy now · Book. Resolved server-side. */
                actionLabel: { type: 'string', __example__: 'Add to cart' },
            },

            layout: {
                type: 'SingleColumnLayout',
                children: [
                    { type: 'Image', src: '${data.imageUrl}', height: 240 },
                    { type: 'TextHeading', text: '${data.title}' },
                    { type: 'TextCaption', text: '${data.storeLine}' },
                    { type: 'TextBody', text: '${data.description}' },
                    {
                        type: 'RadioButtonsGroup',
                        name: 'variant',
                        required: true,
                        'data-source': '${data.variants}',
                    },
                    { type: 'TextCaption', text: '${data.soldOutNote}' },
                    {
                        type: 'Footer',
                        /** ⚠ Dynamic, so one Flow serves all four purchase verbs. */
                        label: '${data.actionLabel}',
                        /**
                         * ⚠ **`complete`, not `data_exchange`.** Adding to a basket is a WRITE,
                         * and a write belongs on the bot surface behind its idempotency guard —
                         * not inside a Flow exchange, which has no `Idempotency-Key` and whose
                         * retries we do not control. The Flow reports the choice; the chat acts
                         * on it. That is the same split `co` makes for the same reason, one
                         * step earlier.
                         */
                        'on-click-action': {
                            name: 'complete',
                            payload: {
                                screen: 'pd',
                                variantId: '${form.variant}',
                            },
                        },
                    },
                ],
            },
        },
    ],
};

export const PRODUCT_DETAIL_SCREEN = 'PRODUCT';
