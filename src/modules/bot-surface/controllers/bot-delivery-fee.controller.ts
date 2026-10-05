import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { normalizePhoneNumber } from '../../../core/validation/phone';
import { composeTypedNumber } from '../../../core/validation/dial-codes';
import { deliveryFeeProposalService } from '../../delivery-fee-proposals/services/delivery-fee-proposal.service';
import { combinedDeliveryRequestService } from '../../delivery-fee-proposals/services/combined-delivery-request.service';
import type { ICustomer } from '../../customers/customer.model';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { parseDeliveryFeeArgument, parseDeliveryFeeConfirmArgument } from '../domain/bot-action-id';
import { botFeeCopy } from '../domain/bot-fee-change-copy';
import {
    BotFeeChangeView,
    FeeChangePayer,
    combinedRequestCancelledReply,
    combinedRequestSentReply,
    feeChangeAcceptedReply,
    feeChangeDeclinedReply,
    feeChangeListReply,
    feeChangeNoLongerWaitingReply,
    feeChangeQuestion,
    feeTopupChargeReply,
    toBotFeeChangeProjection,
} from '../domain/fee-change-chat-reply';
import { botStorefrontLink, windowForChat } from '../domain/bot-list-window';
import { formatBotPrice } from '../domain/product-card';
import { maskPhone } from '../dto/bot-projections';
import { botDeliveryFeeService } from '../services/bot-delivery-fee.service';
import { mobileMoneyRoute, payerPresentation, storedPayer, validatedPayerNumber } from '../miniapp/surfaces/checkout-payer';
import {
    BotCombinedCreateSchema,
    BotCombinedListSchema,
    BotCombinedParamSchema,
    BotDeliveryFeeApproveSchema,
    BotDeliveryFeeParamSchema,
    BotDeliveryFeePaySchema,
    BotDeliveryFeePendingSchema,
    BotDeliveryFeeRejectSchema,
    BotNoArgsSchema,
} from '../validators/bot.validators';

/**
 * The customer's side of a delivery-fee change after checkout, in the chat (ADR-A11 § Fee changes
 * after checkout, owner decision D-8 · W-H).
 *
 * ── ONE IMPLEMENTATION, TWO DOORS ───────────────────────────────────────────
 * Every write is reached by a ROUTE (the catalogued tool) and by a TAP (the button the list
 * draws), and both run the same function below — so "Accept" pressed and `delivery_fees_approve`
 * called cannot be treated differently. Every write is W-E's own service method, called exactly
 * as `CustomerDeliveryFeeProposalController` / `CustomerCombinedDeliveryRequestController` call it.
 *
 * ── THE TIER BOUNDARY (catalog.json) ────────────────────────────────────────
 *   delivery_fees_list_pending   core       read; draws the question (Accept · Decline / Pay now)
 *   delivery_fees_reject         core       declining costs the customer nothing — a model may do it
 *                                           when the customer says no
 *   delivery_fees_approve        flow_only  commits the customer to more money (COD: more cash at the
 *                                           door) — reached only by pressing Accept
 *   delivery_fees_pay            flow_only  opens a mobile-money charge — reached only by Pay now
 *   combined_delivery_*          core/ext.  a request a company may only answer with LOWER fees
 *
 * ── ⛔ NO FIGURE IS COMPOSED HERE ───────────────────────────────────────────
 * Amounts come from the proposal, W-E's plan or the transaction, and are formatted by
 * `formatBotPrice`. The `version` a button carries is the one the customer was shown.
 */

const isCode = (error: unknown, code: string): error is AppError => error instanceof AppError && error.code === code;

/** Where an online top-up would be charged, or the order page to pay it on. */
async function payerFor(customerId: string, orderId: string, language: string | null): Promise<FeeChangePayer> {
    return {
        payerMasked: await botDeliveryFeeService.payerMasked(customerId),
        storefrontOrderUrl: botStorefrontLink(`/shop/account/orders/detail/${orderId}`, language),
    };
}

/** Draw one change's question and answer with its projection. */
async function drawQuestion(
    req: Request,
    res: Response,
    view: BotFeeChangeView,
    extra: Record<string, unknown> = {},
    prefix: string | null = null,
): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    setBotReply(req, feeChangeQuestion(view, language, await payerFor(caller.customerId, view.orderId, language), prefix));
    sendSuccess(res, { ...extra, change: toBotFeeChangeProjection(view) });
}

/**
 * A press (or call) that found the proposal moved on: edited since → the fresh question with a
 * note; no longer waiting → one sentence. Anything else is rethrown with its own copy.
 */
async function explainMiss(req: Request, res: Response, proposalId: string, error: unknown): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    if (isCode(error, ERROR_CODES.DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH)) {
        const { view } = await botDeliveryFeeService.viewOf(caller.customerId, proposalId);
        if (view) {
            await drawQuestion(req, res, view, { answered: false, changed: true }, botFeeCopy('changedSince', language));
            return;
        }
    }
    if (
        isCode(error, ERROR_CODES.DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH)
        || isCode(error, ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PENDING)
    ) {
        setBotReply(req, feeChangeNoLongerWaitingReply(language));
        sendSuccess(res, { answered: false, stillWaiting: false });
        return;
    }
    throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The shared cores
// ─────────────────────────────────────────────────────────────────────────────

/** Every change waiting on the customer (one order, or all open ones): the list, and its reply. */
async function listPending(req: Request, res: Response, orderRef: string | null): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const views = await botDeliveryFeeService.pendingViews(caller.customerId, orderRef);
    const payer: FeeChangePayer = views.length === 1
        ? await payerFor(caller.customerId, views[0].orderId, language)
        : { payerMasked: null, storefrontOrderUrl: null };
    setBotReply(req, feeChangeListReply(views, language, payer));
    // The data carries what the drawn choice carries (five), and `meta` says where the rest are (§ 6b).
    const chat = windowForChat({ items: views, total: views.length, surface: 'orders', language });
    sendSuccess(res, { changes: chat.items.map(toBotFeeChangeProjection) }, { meta: { ...chat.window } });
}

/**
 * Accept. COD (or online with nothing to pay): applies now. Online: freezes the figure and the
 * reply IS the Pay now question.
 */
async function approve(req: Request, res: Response, proposalId: string, version: number): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const { proposal, view: before } = await botDeliveryFeeService.viewOf(caller.customerId, proposalId);

    let answered;
    try {
        answered = await deliveryFeeProposalService.customerApprove(
            caller.customerId,
            caller.userId,
            proposal.order_id.toString(),
            proposalId,
            version,
        );
    } catch (error) {
        await explainMiss(req, res, proposalId, error);
        return;
    }

    if (answered.topup && answered.topup.status === 'awaiting_payment') {
        const { view } = await botDeliveryFeeService.viewOf(caller.customerId, proposalId);
        if (view) {
            await drawQuestion(req, res, view, { approved: true, awaitingPayment: true });
            return;
        }
    }
    if (before) setBotReply(req, feeChangeAcceptedReply(before, language));
    sendSuccess(res, {
        approved: true,
        awaitingPayment: false,
        proposalId,
        status: answered.status,
        proposedFee: answered.proposedFee,
        proposedFeeText: formatBotPrice(answered.proposedFee, answered.currency),
    });
}

/** Decline. A delivery company's increase: the fee stays. A moved parcel's difference: the shop pays. */
async function reject(req: Request, res: Response, proposalId: string, version: number, note: string | null): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const { proposal, view: before } = await botDeliveryFeeService.viewOf(caller.customerId, proposalId);

    let answered;
    try {
        answered = await deliveryFeeProposalService.customerReject(
            caller.customerId,
            caller.userId,
            proposal.order_id.toString(),
            proposalId,
            note,
            version,
        );
    } catch (error) {
        await explainMiss(req, res, proposalId, error);
        return;
    }
    if (before) setBotReply(req, feeChangeDeclinedReply(before, language));
    sendSuccess(res, {
        declined: true,
        proposalId,
        status: answered.status,
        shopCovers: proposal.origin === 'change_agency',
    });
}

/**
 * The chat's typed number, composed against the account's country when it carries no `+` —
 * the rule `checkout_retry_payment` applies (`bot-checkout.controller.ts` `chatTypedNumber`).
 */
async function typedNumber(customer: ICustomer, phone: string | null | undefined): Promise<string | null> {
    if (!phone || phone.trim().length === 0) return null;
    if (normalizePhoneNumber(phone.trim()).startsWith('+')) return validatedPayerNumber(phone);
    const { dialCountry } = await payerPresentation(customer);
    const composed = composeTypedNumber(phone, dialCountry);
    return validatedPayerNumber(typeof composed === 'string' ? composed : phone);
}

/**
 * Pay now — charge the top-up the approval froze, to a typed number or the wallet on the account.
 *
 * `fromTap`: a button cannot carry a number, so with no wallet on the account the tap answers with
 * the order page (where the website takes the payment) rather than the "send me a number" refusal,
 * which would hand the turn to a tool the model cannot call.
 */
async function pay(
    req: Request,
    res: Response,
    proposalId: string,
    phone: string | null,
    fromTap: boolean,
    /** The `CODE_FIRST` payment code the model relayed. A tap never carries one (null). */
    paymentCode: string | null = null,
): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const { proposal, view } = await botDeliveryFeeService.viewOf(caller.customerId, proposalId);
    if (!view || view.state !== 'awaiting_payment') {
        if (fromTap) {
            setBotReply(req, feeChangeNoLongerWaitingReply(language));
            sendSuccess(res, { charged: false, stillWaiting: false });
            return;
        }
        throw createAppError(ERROR_CODES.DELIVERY_FEE_TOPUP_NOT_DUE, 409);
    }

    const customer = await botDeliveryFeeService.customer(caller.customerId);
    if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404, 'Customer not found');
    const typed = await typedNumber(customer, phone);
    const payer = typed ? { number: typed, savedProvider: null } : await storedPayer(customer);
    if (!payer) {
        if (fromTap) {
            await drawQuestion(req, res, view, { charged: false, reason: 'no_payer_number' });
            return;
        }
        throw createAppError(ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED, 422, 'A mobile money number is needed to take this payment');
    }
    // The provider comes from the number (ADR-A08); the settings choose who collects.
    const route = mobileMoneyRoute(payer.number, false, payer.savedProvider, { paymentCode });

    const result = await deliveryFeeProposalService.customerPay(
        caller.customerId,
        proposal.order_id.toString(),
        proposalId,
        { provider: route.provider },
        { phoneNumber: payer.number, customerName: customer.name, ...(paymentCode ? { paymentCode } : {}) },
        // Asked for in THIS chat, so its outcome is told here.
        { originChat: req.bot!.envelope.channel },
    );

    const state = result.status === 'SUCCEEDED' ? 'settled' : result.status === 'FAILED' || result.status === 'CANCELLED' ? 'failed' : 'waiting';
    setBotReply(req, feeTopupChargeReply({
        proposalId,
        state,
        amountText: formatBotPrice(result.amount, result.currency),
        payerMasked: maskPhone(payer.number),
        instructions: result.instructions ?? null,
    }, language));
    sendSuccess(res, {
        transactionId: result.transactionId,
        state,
        amount: result.amount,
        amountText: formatBotPrice(result.amount, result.currency),
        currency: result.currency,
        proposalId,
        instructions: result.instructions ?? null,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The routes
// ─────────────────────────────────────────────────────────────────────────────

export class BotDeliveryFeeController {
    /** `POST /delivery-fees/pending` — `delivery_fees_list_pending`. */
    static listPending = asyncHandler(async (req: Request, res: Response) => {
        const { orderId } = BotDeliveryFeePendingSchema.parse(req.body ?? {});
        await listPending(req, res, orderId ?? null);
    });

    /** `POST /delivery-fees/:proposalId/approve` — `delivery_fees_approve` (flow_only). */
    static approve = asyncHandler(async (req: Request, res: Response) => {
        const { proposalId } = BotDeliveryFeeParamSchema.parse(req.params);
        const { version } = BotDeliveryFeeApproveSchema.parse(req.body ?? {});
        await approve(req, res, proposalId, version);
    });

    /** `POST /delivery-fees/:proposalId/reject` — `delivery_fees_reject`. */
    static reject = asyncHandler(async (req: Request, res: Response) => {
        const { proposalId } = BotDeliveryFeeParamSchema.parse(req.params);
        const { version, note } = BotDeliveryFeeRejectSchema.parse(req.body ?? {});
        await reject(req, res, proposalId, version, note ?? null);
    });

    /** `POST /delivery-fees/:proposalId/pay` — `delivery_fees_pay` (flow_only). */
    static pay = asyncHandler(async (req: Request, res: Response) => {
        const { proposalId } = BotDeliveryFeeParamSchema.parse(req.params);
        const { phone, paymentCode } = BotDeliveryFeePaySchema.parse(req.body ?? {});
        await pay(req, res, proposalId, phone ?? null, false, paymentCode ?? null);
    });

    /** `POST /delivery-fees/combined/eligible` — `combined_delivery_eligible`. Data for the model. */
    static combinedEligible = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const groups = await botDeliveryFeeService.eligibleCombinedGroups(botCallerOf(req).customerId);
        sendSuccess(res, { groups });
    });

    /** `POST /delivery-fees/combined/list` — `combined_delivery_list`. Data for the model. */
    static combinedList = asyncHandler(async (req: Request, res: Response) => {
        const caller = botCallerOf(req);
        const { cartId } = BotCombinedListSchema.parse(req.body ?? {});
        if (cartId) {
            // The ownership check the customer API runs (404 for a checkout that is not theirs).
            await combinedDeliveryRequestService.listForCustomer(caller.customerId, cartId);
        }
        const requests = await botDeliveryFeeService.listCombined(caller.customerId, cartId ?? null);
        const chat = windowForChat({ items: requests, total: requests.length, surface: 'orders', language: botResponseLanguageOf(req) });
        sendSuccess(res, { requests: chat.items }, { meta: { ...chat.window } });
    });

    /** `POST /delivery-fees/combined` — `combined_delivery_request`. */
    static combinedCreate = asyncHandler(async (req: Request, res: Response) => {
        const caller = botCallerOf(req);
        const input = BotCombinedCreateSchema.parse(req.body ?? {});
        const created = await combinedDeliveryRequestService.create(caller.customerId, input.cartId, {
            agencyId: input.agencyId,
            shipmentIds: input.shipmentIds,
            note: input.note ?? null,
        });
        const agencyName = await botDeliveryFeeService.agencyName(created.agencyId);
        setBotReply(req, combinedRequestSentReply({ agencyName, parcelCount: created.shipments.length }, botResponseLanguageOf(req)));
        const [request] = await botDeliveryFeeService.projectCombined([
            await botDeliveryFeeService.ownedCombinedRequest(caller.customerId, created.id),
        ]);
        sendSuccess(res, { request }, { status: 201 });
    });

    /** `POST /delivery-fees/combined/:requestId/cancel` — `combined_delivery_cancel`. */
    static combinedCancel = asyncHandler(async (req: Request, res: Response) => {
        const caller = botCallerOf(req);
        const { requestId } = BotCombinedParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const owned = await botDeliveryFeeService.ownedCombinedRequest(caller.customerId, requestId);
        await combinedDeliveryRequestService.cancel(caller.customerId, owned.cart_id.toString(), requestId);
        setBotReply(req, combinedRequestCancelledReply(botResponseLanguageOf(req)));
        const [request] = await botDeliveryFeeService.projectCombined([
            await botDeliveryFeeService.ownedCombinedRequest(caller.customerId, requestId),
        ]);
        sendSuccess(res, { request });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  The taps — `dfee:…` and the confirm pair `yes:dfc:` / `no:dfc:`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `dfee:list` · `dfee:<orderId>` · `dfee:<orderId>:<proposalId>` · `dfee:pay:<proposalId>`.
 * Grammar: `parseDeliveryFeeArgument` — an argument it refuses is the one unknown-tap refusal.
 */
async function deliveryFeeTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const tap = parseDeliveryFeeArgument(action.argument);
    if (!tap) throw unknownBotAction();
    const caller = botCallerOf(req);

    switch (tap.kind) {
        case 'list':
            await listPending(req, res, null);
            return;
        case 'order':
            await listPending(req, res, tap.orderId);
            return;
        case 'proposal': {
            const { proposal, view } = await botDeliveryFeeService.viewOf(caller.customerId, tap.proposalId);
            // A row names its order too; one that disagrees with the proposal is not a row we drew.
            if (proposal.order_id.toString() !== tap.orderId) throw unknownBotAction();
            if (!view) {
                setBotReply(req, feeChangeNoLongerWaitingReply(botResponseLanguageOf(req)));
                sendSuccess(res, { stillWaiting: false, proposalId: tap.proposalId });
                return;
            }
            await drawQuestion(req, res, view);
            return;
        }
        case 'pay':
            await pay(req, res, tap.proposalId, null, true);
            return;
    }
}

/** `yes:dfc:<proposalId>:<version>` — Accept. */
async function acceptTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const parsed = parseDeliveryFeeConfirmArgument(action.argument);
    if (!parsed) throw unknownBotAction();
    await approve(req, res, parsed.proposalId, parsed.version);
}

/** `no:dfc:<proposalId>:<version>` — Decline. No note: a button cannot carry one. */
async function declineTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const parsed = parseDeliveryFeeConfirmArgument(action.argument);
    if (!parsed) throw unknownBotAction();
    await reject(req, res, parsed.proposalId, parsed.version, null);
}

/**
 * The keys this stream owns. Registered in `bot-action.controller.ts`.
 *
 * ⚠ `dfc` is NOT in `ANSWERABLE_QUESTION_CONTEXTS`, so a typed "yes" never accepts a fee — the
 * question supersedes any waiting one and the customer taps. Adding it is a product decision.
 */
export const DELIVERY_FEE_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    dfee: deliveryFeeTap,
    'yes:dfc': acceptTap,
    'no:dfc': declineTap,
});
