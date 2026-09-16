import type { FlowDefinition } from './flow-definition.types';
import { FLOW_SCREEN_TITLE, NOTICE_SCREEN, noticeScreen } from './notice.screen';

/**
 * Checkout, as a WhatsApp Flow — the port of the Telegram `co` screen.
 *
 * ── ⛔ THE ONLY FLOW HERE WHOSE MISTAKES COST REAL MONEY ────────────────────
 * A `co` handle authorises **placing an order against a stranger's saved address and starting
 * a payment**, from a message that can be forwarded. Four protections hold, and this Flow
 * inherits all four unchanged by calling Stream D's exported `readCheckoutView` and
 * `placeCheckout` rather than reimplementing either:
 *
 *   1. **Ten minutes.** `TTL_SECONDS.co`, and `touch` refuses `co`.
 *   2. **Single use on the write.** `placeCheckout` spends the handle before anything slow.
 *      ⚠ This carries MORE weight here than on the web page: a browser retries when a human
 *      taps twice, Meta retries an exchange on its own.
 *   3. **The address is coarse.** `address.text` arrives masked and is shown verbatim.
 *   4. **The mobile-money number is never shown in full.** `payment.phoneMasked` is the field's
 *      helper text, verbatim, under an EMPTY input. Leaving it empty means "use my account
 *      number".
 *
 * ── ⚠ EXACTLY ONE INPUT, AND IT IS A PHONE NUMBER ──────────────────────────
 * `co.html` has one input, `type="tel"`, and `test:inapp-checkout` asserts the count. **There is
 * no address field and there must never be one.** `createOrdersFromCart` re-resolves the
 * destination from the customer's own saved addresses whatever is submitted, so an address box
 * here would be ignored. That's worse than no box, because the customer would believe they had
 * changed where their parcel goes.
 *
 * ── STATES, AND WHICH SCREEN EACH ONE USES ──────────────────────────────────
 *   · basket with a saved address   → `REVIEW`
 *   · no saved address              → `NOTICE` with `checkoutNoAddress`, and **no pay action at
 *                                     all**. The customer sends an address in the chat.
 *   · placed                        → `NOTICE` with `checkoutWatchChat` ("approve it on your
 *                                     phone, I'll tell you in the chat")
 *   · ⛔ failed AFTER the spend     → `NOTICE` with `failed` ("look in the chat"). Orders may
 *                                     exist, so nothing here may say "not placed". ⚠ And never
 *                                     `checkoutWatchChat`: after a 502 no payment prompt is
 *                                     coming, so "approve it on your phone" would be false.
 *   · no gateway configured         → `NOTICE` with `failed`, closing: a retry can't fix it
 *   · a correctable input, handle
 *     still live                    → `REVIEW` again, with Meta's `error_message` snackbar
 *
 * ── ⚠ THE PAYMENT RESULT DOES NOT COME BACK HERE ───────────────────────────
 * Neither a Flow nor a Mini App can hold a session open while somebody approves a mobile-money
 * push on their handset. This screen says "approve it on your phone, I'll tell you in the chat",
 * and the chat delivers the result.
 */
export const CHECKOUT_FLOW: FlowDefinition = {
    version: '6.0',
    data_api_version: '3.0',
    routing_model: {
        REVIEW: [NOTICE_SCREEN],
        [NOTICE_SCREEN]: [],
    },

    screens: [
        {
            id: 'REVIEW',
            title: FLOW_SCREEN_TITLE,

            data: {
                totalText: { type: 'string', __example__: 'Total: 12 500 FCFA' },
                /**
                 * The basket as ONE string, one line per item, formatted upstream.
                 *
                 * ⚠ **A string, not an array.** Meta's `TextBody.text` is a string, and the first
                 * version of this definition bound it to an array, which is not a valid binding.
                 * `RichText` accepts an array but is documented only from 5.1 and has placement
                 * rules this screen doesn't need to take on. Each line starts with a bullet, so
                 * the lines stay apart even if a client collapses the newlines.
                 *
                 * ⚠ **No numbers anywhere on this screen.** A Flow can't do arithmetic or
                 * currency formatting, and this platform refuses money maths outside the
                 * backend.
                 */
                lines: {
                    type: 'string',
                    __example__: '• Electric kettle 1.7L × 1 — 12 500 FCFA',
                },
                /** `checkoutAddress` for a parcel, `checkoutDigitalDelivery` for a digital basket. */
                addressLabel: { type: 'string', __example__: 'Deliver to' },
                /** ⚠ Coarse by construction. Shown verbatim, never widened. */
                addressText: { type: 'string', __example__: 'Akwa, Douala' },
                phoneLabel: { type: 'string', __example__: 'Mobile money number' },
                /** The country-code hint. The platform refuses a number without it. */
                phoneHint: {
                    type: 'string',
                    __example__: 'Leave this empty to use the number on your account. If you type one, include the country code, for example +237.',
                },
                /** ⚠ `maskPhone`'s own shape, verbatim, never re-masked. Empty when none is on file. */
                phoneMasked: { type: 'string', __example__: '+2376••••4417' },
                payLabel: { type: 'string', __example__: 'Pay now' },
            },

            layout: {
                type: 'SingleColumnLayout',
                children: [
                    { type: 'TextHeading', text: '${data.totalText}' },
                    /**
                     * ⚠ **Read-only.** Nothing on this screen may change the basket: the handle
                     * was minted against one cart and a replaced basket is refused.
                     */
                    { type: 'TextBody', text: '${data.lines}' },
                    { type: 'TextCaption', text: '${data.addressLabel}' },
                    { type: 'TextBody', text: '${data.addressText}' },
                    { type: 'TextCaption', text: '${data.phoneHint}' },
                    {
                        type: 'TextInput',
                        name: 'phone',
                        'input-type': 'phone',
                        /**
                         * ⚠ **Optional, and "no number on file" is refused in the adapter
                         * instead.** Meta doesn't document a dynamic `required`, so the case the
                         * page handles by disabling Pay is caught before `placeCheckout` is ever
                         * called, with the handle still live.
                         */
                        required: false,
                        label: '${data.phoneLabel}',
                        'helper-text': '${data.phoneMasked}',
                    },
                    {
                        type: 'Footer',
                        label: '${data.payLabel}',
                        /**
                         * ⚠ **`data_exchange`: the endpoint places the order.** The customer is
                         * mid-screen and the payment push has to start now, so the protection is
                         * the store's single-use spend inside `placeCheckout`.
                         */
                        'on-click-action': {
                            name: 'data_exchange',
                            payload: { phone: '${form.phone}' },
                        },
                    },
                ],
            },
        },
        noticeScreen('co'),
    ],
};

export const CHECKOUT_SCREEN = 'REVIEW';
