import type { FlowDefinition } from './flow-definition.types';

/**
 * Checkout, as a WhatsApp Flow — the port of the Telegram `co` screen.
 *
 * ── ⛔ THE ONLY FLOW HERE WHOSE MISTAKES COST REAL MONEY ────────────────────
 * A `co` handle authorises **placing an order against a stranger's saved address and starting
 * a payment**, from a message that can be forwarded. `co.html` and `checkout.controller.ts`
 * hold four protections between them, and **a Flow inherits all four unchanged** — which is
 * the strongest argument for porting rather than redesigning:
 *
 *   1. **Ten minutes** — `TTL_SECONDS.co`, and `touch` refuses `co`, so an open Flow cannot
 *      keep an order-placing credential alive. Store-side; nothing here can weaken it.
 *   2. **Single use on the write** — the terminal exchange calls `consume`, never `read`. A
 *      Flow has no `Idempotency-Key` either (Meta retries on its own schedule and we do not
 *      control it), so the store's Lua read-and-delete is again the only thing between a
 *      retry and two orders. ⚠ This is *more* load-bearing here than on the web page, not
 *      less: a browser retries when a human taps twice, Meta retries by itself.
 *   3. **The address is projected COARSE** — never the street line, never coordinates.
 *   4. **The mobile-money number never reaches the form in full** — it is the input's helper
 *      text, masked. Submitting the field empty means *"use the number on my account"*, so
 *      the common case is one tap and no disclosure at all.
 *
 * ── ⚠ `data_exchange` ON INIT, AND THIS IS THE ONE FLOW THAT NEEDS IT ───────
 * The listing and detail Flows open with `navigate`: their data is in hand when the message
 * is built, so inlining it saves a round trip. Checkout cannot. What a customer owes, what is
 * in the basket and where it is going must be read **at the moment the screen opens**, not at
 * the moment the message was sent — a total inlined ten minutes ago is a total that can
 * disagree with the cart, and the one screen that must never quote a stale price is the one
 * that takes the money. The session deliberately holds no prices for the same reason.
 *
 * ── ⚠ EXACTLY ONE INPUT, AND IT IS A PHONE NUMBER ──────────────────────────
 * `co.html` has one input, `type="tel"`, and `test:inapp-checkout` § 1 asserts the count.
 * This screen matches it deliberately: **there is no address field and there must never be
 * one.** `createOrdersFromCart` re-resolves the destination from the customer's own saved
 * addresses regardless of anything submitted, so an address field here would be a box whose
 * contents are ignored — which is worse than no box, because a customer would believe they
 * had changed where their parcel goes.
 *
 * Collecting an address belongs in the chat, which already does it well with a map pin and a
 * candidate list, and where `geo-candidate.store.ts` keeps coordinates off the client
 * entirely. "No saved address" is a real state with its own instruction and no pay button.
 *
 * ── ⚠ THE PAYMENT RESULT DOES NOT COME BACK HERE ───────────────────────────
 * Neither a Flow nor a Mini App can hold a session open while somebody approves a
 * mobile-money push on their handset. So this screen promises the answer in the thread and
 * closes; the chat delivers it, with Check-status and Try-again. A receipt rendered on a
 * screen that is about to close is a receipt nobody reads.
 */
export const CHECKOUT_FLOW: FlowDefinition = {
    version: '6.0',
    data_api_version: '3.0',
    routing_model: { REVIEW: [] },

    screens: [
        {
            id: 'REVIEW',
            title: 'Checkout',
            /**
             * ⚠ **Terminal, even though its footer is a `data_exchange`.** The endpoint answers
             * that exchange with the reserved `SUCCESS` screen, which closes the Flow — so
             * this is the last screen a customer sees and Meta needs it declared as such.
             */
            terminal: true,

            data: {
                /**
                 * The basket, already priced and formatted.
                 *
                 * ⚠ **No numbers, anywhere on this screen.** A Flow cannot do arithmetic or
                 * currency formatting, and this platform refuses money maths outside the
                 * backend on principle — `test:inapp-checkout` scans the page for `toFixed`,
                 * `parseFloat` and `Intl.NumberFormat` and fails on a hit. A Flow is that same
                 * place with less recourse: it renders on a handset nobody can inspect.
                 */
                lines: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', __example__: '' },
                            title: { type: 'string', __example__: '' },
                            description: { type: 'string', __example__: '' },
                        },
                    },
                    __example__: [
                        { id: '1', title: 'Electric kettle 1.7L × 1', description: '12 500 FCFA' },
                    ],
                },
                totalText: { type: 'string', __example__: 'Total: 12 500 FCFA' },
                /**
                 * ⚠ **Coarse by construction — a neighbourhood and a city, never a street
                 * line and never coordinates.** This message can be forwarded, and a forwarded
                 * URL must not read out where somebody lives. `checkout-masking.ts` owns the
                 * projection; this field must never be widened to carry the full address.
                 */
                addressText: { type: 'string', __example__: 'Akwa, Douala' },
                /**
                 * ⚠ **The MASKED number, and the only form it ever takes on this screen.**
                 * `••••1234`. It is helper text under an empty input, so leaving the input
                 * alone means "use my account number" and discloses nothing.
                 */
                phoneMasked: { type: 'string', __example__: '••••1234' },
                payLabel: { type: 'string', __example__: 'Place order' },
            },

            layout: {
                type: 'SingleColumnLayout',
                children: [
                    { type: 'TextHeading', text: '${data.totalText}' },
                    {
                        /**
                         * ⚠ **A read-only list, not a selector.** Nothing on this screen may
                         * change the basket: the handle was minted against a specific cart and
                         * `assertBasketStillThere` refuses a checkout whose basket has been
                         * replaced since. Editing belongs in the chat, which can re-open a
                         * fresh checkout afterwards.
                         */
                        type: 'TextBody',
                        text: '${data.lines}',
                    },
                    { type: 'TextCaption', text: '${data.addressText}' },
                    {
                        type: 'TextInput',
                        name: 'phone',
                        'input-type': 'phone',
                        required: false,
                        label: 'Mobile money number',
                        /** The masked number. Empty submission ⇒ use the account's own. */
                        'helper-text': '${data.phoneMasked}',
                    },
                    {
                        type: 'Footer',
                        label: '${data.payLabel}',
                        /**
                         * ⚠ **`data_exchange`, and this is the ONE place in these three Flows
                         * where the Flow itself performs the write.** Everywhere else the Flow
                         * reports a choice and the chat acts on it, because a write belongs
                         * behind the bot surface's idempotency guard. Checkout cannot do that:
                         * the customer is mid-screen and the payment push has to start now, so
                         * the protection moves to the store instead — `consume` first, before
                         * anything that could take time, so a retry finds the handle gone.
                         *
                         * ⚠ **Nothing after that may report "not placed".** Once `consume`
                         * returns, the order may exist whatever fails afterwards; the answer
                         * sends the customer to the chat, which knows the truth.
                         */
                        'on-click-action': {
                            name: 'data_exchange',
                            payload: {
                                screen: 'co',
                                phone: '${form.phone}',
                            },
                        },
                    },
                ],
            },
        },
    ],
};

export const CHECKOUT_SCREEN = 'REVIEW';
