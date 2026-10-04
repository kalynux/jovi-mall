import type { BotReplyIntent, BotReplyOption } from './channel-reply';
import { botChrome, botChromeFill } from './bot-chrome-copy';
import { botFeeCopy, botFeeCopyFill } from './bot-fee-change-copy';
import { formatBotPrice } from './product-card';
import { instructionLines } from './checkout-chat-reply';
import {
    deliveryFeeAcceptActionId,
    deliveryFeeDeclineActionId,
    deliveryFeePayActionId,
    deliveryFeeProposalActionId,
    openSurfaceActionId,
} from './bot-action-id';

/**
 * The chat's side of a delivery-fee change (ADR-A11 § Fee changes after checkout, W-H) — PURE.
 *
 * Every function here takes a view the service built and returns a channel-neutral intent; no
 * database, no clock, no request. `test:bot-fee-changes` drives all of it.
 *
 * ── ⛔ THE ONE RULE: THIS FILE PERFORMS NO ARITHMETIC ON MONEY ──────────────
 * `customerPays` is what the backend planned (`planCustomerApprovedIncrease` — online: the top-up;
 * COD: the extra cash) or what the approval froze (`proposal.topup.amount`). It is FORMATTED here,
 * never derived: `proposedFee − feeBefore` is not what a customer pays when part of the fee was the
 * shop's (`vendorBorne`), so a subtraction in the renderer would quote a wrong figure in exactly the
 * case nobody tests. `test:bot-fee-changes` scans this file for a minus between two amounts.
 */

export type FeeChangeAction = 'approve' | 'reject' | 'pay';

/** What the renderer needs about one change. Built by `BotDeliveryFeeService.viewOf`. */
export interface BotFeeChangeView {
    proposalId: string;
    orderId: string;
    orderNumber: string;
    shipmentId: string;
    /** The figure the customer is shown — carried in the Accept / Decline tokens. */
    version: number;
    origin: 'agency' | 'change_agency' | 'combined_request';
    paymentMode: 'online' | 'cod';
    /** `awaiting_payment`: approved online, the top-up is due. */
    state: 'awaiting_answer' | 'awaiting_payment';
    currency: string;
    feeBefore: number;
    proposedFee: number;
    /** The backend's figure for what the customer pays MORE (see the header). Never computed here. */
    customerPays: number;
    reason: string | null;
    availableActions: readonly FeeChangeAction[];
}

/** The model-facing projection — explicit fields, amounts as data AND as the text to quote. */
export interface BotFeeChangeProjection {
    proposalId: string;
    orderId: string;
    orderNumber: string;
    shipmentId: string;
    version: number;
    origin: BotFeeChangeView['origin'];
    paymentMode: BotFeeChangeView['paymentMode'];
    state: BotFeeChangeView['state'];
    currency: string;
    feeBefore: number;
    proposedFee: number;
    customerPays: number;
    feeBeforeText: string;
    proposedFeeText: string;
    customerPaysText: string;
    reason: string | null;
    availableActions: FeeChangeAction[];
}

export function toBotFeeChangeProjection(view: BotFeeChangeView): BotFeeChangeProjection {
    return {
        proposalId: view.proposalId,
        orderId: view.orderId,
        orderNumber: view.orderNumber,
        shipmentId: view.shipmentId,
        version: view.version,
        origin: view.origin,
        paymentMode: view.paymentMode,
        state: view.state,
        currency: view.currency,
        feeBefore: view.feeBefore,
        proposedFee: view.proposedFee,
        customerPays: view.customerPays,
        feeBeforeText: formatBotPrice(view.feeBefore, view.currency),
        proposedFeeText: formatBotPrice(view.proposedFee, view.currency),
        customerPaysText: formatBotPrice(view.customerPays, view.currency),
        reason: view.reason,
        availableActions: [...view.availableActions],
    };
}

/** How many changes a choice lists before its way out. Five, the chat list cap (§ 6b). */
export const FEE_CHANGE_CHOICE_MAX = 5;

const price = (view: BotFeeChangeView, amount: number): string => formatBotPrice(amount, view.currency);

function header(view: BotFeeChangeView, language: string | null): string {
    return botFeeCopyFill('questionHeader', language, { order: view.orderNumber });
}

/**
 * The payer's side of the online top-up: where it will be charged, or — with no number on the
 * account — what to do instead. `storefrontOrderUrl` null means no storefront is configured.
 */
export interface FeeChangePayer {
    payerMasked: string | null;
    storefrontOrderUrl: string | null;
}

/**
 * ⭐ THE QUESTION for one change — Accept · Decline, or (approved online) Pay now · Decline.
 *
 * `prefix` is a sentence put above it (the "it changed since" note on a stale tap).
 *
 * ⚠ **Buttons are drawn only for the actions the proposal OFFERS** (`availableActions`, the
 * service's own authority table), so a button can never be drawn that the API would refuse.
 */
export function feeChangeQuestion(
    view: BotFeeChangeView,
    language: string | null,
    payer: FeeChangePayer,
    prefix: string | null = null,
): BotReplyIntent {
    const lines: string[] = [];
    if (prefix) lines.push(prefix, '');
    lines.push(header(view, language), '');

    const can = (action: FeeChangeAction): boolean => view.availableActions.includes(action);
    const decline: BotReplyOption | null = can('reject')
        ? { id: deliveryFeeDeclineActionId(view.proposalId, view.version), label: botFeeCopy('declineButton', language) }
        : null;

    if (view.state === 'awaiting_payment') {
        lines.push(botFeeCopyFill('payQuestion', language, {
            proposed: price(view, view.proposedFee),
            order: view.orderNumber,
            amount: price(view, view.customerPays),
        }));
        if (!payer.payerMasked) {
            lines.push(botFeeCopy('payOnWebsite', language));
            const text = lines.join('\n');
            // With no wallet a Pay button would answer "send me a number" to a tool the model cannot call.
            if (payer.storefrontOrderUrl) {
                return { kind: 'link', text, label: botChrome('openButton', language), url: payer.storefrontOrderUrl };
            }
            return decline ? { kind: 'text', text, actions: [decline] } : { kind: 'text', text };
        }
        lines.push(botFeeCopyFill('payFrom', language, { phone: payer.payerMasked }));
        const actions: BotReplyOption[] = [];
        if (can('pay')) actions.push({ id: deliveryFeePayActionId(view.proposalId), label: botChrome('payButton', language) });
        if (decline) actions.push(decline);
        return actions.length ? { kind: 'text', text: lines.join('\n'), actions } : { kind: 'text', text: lines.join('\n') };
    }

    const asked = view.origin === 'change_agency' ? 'askedAfterMove' : 'askedByCompany';
    lines.push(botFeeCopyFill(asked, language, {
        proposed: price(view, view.proposedFee),
        before: price(view, view.feeBefore),
    }));
    if (view.reason && view.origin !== 'change_agency') {
        lines.push(botFeeCopyFill('reasonLine', language, { reason: view.reason }));
    }
    if (view.customerPays > 0) {
        lines.push(botFeeCopyFill(view.paymentMode === 'cod' ? 'ifAcceptCod' : 'ifAcceptOnline', language, {
            amount: price(view, view.customerPays),
        }));
    }
    lines.push(botFeeCopy(view.origin === 'change_agency' ? 'ifDeclineMove' : 'ifDeclineCompany', language));
    lines.push('', botFeeCopy('acceptQuestion', language));

    const actions: BotReplyOption[] = [];
    if (can('approve')) {
        actions.push({ id: deliveryFeeAcceptActionId(view.proposalId, view.version), label: botFeeCopy('acceptButton', language) });
    }
    if (decline) actions.push(decline);
    return actions.length ? { kind: 'text', text: lines.join('\n'), actions } : { kind: 'text', text: lines.join('\n') };
}

/** The row a change gets in the "which one?" choice. Title = the order number (data, ≤ 24 in practice). */
export function feeChangeRow(view: BotFeeChangeView, language: string | null): BotReplyOption {
    const description = view.state === 'awaiting_payment'
        ? botFeeCopyFill('rowToPay', language, { amount: price(view, view.customerPays) })
        : botFeeCopyFill('rowToAnswer', language, {
            proposed: price(view, view.proposedFee),
            before: price(view, view.feeBefore),
        });
    return {
        id: deliveryFeeProposalActionId(view.orderId, view.proposalId),
        label: `${botFeeCopyFill('rowLabel', language, { order: view.orderNumber })} · ${description}`,
        shortLabel: view.orderNumber,
        description,
    };
}

/**
 * What a "show me my delivery-fee changes" draws: nothing waiting → one sentence; one → its
 * question; several → a choice, capped at five with a way out to the order history.
 */
export function feeChangeListReply(
    views: readonly BotFeeChangeView[],
    language: string | null,
    payer: FeeChangePayer,
): BotReplyIntent {
    if (views.length === 0) return { kind: 'text', text: botFeeCopy('nothingPending', language) };
    if (views.length === 1) return feeChangeQuestion(views[0], language, payer);

    const options: BotReplyOption[] = views.slice(0, FEE_CHANGE_CHOICE_MAX).map((view) => feeChangeRow(view, language));
    if (views.length > FEE_CHANGE_CHOICE_MAX) {
        options.push({
            id: openSurfaceActionId('ol'),
            label: botChrome('loadMoreRow', language),
            shortLabel: botChrome('loadMoreRow', language),
        });
    }
    return {
        kind: 'choice',
        text: botFeeCopy('chooseOne', language),
        options,
        listButton: botFeeCopy('listButton', language),
        sectionTitle: botFeeCopy('sectionTitle', language),
    };
}

/**
 * After Accept on a change that applied at once (COD, or online with nothing to pay).
 * `view` is the view read BEFORE the approval — its `customerPays` is what the plan said the
 * customer pays more, which is the figure the question quoted.
 */
export function feeChangeAcceptedReply(view: BotFeeChangeView, language: string | null): BotReplyIntent {
    if (view.paymentMode === 'cod' && view.customerPays > 0) {
        return {
            kind: 'text',
            text: botFeeCopyFill('acceptedCod', language, {
                order: view.orderNumber,
                proposed: price(view, view.proposedFee),
                amount: price(view, view.customerPays),
            }),
        };
    }
    return {
        kind: 'text',
        text: botFeeCopyFill('acceptedNothingToPay', language, {
            order: view.orderNumber,
            proposed: price(view, view.proposedFee),
        }),
    };
}

/** After Decline: who carries the difference depends on why the fee moved. */
export function feeChangeDeclinedReply(view: BotFeeChangeView, language: string | null): BotReplyIntent {
    return {
        kind: 'text',
        text: botFeeCopy(view.origin === 'change_agency' ? 'declinedMove' : 'declinedCompany', language),
    };
}

/** A tap on a change that has been answered, withdrawn or applied since the button was drawn. */
export function feeChangeNoLongerWaitingReply(language: string | null): BotReplyIntent {
    return { kind: 'text', text: botFeeCopy('noLongerWaiting', language) };
}

/** The top-up charge as it was opened. */
export interface FeeTopupChargeForReply {
    proposalId: string;
    /** `failed` — the request could not be sent and no money was taken. */
    state: 'waiting' | 'failed' | 'settled';
    amountText: string;
    payerMasked: string;
    instructions: unknown;
}

/**
 * After Pay now: where the prompt went and for how much (the transaction's own amount, formatted),
 * the operator's instruction when it is one the customer must ACT on, and when the answer comes.
 * A refused opening says no money was taken and offers Try again on the SAME proposal.
 *
 * ⚠ **No Check status button.** `pay:st:` resolves CHECKOUT payments only; the top-up's outcome
 * reaches this chat as `order.delivery_fee.updated` / `order.delivery_fee.topup_failed`.
 */
export function feeTopupChargeReply(charge: FeeTopupChargeForReply, language: string | null): BotReplyIntent {
    if (charge.state === 'settled') {
        return { kind: 'text', text: botChrome('checkoutPaymentReceived', language) };
    }
    if (charge.state === 'failed') {
        return {
            kind: 'text',
            text: botChrome('checkoutPaymentNotSent', language),
            actions: [{ id: deliveryFeePayActionId(charge.proposalId), label: botChrome('tryAgainButton', language) }],
        };
    }
    return {
        kind: 'text',
        text: [
            botChromeFill('checkoutPaymentRequestSent', language, { amount: charge.amountText, phone: charge.payerMasked }),
            ...instructionLines(charge.instructions),
            '',
            botChrome('checkoutPaymentWait', language),
        ].join('\n'),
    };
}

/** A combined-price request sent. `agencyName` is the delivery company's public (Magazin) name. */
export function combinedRequestSentReply(
    input: { agencyName: string; parcelCount: number },
    language: string | null,
): BotReplyIntent {
    return {
        kind: 'text',
        text: botFeeCopyFill('combinedSent', language, { agency: input.agencyName, count: String(input.parcelCount) }),
    };
}

export function combinedRequestCancelledReply(language: string | null): BotReplyIntent {
    return { kind: 'text', text: botFeeCopy('combinedCancelled', language) };
}
