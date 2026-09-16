import type {
    CheckoutPlaced,
    CheckoutView,
} from '../../../bot-surface/miniapp/surfaces/checkout.controller';
import { screenResponse, type FlowResponseBody } from '../domain/flow-protocol';
import { CHECKOUT_SCREEN } from '../definitions/checkout.flow';
import type { FlowCopy } from './flow-copy';
import { noticeResponse } from './listing.adapter';
import { FLOW_CAPS, fitText, joinFitted } from './flow-text';

/**
 * The checkout, reshaped for the Flow — and what to say when placing it fails.
 *
 * ── ⚠ RESHAPES, NEVER RE-DERIVES ────────────────────────────────────────────
 * Every value comes from Stream D's `readCheckoutView`, the same read the Telegram checkout page
 * calls. The total is its `totalText` (the screen adds nothing up), the address is its already
 * masked `text`, and the payer number is its already masked `phoneMasked`. None of them is
 * re-masked, recomputed or widened here. A second masking would show a customer their own
 * number masked two different ways.
 */
export function toCheckoutScreen(view: CheckoutView, copy: FlowCopy): FlowResponseBody {
    /**
     * ⚠ **No saved address → no pay action at all.** The page shows `checkoutNoAddress` with no
     * pay button; here that's the notice screen, which has no route to a payment. The customer
     * sends an address in the chat, where the map pin and the candidate list live.
     */
    if (!view.address) return noticeResponse(copy.checkoutNoAddress, copy);
    if (view.lines.length === 0) return noticeResponse(copy.expired, copy);

    const lines = view.lines
        .map((line) => `• ${joinFitted(
            [line.variantLabel ? `${line.title} (${line.variantLabel})` : line.title,
                `× ${line.quantity}`,
                line.lineTotalText],
            FLOW_CAPS.caption,
        )}`)
        .join('\n');

    return screenResponse(CHECKOUT_SCREEN, {
        totalText: joinFitted([copy.checkoutTotal, view.totalText], FLOW_CAPS.heading),
        lines: fitText(lines, FLOW_CAPS.body),
        addressLabel: fitText(
            view.address.digital ? copy.checkoutDigitalDelivery : copy.checkoutAddress,
            FLOW_CAPS.caption,
        ),
        addressText: fitText(view.address.text, FLOW_CAPS.body),
        phoneLabel: fitText(copy.flowPhoneLabel, 20),
        phoneHint: fitText(copy.flowPhoneHint, FLOW_CAPS.caption),
        /** ⚠ Verbatim. Empty when nothing is on file; the helper text is simply blank then. */
        phoneMasked: fitText(view.payment.phoneMasked ?? '', 80),
        payLabel: fitText(copy.checkoutPay, FLOW_CAPS.footerLabel),
    });
}

/** Whether the form field was left empty, in the same sense `placeCheckout` folds it. */
export function isBlankPhone(phone: unknown): boolean {
    return phone === null || phone === undefined
        || (typeof phone === 'string' && phone.trim() === '');
}

/**
 * The one refusal this side makes WITHOUT calling `placeCheckout`: no number on file, and the
 * field left empty.
 *
 * ⚠ **Checked before the spend, so the handle is never at risk.** The page prevents this case
 * by disabling Pay; Meta documents no dynamic `required`, so the form can't. Calling
 * `placeCheckout` to find out would cost the customer their checkout, because that refusal sits
 * AFTER the spend (it needs the session's customer).
 */
export function needsTypedNumber(view: CheckoutView, phone: unknown): boolean {
    return view.payment.phoneMasked === null && isBlankPhone(phone);
}

export type CheckoutFailurePlan =
    /** Keep them on the screen with a snackbar: the handle is still live and a retry is honest. */
    | { kind: 'stay'; code: string; category: string }
    /** The handle or the basket is gone. 427: restart from the chat. */
    | { kind: 'restart' }
    /** No payment gateway is configured. Close: pressing again can't change configuration. */
    | { kind: 'unavailable' }
    /**
     * ⛔ Anything else. Orders may exist, so the only honest answer is "look in the chat, which
     * knows what happened".
     *
     * ⚠ **Never "approve the payment on your phone".** That sentence is true only on success. A
     * 502 means the gateway could NOT open the charge, so no prompt is coming to the handset, and
     * a non-AppError after the spend may sit either side of the charge. It is shown with
     * `failed`, the same copy the Telegram checkout page shows here.
     */
    | { kind: 'ask_chat' };

/** The code Stream D raises, before the spend, when no gateway is configured. */
export const GATEWAY_NOT_CONFIGURED = 'PAYMENT_GATEWAY_NOT_CONFIGURED';

/**
 * What a `placeCheckout` refusal should lead to. **Pure**, so the whole table is asserted.
 *
 * ── ⛔ ABSENT MEANS SPENT ────────────────────────────────────────────────────
 * Stream D's rule, adopted verbatim: `details.spent === false` is the only signal that the
 * handle survived. A non-`AppError`, a missing flag, or `details` stripped entirely all read as
 * spent, and spent means orders may exist. **Nothing here may say "not placed".**
 *
 * ── ⚠ DECIDE ON `spent`, NEVER ON THE CODE ──────────────────────────────────
 * `PAYMENT_OPERATOR_UNDETERMINED` appears on BOTH sides of the spend: `false` for a typed number
 * on no recognisable network (a different number fixes it), `true` for the account's own number.
 * A table keyed on the code would get one of the two wrong.
 *
 * ⚠ **"Stay" is an allowlist: a 400 or 422 with `spent === false`, and nothing else.** A 404
 * also carries `spent: false` (there was nothing left to spend), and keeping a customer on a
 * screen whose handle is gone would give them a button that can only fail.
 *
 * ⚠ **The one row keyed on the CODE, not on `spent`: no gateway configured.** It is raised
 * before the spend (`spent: false`, so a retry would be honest), but a retry can't change
 * configuration, so it's futile. Its status is moving from 503 to 500 to satisfy `test:errors`'
 * one-code-one-status rule, and a 500 would otherwise fall into the last row. Both are matched
 * until the move lands.
 */
export function planCheckoutFailure(error: unknown): CheckoutFailurePlan {
    const e = error as {
        statusCode?: unknown;
        code?: unknown;
        category?: unknown;
        details?: { spent?: unknown } | null;
    } | null;
    const status = typeof e?.statusCode === 'number' ? e.statusCode : null;

    if (e?.code === GATEWAY_NOT_CONFIGURED || status === 503) return { kind: 'unavailable' };

    if ((status === 400 || status === 422) && e?.details?.spent === false
        && typeof e.code === 'string' && typeof e.category === 'string') {
        return { kind: 'stay', code: e.code, category: e.category };
    }
    if (status === 404 || status === 410) return { kind: 'restart' };
    return { kind: 'ask_chat' };
}

/**
 * After a successful placement: say "approve it on your phone, I'll tell you in the chat" and
 * close. The receipt, the Check-status and Try-again buttons all arrive in the chat, where they
 * can be acted on. None of `placed`'s figures is shown here.
 */
export function placedResponse(_placed: CheckoutPlaced, copy: FlowCopy): FlowResponseBody {
    return noticeResponse(copy.checkoutWatchChat, copy);
}
