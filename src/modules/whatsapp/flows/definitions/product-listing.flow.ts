import type { FlowDefinition } from './flow-definition.types';

/**
 * The product listing, as a WhatsApp Flow — the port of the Telegram `pl` screen.
 *
 * ── ⚠ A CARD GRID CANNOT SURVIVE THE CROSSING, AND THIS IS WHAT REPLACES IT ─
 * `pl.html` draws a scrolling grid of tappable cards, each with its own image, price and
 * button. A WhatsApp Flow has no such component and cannot have one: a Flow screen is a
 * FORM — headings, text, inputs, selectors and a footer button — and the customer's answer is
 * one submitted form, not a tap on one card among many.
 *
 * So the grid becomes **a single-choice list with one footer button**. The customer picks a
 * product, then presses the button; on Telegram they tap the card and are already moving.
 * That is one extra press, and it is the honest trade rather than a defect.
 *
 * What a WhatsApp customer gets instead of the grid, stated plainly because somebody will ask:
 *
 *   | Telegram (`pl.html`)          | WhatsApp (this Flow)                          |
 *   |-------------------------------|-----------------------------------------------|
 *   | image per product             | **no per-row image** — see the note below      |
 *   | tap a card to open it         | select a row, then press Continue              |
 *   | infinite scroll via `cursor`  | **one page** — see the note below              |
 *   | price on the card             | price in the row's description                 |
 *
 * ⚠ **No per-row images, deliberately.** Image support in a selector is gated on recent Flow
 * JSON versions and on each row carrying base64 bytes rather than a URL — which would put the
 * whole page of product photography inside the encrypted response, on a mobile connection,
 * before anything renders. The listing is a *shortlist to choose from*; the picture belongs on
 * the detail screen, where there is one of them.
 *
 * ⚠ **One page, and paging was left out on purpose.** `pl.html` pages with a `cursor`, and a
 * Flow could do the same with a "Show more" branch — at the cost of a second encrypted round
 * trip per page and a screen that re-renders under the customer. The chat is better at this:
 * it already has a "See more" rung, and returning to it is a cheaper way to widen a search
 * than rebuilding a scroll inside a form. **This is a product decision and it is the owner's
 * to reverse** — it is recorded here rather than buried.
 *
 * ── THE SCREEN IS TERMINAL, AND THAT IS NOT A SHORTCUT ──────────────────────
 * Choosing a product **closes** the Flow and hands the choice back to the chat, which then
 * opens the detail screen. It does not navigate internally to a detail screen inside the same
 * Flow, and the reason is the session model rather than effort: each in-app screen has its own
 * handle with its own kind and its own lifetime, and `inAppSurfaceStore.read` refuses a
 * mismatched kind by construction. One Flow spanning listing and checkout would need one
 * handle spanning both — which would hand a freely-forwarded browse credential the reach of
 * the checkout one, and that single property is what protects an order from a forwarded URL.
 */
export const PRODUCT_LISTING_FLOW: FlowDefinition = {
    /**
     * ⚠ **Pinned, not "latest".** A Flow's rendering is frozen at publish, so a version bump
     * is a republish and a republish is gated on a working number. Pinning means the document
     * we test is the document Meta stores.
     */
    version: '6.0',
    data_api_version: '3.0',

    /** One screen, no destinations — but it must still appear, or it is unreachable. */
    routing_model: { PRODUCTS: [] },

    screens: [
        {
            id: 'PRODUCTS',
            title: 'Products',
            terminal: true,

            /**
             * ⚠ **This contract is validated against the endpoint's REAL response at publish
             * time.** The field names below mirror what the Telegram screen's `/data`
             * endpoint already returns (`heading`, `products[]`), so the two channels are
             * served from one projection rather than two that drift.
             */
            data: {
                heading: {
                    type: 'string',
                    __example__: 'Kettles',
                },
                products: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            /**
                             * ⚠ **`id` carries the PRODUCT id, and it is what comes back in
                             * the completion message.** Not the variant: this screen shows one
                             * row per product and a product's variants are chosen on the
                             * detail screen. Sending a variant id here would mean picking a
                             * size before the customer has seen the sizes.
                             */
                            id: { type: 'string', __example__: '' },
                            title: { type: 'string', __example__: '' },
                            /** Price, already formatted. See the ⚠ below on why. */
                            description: { type: 'string', __example__: '' },
                        },
                    },
                    __example__: [
                        { id: '66f1a2b3c4d5e6f708192a3b', title: 'Electric kettle 1.7L', description: '12 500 FCFA · Chez Awa' },
                        { id: '66f1a2b3c4d5e6f708192a3c', title: 'Stovetop kettle 2L', description: '7 900 FCFA · Chez Awa' },
                    ],
                },
            },

            layout: {
                type: 'SingleColumnLayout',
                children: [
                    {
                        type: 'TextHeading',
                        text: '${data.heading}',
                    },
                    {
                        /**
                         * ⚠ **`RadioButtonsGroup`, not `CheckboxGroup`.** One product opens
                         * one detail screen; a multi-select would collect a basket this
                         * screen has no way to price, and the next screen has no way to show.
                         */
                        type: 'RadioButtonsGroup',
                        name: 'product',
                        required: true,
                        'data-source': '${data.products}',
                    },
                    {
                        type: 'Footer',
                        label: 'Continue',
                        /**
                         * ⚠ **`complete`, not `data_exchange`.** The Flow ends here and the
                         * chosen product travels back to the conversation in the completion
                         * message — see the terminal-screen note in the header for why this
                         * does not navigate onward inside the Flow.
                         *
                         * ⚠ **`flow_token` is NOT added here.** Meta echoes it into the
                         * completion payload on its own; naming it in `payload` would put a
                         * second copy in, and the two could disagree if anything ever
                         * rewrote one.
                         */
                        'on-click-action': {
                            name: 'complete',
                            payload: {
                                productId: '${form.product}',
                            },
                        },
                    },
                ],
            },
        },
    ],
};

/**
 * ⚠ **Prices are formatted by the ENDPOINT and sent as strings, never as numbers.**
 *
 * A Flow cannot do arithmetic or currency formatting — `${data.price}` renders whatever it is
 * given — so a number would reach a customer as `12500`. More importantly, this platform
 * already refuses money maths outside the backend: `test:inapp-catalog` and
 * `test:inapp-checkout` both scan the Mini App pages for `toFixed`, `parseFloat` and
 * `Intl.NumberFormat` and fail on a hit, on the grounds that a second money implementation in
 * a place nothing tests is a second set of rounding bugs. A Flow is that same place with even
 * less recourse, since it renders on a handset we cannot inspect.
 *
 * `formatBotPrice` stays the one formatter, and both channels are served from it.
 */
export const PRODUCT_LISTING_SCREEN = 'PRODUCTS';
