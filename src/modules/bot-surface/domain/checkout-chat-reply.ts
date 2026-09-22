import { WA_LIMITS } from '../../whatsapp/constants/whatsapp-limits';
import type { BotAddressDto } from '../dto/bot-projections';
import type { ChatDestinationBlocker } from '../miniapp/surfaces/checkout-destination';
import { paymentRetryActionId, paymentStatusActionId } from './bot-action-id';
import { checkoutConfirmActionId, checkoutDeclineActionId } from './bot-checkout-actions';
import { botChrome, botChromeFill } from './bot-chrome-copy';
import type { BotReplyIntent, BotReplyOption } from './channel-reply';

/**
 * ⭐ **THE CHAT CHECKOUT'S TWO DRAWN TURNS — the confirmation, and the placement.**
 *
 * ── WHY THE SERVER DRAWS THEM ───────────────────────────────────────────────
 * On 2026-09-22 (core exec 2294) a customer typed "Place order", `checkout_review` returned the
 * total, the address, the masked wallet and a `checkoutRef` — and the model's own confirmation came
 * back TRUNCATED to "Your order is 200 XAF,". The customer never saw the question, and the order was
 * later placed without a proper one. **A money confirmation must not depend on a model's wording.**
 *
 * So both turns are fixed-wording turns with controls, which is exactly what `channel-reply.ts`
 * says carries a `reply`: the confirmation ends in Place order · Not now (or one row per address),
 * and the placement ends in Check status or Try again. The model is told not to repeat either
 * (`catalog.json`); a customer who answers in WORDS still reaches `checkout_place` through it.
 *
 * ── PURE, SO A SUITE CAN DRIVE IT ───────────────────────────────────────────
 * No request, no database, no clock. The controller hands in the review's own response data and
 * the placement's own response data, so what is drawn is provably what the model was told —
 * `test:inapp-checkout` § 13 drives every branch here, because the controller that calls it cannot
 * be imported by a bare `ts-node` run.
 */

/** One basket line, exactly as the review's response carries it. */
export interface ChatReviewLine {
    title: string;
    variantLabel: string | null;
    quantity: number;
    lineTotalText: string;
}

/**
 * The review's response data — the fields the drawn confirmation is built from.
 *
 * ⚠ **The SAME object the model receives**, typed here and built once in the controller, so the
 * buttons can never name an address or a total the data does not.
 */
export interface ChatReviewForReply {
    ready: boolean;
    blocker: ChatDestinationBlocker | null;
    checkoutRef: string | null;
    lines: readonly ChatReviewLine[];
    totalText: string;
    delivery: { kind: 'digital'; to: string } | { kind: 'address'; address: BotAddressDto } | null;
    /** Default first, as the review sorts them. */
    addresses: readonly BotAddressDto[];
    payment: { method: 'mobile_money'; phoneMasked: string | null };
    addAddressUrl: string | null;
}

/** The placement's response data — the fields the drawn placement message is built from. */
export interface ChatPlacementForReply {
    transactionId: string;
    state: 'settled' | 'failed' | 'waiting';
    orderNumbers: readonly string[];
    amountText: string | null;
    payerMasked: string;
    instructions: unknown;
}

/** Basket lines shown before the "+ N more" line. */
const MAX_BASKET_LINES = 5;

/**
 * Address rows in the several-addresses list: WhatsApp allows ten rows and the last is Not now.
 */
const MAX_ADDRESS_OPTIONS = 9;

/**
 * ⚠ **The body must fit WhatsApp's interactive cap, or the QUESTION is what gets cut.** The
 * renderer truncates an over-long body at its END, and the end of this message is the question —
 * the exact failure this file exists to remove, reintroduced by a long product title. So every
 * customer- or seller-written value is clipped, and basket lines are folded into "+ N more" until
 * the whole body fits.
 */
const BODY_LIMIT = WA_LIMITS.INTERACTIVE_BODY;
const TITLE_CLIP = 80;
const VARIANT_CLIP = 40;
const LABEL_CLIP = 40;
const PLACE_CLIP = 150;
const INSTRUCTION_CLIP = 200;

function clip(value: string, max: number): string {
    const text = value.trim();
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `2 × Red shoes (42) — 20 000 XAF`. Language-neutral: a symbol, a name, a price. */
function basketLine(line: ChatReviewLine): string {
    const variant = line.variantLabel ? ` (${clip(line.variantLabel, VARIANT_CLIP)})` : '';
    return `${line.quantity} × ${clip(line.title, TITLE_CLIP)}${variant} — ${line.lineTotalText}`;
}

/** `Home — Akwa, Douala`. An address with no label is named by where it is. */
function addressText(address: BotAddressDto): string {
    const label = address.label?.trim();
    const place = clip(address.formattedAddress ?? '', PLACE_CLIP);
    return label ? `${clip(label, LABEL_CLIP)} — ${place}` : place;
}

/**
 * The confirmation body: intro, basket, then the summary block and the question — with basket lines
 * folded into "+ N more" until it fits `BODY_LIMIT`.
 *
 * ⚠ **The summary and the question are never the part that gives way.** They are what the customer
 * is agreeing to; five product names are not.
 */
function confirmationBody(
    review: ChatReviewForReply,
    summary: readonly string[],
    language: string | null,
): string {
    const intro = botChrome('checkoutReviewIntro', language);
    const items = review.lines.map(basketLine);

    for (let shown = Math.min(items.length, MAX_BASKET_LINES); shown >= 0; shown -= 1) {
        const hidden = items.length - shown;
        const basket = [
            ...items.slice(0, shown),
            ...(hidden > 0 ? [botChromeFill('checkoutMoreLines', language, { count: String(hidden) })] : []),
        ];
        const text = [intro, ...basket, '', ...summary].join('\n');
        if (text.length <= BODY_LIMIT || shown === 0) return text;
    }
    // Unreachable — the loop returns at `shown === 0` — but the compiler cannot see that.
    return [intro, '', ...summary].join('\n');
}

/**
 * The reply `checkout_review` draws, or null when the model should speak instead.
 *
 * ── THREE SHAPES, CHOSEN FROM THE DATA ──────────────────────────────────────
 *   - **One destination** — a download, an address the customer NAMED, or a customer with a single
 *     deliverable address. The summary names it and asks "Shall I place the order?" over
 *     **Place order · Not now** — two WhatsApp reply buttons.
 *   - **Several deliverable addresses, none named** — the summary has no destination line; each
 *     address is an option that places the order THERE, default first, then Not now. A WhatsApp
 *     list, because a row has a description and a button does not.
 *   - **No address to deliver to** — a link to the website's address page (owner's ruling
 *     2026-09-20: an address is added there, never captured in the chat).
 *
 * ⚠ **Null — the model's turn — for everything else**: no wallet on the account (the model must ask
 * for a number, and a Place order button could only fail), an unknown address id, an address that
 * cannot be delivered to while ANOTHER one can (the model offers that one; telling the customer to
 * go and add an address would be wrong), and a review with nothing in it.
 *
 * @param addressChosen The model passed `deliveryAddressId` — the customer named where it goes, so
 *   they are not asked again.
 */
export function checkoutReviewReply(
    review: ChatReviewForReply,
    options: { addressChosen: boolean },
    language: string | null,
): BotReplyIntent | null {
    if (!review.ready) return addAddressReply(review, language);

    const ref = review.checkoutRef;
    const phone = review.payment.phoneMasked;
    if (!ref || !phone || !review.delivery || review.lines.length === 0) return null;

    const total = `${botChrome('checkoutTotalLabel', language)} ${review.totalText}`;
    const wallet = `${botChrome('checkoutMobileMoneyLabel', language)} ${phone}`;
    const notNow: BotReplyOption = { id: checkoutDeclineActionId(ref), label: botChrome('notNowButton', language) };
    const chooser = {
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    };

    if (review.delivery.kind === 'digital') {
        const summary = [
            total,
            `${botChrome('checkoutSentToLabel', language)} ${clip(review.delivery.to, PLACE_CLIP)}`,
            wallet,
            '',
            botChrome('checkoutPlaceQuestion', language),
        ];
        return {
            kind: 'choice',
            text: confirmationBody(review, summary, language),
            options: [{ id: checkoutConfirmActionId(ref, null), label: botChrome('placeOrderButton', language) }, notNow],
            ...chooser,
        };
    }

    const deliverable = review.addresses.filter((address) => address.deliverable);

    if (options.addressChosen || deliverable.length <= 1) {
        const address = review.delivery.address;
        const summary = [
            total,
            `${botChrome('checkoutDeliverToLabel', language)} ${addressText(address)}`,
            wallet,
            '',
            botChrome('checkoutPlaceQuestion', language),
        ];
        return {
            kind: 'choice',
            text: confirmationBody(review, summary, language),
            options: [
                { id: checkoutConfirmActionId(ref, address.id), label: botChrome('placeOrderButton', language) },
                notNow,
            ],
            ...chooser,
        };
    }

    /**
     * ⚠ **Each row places the order — there is no second "are you sure?".** The row IS the answer
     * to a question that names the total and the wallet, and the address is on the row itself.
     *
     * ⚠ **`label` is the whole address and `shortLabel` its name**, the split `BotReplyOption`
     * exists for: a Telegram button shows only its label (64 wide), a WhatsApp row shows a
     * 24-character title with a 72-character description under it. The renderer truncates both.
     */
    const summary = [total, wallet, '', botChrome('checkoutChooseAddressQuestion', language)];
    return {
        kind: 'choice',
        text: confirmationBody(review, summary, language),
        options: [
            ...deliverable.slice(0, MAX_ADDRESS_OPTIONS).map((address): BotReplyOption => ({
                id: checkoutConfirmActionId(ref, address.id),
                label: addressText(address),
                shortLabel: address.label?.trim() || clip(address.formattedAddress ?? '', LABEL_CLIP),
                description: address.formattedAddress || null,
            })),
            notNow,
        ],
        ...chooser,
    };
}

/**
 * No address to deliver to: one link, to the website's address page.
 *
 * ⚠ **Only when adding an address is actually the remedy** — no saved address at all, or none that
 * can be delivered to. A customer whose DEFAULT was typed by hand but who has another deliverable
 * address is not told to go and add one; the model offers the one they have.
 */
function addAddressReply(review: ChatReviewForReply, language: string | null): BotReplyIntent | null {
    if (!review.addAddressUrl) return null;
    const remedyIsANewAddress = review.blocker === 'no_saved_address'
        || (review.blocker === 'address_not_deliverable' && !review.addresses.some((address) => address.deliverable));
    if (!remedyIsANewAddress) return null;

    return {
        kind: 'link',
        text: botChrome('checkoutAddAddressPrompt', language),
        label: botChrome('addAddressButton', language),
        url: review.addAddressUrl,
    };
}

/** Not now. Nothing was written, and the sentence says so. */
export function checkoutDeclinedReply(language: string | null): BotReplyIntent {
    return { kind: 'text', text: botChrome('checkoutDeclined', language) };
}

/**
 * The operator's own words, relayed verbatim — the push message and the USSD code, each on its line.
 *
 * ⚠ **An allowlist of two fields, never the object.** `PaymentInstructions` also carries a card
 * `clientSecret`; a chat message is screenshotted and forwarded, and nothing but what the customer
 * must act on belongs in one.
 */
function instructionLines(instructions: unknown): string[] {
    if (typeof instructions === 'string') {
        return instructions.trim() ? [clip(instructions, INSTRUCTION_CLIP)] : [];
    }
    if (!instructions || typeof instructions !== 'object') return [];
    const { message, ussdCode } = instructions as { message?: unknown; ussdCode?: unknown };
    return [message, ussdCode]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => clip(value, INSTRUCTION_CLIP));
}

/**
 * The reply a placement draws — from `checkout_place` and from the Place order tap alike.
 *
 *   waiting  the order numbers, where the prompt went and for how much, the operator's own
 *            instruction, and that it can take minutes — with **Check status**
 *   failed   the order numbers and that no money was taken — with **Try again**
 *   settled  the order numbers and a thank-you
 *
 * ⚠ **The buttons carry THIS transaction's id** (`pay:st:` / `pay:rt:`), never "the latest": a
 * button outlives the payment it was drawn for. Built through `bot-action-id.ts`'s own builders.
 *
 * ⚠ **Null when the amount is unknown** — the transaction row was not found straight after being
 * written, which is not a state worth a sentence of its own. The model narrates the data instead.
 */
export function checkoutPlacedReply(
    placement: ChatPlacementForReply,
    language: string | null,
): BotReplyIntent | null {
    const placed = `${botChrome('checkoutOrderPlacedLabel', language)} ${placement.orderNumbers.join(', ')}`;

    if (placement.state === 'settled') {
        return { kind: 'text', text: [placed, '', botChrome('checkoutPaymentReceived', language)].join('\n') };
    }

    if (placement.state === 'failed') {
        return {
            kind: 'text',
            text: [placed, '', botChrome('checkoutPaymentNotSent', language)].join('\n'),
            actions: [{ id: paymentRetryActionId(placement.transactionId), label: botChrome('tryAgainButton', language) }],
        };
    }

    if (!placement.amountText) return null;

    return {
        kind: 'text',
        text: [
            placed,
            '',
            botChromeFill('checkoutPaymentRequestSent', language, {
                amount: placement.amountText,
                phone: placement.payerMasked,
            }),
            ...instructionLines(placement.instructions),
            '',
            botChrome('checkoutPaymentWait', language),
        ].join('\n'),
        actions: [{ id: paymentStatusActionId(placement.transactionId), label: botChrome('checkStatusButton', language) }],
    };
}

/** ⚠ Exported for `test:inapp-checkout`, which fits a body to the cap it is written against. */
export const __CHECKOUT_REPLY_LIMITS = Object.freeze({ BODY_LIMIT, MAX_BASKET_LINES, MAX_ADDRESS_OPTIONS });
