import type { FlowDefinition } from './flow-definition.types';
import { FLOW_SCREEN_TITLE, NOTICE_SCREEN, noticeScreen } from './notice.screen';

/**
 * The product listing, as a WhatsApp Flow — the port of the Telegram `pl` screen.
 *
 * ── ⚠ A CARD GRID CANNOT SURVIVE THE CROSSING, AND THIS IS WHAT REPLACES IT ─
 * `pl.html` draws a scrolling grid of tappable cards, each with its own image, price and
 * button. A Flow screen is a FORM: headings, text, inputs, selectors and one footer button. So
 * the grid becomes **a single-choice list with one footer button**. The customer picks a
 * product, then presses the button, where on Telegram they tap the card. One extra press.
 *
 *   | Telegram (`pl.html`)          | WhatsApp (this Flow)                           |
 *   |-------------------------------|------------------------------------------------|
 *   | image per card                | **no per-row image** — see below                |
 *   | tap a card to open it         | select a row, then press the button             |
 *   | load more via `cursor`        | **one page of 20** — see below                  |
 *   | muted card, nothing sellable  | the same row, **disabled** (`enabled: false`)   |
 *
 * ⚠ **No per-row images.** Two reasons, both from Meta's component reference: an image is
 * base64 bytes rather than a URL, at up to 300 KB each, all inside one encrypted response; and a
 * screen may carry **at most 3 images**, which rules out one per row outright.
 *
 * ⚠ **One page of 20.** Meta caps a `RadioButtonsGroup` at 20 options, and the read is called
 * with `pageSize: 20` for that reason. Paging would be a second screen per page. The chat
 * already has a "see more" rung, and going back to it is the cheaper way to widen a search.
 * This is an owner decision and was put to the owner on 2026-09-16.
 *
 * ── HOW IT OPENS, AND WHY IT IS `data_exchange` ─────────────────────────────
 * The message carries only the token. On open, Meta sends `INIT` and the endpoint reads the
 * listing **live**, through the same `readListingPage` the Telegram page's `/data` calls. Two
 * reasons against inlining the rows into the message with `navigate`:
 *   1. **One read site.** Inlining would make the chat door call the read as well, which is a
 *      second caller to keep in step.
 *   2. **The message outlives its prices.** A chat message sits in the thread for days.
 *      Inlined rows would quote whatever things cost when it was sent. A live read quotes
 *      today's price, or answers 427 once the handle has lapsed, exactly as the Telegram
 *      page does.
 *
 * ── THE SCREEN IS TERMINAL, AND THAT IS NOT A SHORTCUT ──────────────────────
 * Choosing a product **closes** the Flow and hands the choice to the chat, which opens the
 * detail Flow. It doesn't navigate onward inside this Flow, because each in-app screen has its
 * own handle with its own kind and lifetime, and `inAppSurfaceStore.read` refuses a mismatched
 * kind by construction. One Flow spanning listing and checkout would need one handle spanning
 * both, giving a freely-forwarded browse credential the reach of the checkout one.
 */
export const PRODUCT_LISTING_FLOW: FlowDefinition = {
    /** ⚠ Pinned. A Flow's rendering is frozen at publish, so a version bump is a republish. */
    version: '6.0',
    data_api_version: '3.0',

    routing_model: { PRODUCTS: [], [NOTICE_SCREEN]: [] },

    screens: [
        {
            id: 'PRODUCTS',
            title: FLOW_SCREEN_TITLE,
            terminal: true,

            /**
             * ⚠ **Validated against the endpoint's REAL response at publish time.** Every field
             * is produced by `screens/listing.adapter.ts` from `readListingPage`'s output. Nothing
             * here is computed twice.
             */
            data: {
                heading: { type: 'string', __example__: 'Browse' },
                products: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            /**
                             * ⚠ **The PRODUCT id.** A product's variants are chosen on the
                             * detail screen; sending a variant id here would mean choosing a
                             * size before the customer has seen the sizes.
                             */
                            id: { type: 'string' },
                            /** ⚠ Meta caps an option title at 30 characters; the adapter truncates. */
                            title: { type: 'string' },
                            /** Price · store, already formatted. Never a number. */
                            description: { type: 'string' },
                            /** False when nothing is sellable — the Telegram card is muted then. */
                            enabled: { type: 'boolean' },
                        },
                    },
                    __example__: [
                        {
                            id: '66f1a2b3c4d5e6f708192a3b',
                            title: 'Electric kettle 1.7L',
                            description: '12 500 FCFA · Chez Awa',
                            enabled: true,
                        },
                        {
                            id: '66f1a2b3c4d5e6f708192a3c',
                            title: 'Stovetop kettle 2L',
                            description: '7 900 FCFA · Chez Awa · Out of stock',
                            enabled: false,
                        },
                    ],
                },
                openLabel: { type: 'string', __example__: 'View product' },
            },

            layout: {
                type: 'SingleColumnLayout',
                children: [
                    { type: 'TextHeading', text: '${data.heading}' },
                    {
                        /**
                         * ⚠ **`RadioButtonsGroup`, not `CheckboxGroup`.** One product opens one
                         * detail screen; a multi-select would collect a basket this screen has
                         * no way to price.
                         */
                        type: 'RadioButtonsGroup',
                        name: 'product',
                        required: true,
                        'data-source': '${data.products}',
                    },
                    {
                        type: 'Footer',
                        label: '${data.openLabel}',
                        /**
                         * ⚠ **`complete`, not `data_exchange`.** The Flow ends and the choice
                         * travels to the chat in the completion message.
                         *
                         * `screen: 'pl'` is stamped so `flow_complete` knows which Flow finished
                         * without a store lookup. `flow_token` is not added: Meta sends it with
                         * the completion on its own.
                         */
                        'on-click-action': {
                            name: 'complete',
                            payload: {
                                screen: 'pl',
                                productId: '${form.product}',
                            },
                        },
                    },
                ],
            },
        },
        noticeScreen('pl'),
    ],
};

export const PRODUCT_LISTING_SCREEN = 'PRODUCTS';

/**
 * ⚠ **Prices are formatted by the backend and sent as strings, never numbers.** A Flow can't do
 * arithmetic or currency formatting (`${data.price}` renders what it is given), and this
 * platform already refuses money maths outside the backend: `test:inapp-catalog` and
 * `test:inapp-checkout` scan the Mini App pages for `toFixed`, `parseFloat` and
 * `Intl.NumberFormat`. `formatBotPrice` stays the one formatter, and both channels are served
 * from it.
 */
