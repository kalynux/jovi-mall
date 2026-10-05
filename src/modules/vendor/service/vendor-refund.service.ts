import { Types } from 'mongoose';
import { VendorOrderRepository } from '../../orders/vendor-order.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { IVendorReturnPolicy } from '../../vendors/vendor.model';
import { IOrder, OrderModel } from '../../orders/order.model';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { IRefundRequest } from '../../payments/models/refund-request.model';
import { refundRequestService, RefundRequestService } from '../../payments/services/refund-request.service';
import { sumCompletedRefundsForOrder } from '../../payments/services/refund-ledger';
import { maxAttributable, RefundReasonKind, ReturnShippingPayer } from '../../payments/domain/refund-attribution';
import { maskRefundPhone } from '../../payments/domain/refund-destination';
import { codCoverageService } from '../../cod/services/cod-coverage.service';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES, ErrorCode } from '../../../core/error-codes';
import { deliveredAtOf } from '../../earnings/domain/earnings-hold';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RefundEligibilityDto {
    eligible: boolean;
    maxRefundable: number;       // Most the vendor may refund right now (per policy + balance + attribution)
    remaining: number;           // Remaining un-refunded balance of the payment
    currency: string | null;
    reasonCode?: string;         // Why it's not eligible (when eligible === false)
    // Policy info surfaced for the UI/notification (no money movement here).
    refundProcessingDays: number | null;                  // Expected settle window per policy
    returnShippingPayer: IVendorReturnPolicy['return_shipping_payer'] | null; // Who pays return shipping
    /**
     * VENDOR surface only (REFUND-FLOW-PLAN § 4, 2026-10-05). How the money would leave —
     * `card` (back to the card), `mobile_money` (a transfer to the number that paid), `cod`
     * (cash on delivery: always needs an administrator's approval and a typed number). Null when
     * nothing was paid. Absent on the administrator's copy of the vendor verdict.
     */
    paymentChannel?: 'card' | 'mobile_money' | 'cod' | null;
    /** Whether a refund would be sent at once (`true`) or wait for an administrator (`false`). */
    autoSend?: boolean;
    /** A refund request already open on this order — a second one is refused until it closes. */
    openRefundRequest?: { id: string; status: IRefundRequest['status'] } | null;
}

/**
 * What `POST /api/vendor/orders/:id/refund` answers since 2026-10-05 (REFUND-FLOW-PLAN § 4) —
 * a REFUND REQUEST, not a finished refund. ⚠ BREAKING: `status` used to be the literal
 * `'completed'`; a mobile-money refund is now a transfer whose outcome arrives later.
 *
 *   `completed`          card refunds (Stripe answers in the call)
 *   `sending`            a transfer to the number that paid is in flight
 *   `awaiting_approval`  an administrator decides: COD, no paying number on record, or a send
 *                        the platform could not start (payouts switched off on this deployment)
 *   `failed`             the gateway refused the transfer — an administrator retries or settles it
 */
export interface RefundResultDto {
    refundRequestId: string;
    /** @deprecated alias of `refundRequestId` (it used to be a `refund_transactions` id). */
    refundId: string;
    status: IRefundRequest['status'];
    /** What the order loses — the GROSS (kept under its old name). */
    amount: number;
    grossAmount: number;
    /** The refund fee (2% by default) on a transfer; 0 on a card refund (R-3). */
    feeAmount: number;
    /** What the customer receives: gross − fee. */
    netAmount: number;
    currency: string;
    paymentChannel: IRefundRequest['payment_channel'];
    channel: IRefundRequest['channel'];
    /** The number the transfer goes to, MASKED (`+•••••••••512`). Null for card / not decided. */
    destinationMasked: string | null;
    /** Why it did not send (when it did not): e.g. `payout_unavailable`, `insufficient_gateway_balance`. */
    transferFailureReason: string | null;
    /** Σ completed refunds on this order, this one included once it completed. */
    totalRefunded: number;
    /** True only once the refund COMPLETED and squared the order. */
    fullyRefunded: boolean;
    // Echoed from the vendor return policy so the client can inform the customer.
    refundProcessingDays: number | null;
    returnShippingPayer: IVendorReturnPolicy['return_shipping_payer'] | null;
}

/**
 * VendorRefundService — the VENDOR's door into the refund flow.
 *
 * Decides whether an order is refundable under the vendor's return policy (`computeVendorRefundEligibility`,
 * shared with the administrator's path), computes the policy-allowed amount, and then OPENS A
 * REFUND REQUEST through `RefundRequestService` (REFUND-FLOW-PLAN § 4). It moves no money itself
 * and writes no ledger row: the request's lifecycle owns the transfer, the ledger, the earnings
 * recovery and the customer's notification.
 *
 * ── Auto-send or wait (R-2) ───────────────────────────────────────────────────
 * The request is created with `approveNow`, and `mayApproveAtCreation` honours it for a vendor
 * only when the refund is within policy (always true here — this path never overrides) and NOT
 * COD; the request then sends at once when there is somewhere to send it (the card, or the
 * number that paid). Otherwise it is created `awaiting_approval` and an administrator decides.
 *
 * Eligibility rules (per vendor return_policy):
 * - Policy must exist, be return_eligible, and not be refund_type 'none'.
 * - Order payment_status must be 'paid'.
 * - now must be within DELIVERY + return_window_days (not started before delivery).
 * - maxRefundable: full → remaining balance; partial → floor(remaining × refund_percentage%),
 *   then capped by the attribution rule (C-1: after delivery, delivery money comes back only per
 *   the vendor's own return-shipping setting).
 * - No refund request may already be open on the order.
 */
export class VendorRefundService {
    private vendorOrderRepo: VendorOrderRepository;
    private vendorRepo: VendorRepository;
    private refunds: RefundRequestService;

    constructor(refunds: RefundRequestService = refundRequestService) {
        this.vendorOrderRepo = new VendorOrderRepository();
        this.vendorRepo = new VendorRepository();
        this.refunds = refunds;
    }

    /**
     * Compute refund eligibility for an order (read-only; never throws on
     * ineligibility — returns eligible:false + reasonCode instead).
     */
    async getEligibility(vendorId: string, orderId: string): Promise<RefundEligibilityDto> {
        const order = await this.loadOwnedOrder(vendorId, orderId);
        const vendor = await this.vendorRepo.findById(vendorId);
        const returnPolicy = vendor?.policies?.return_policy ?? null;
        return this.evaluate(order, returnPolicy, null);
    }

    /**
     * Open a refund request for the order. Throws an AppError when the order is not refundable
     * or the requested amount exceeds the policy-allowed maximum; otherwise returns the request,
     * whatever its send did (the request records it).
     */
    async refund(
        vendorId: string,
        orderId: string,
        input: { amount?: number; reason?: string; itemDefective?: boolean },
        initiatedBy: string
    ): Promise<RefundResultDto> {
        const order = await this.loadOwnedOrder(vendorId, orderId);
        const vendor = await this.vendorRepo.findById(vendorId);
        const returnPolicy = vendor?.policies?.return_policy ?? null;

        const eligibility = await this.evaluate(order, returnPolicy, input.itemDefective ?? null);
        if (!eligibility.eligible) {
            if (eligibility.reasonCode === ERROR_CODES.REFUND_ALREADY_OPEN) {
                throw createAppError(ERROR_CODES.REFUND_ALREADY_OPEN, 409, undefined, {
                    refundRequestId: eligibility.openRefundRequest?.id ?? null,
                    status: eligibility.openRefundRequest?.status ?? null,
                });
            }
            throw createAppError(
                (eligibility.reasonCode as ErrorCode) ?? ERROR_CODES.REFUND_NOT_ELIGIBLE,
                this.statusForReason(eligibility.reasonCode)
            );
        }

        // Default to the policy-computed amount; allow an explicit override downward.
        const requested = input.amount ?? eligibility.maxRefundable;
        if (!Number.isInteger(requested) || requested <= 0 || requested > eligibility.maxRefundable) {
            throw createAppError(ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX, 400, undefined, {
                requested,
                maxRefundable: eligibility.maxRefundable
            });
        }

        const request = await this.refunds.create({
            source: { kind: 'order', id: orderId },
            amount: requested,
            reasonKind: reasonKindOf(order),
            reason: input.reason ?? null,
            itemDefective: input.itemDefective ?? null,
            overridePolicy: false,
            requestedBy: { id: initiatedBy, role: 'vendor', name: null },
            // Honoured only within policy, to the paying number or the card, and never for COD (R-2).
            approveNow: true,
        });

        return this.toResult(request, orderId, returnPolicy);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /**
     * The vendor verdict: the pure policy gates, then the open-request guard and the money +
     * attribution ceiling `RefundRequestService` will enforce — so the amount offered to the
     * vendor is one `create` accepts.
     */
    private async evaluate(
        order: IOrder,
        returnPolicy: IVendorReturnPolicy | null,
        itemDefective: boolean | null
    ): Promise<RefundEligibilityDto> {
        const orderId = (order._id as Types.ObjectId).toString();
        const paid = await findRefundableMoneyForOrder(order);
        const pure = computeVendorRefundEligibility(order, returnPolicy, paid);
        const isCod = order.payment_method === 'cash_on_delivery';
        const base: RefundEligibilityDto = {
            ...pure,
            paymentChannel: paid ? (isCod ? 'cod' : null) : null,
            autoSend: false,
            openRefundRequest: null,
        };

        const open = await this.refunds.findOpenForSource('order', orderId);
        if (open) {
            return {
                ...base,
                eligible: false,
                maxRefundable: 0,
                reasonCode: ERROR_CODES.REFUND_ALREADY_OPEN,
                openRefundRequest: { id: open.id, status: open.status },
            };
        }
        if (!pure.eligible) return base;

        // The ceiling `create` enforces: the money still refundable AND the attribution rule.
        try {
            const facts = await this.refunds.describeSource('order', orderId);
            const attributionCeiling = maxAttributable({
                reasonKind: reasonKindOf(order),
                returnShippingPayer: (facts.returnShippingPayer ?? null) as ReturnShippingPayer | null,
                itemDefective,
                goodsAmount: facts.goodsAmount,
                deliveryAmountPaid: facts.deliveryAmountPaid,
                delivered: facts.delivered,
            });
            // Review finding 10: a cart checkout is ONE payment for N orders, so `pure` measured
            // the policy percentage on the whole cart's balance. Re-run the same rule on THIS
            // order's refundable money (the ceiling `create` enforces).
            const scoped = computeVendorRefundEligibility(order, returnPolicy, {
                amountSnapshot: facts.remaining,
                totalRefunded: 0,
                currencySnapshot: facts.currency,
            });
            if (!scoped.eligible) {
                return { ...base, eligible: false, maxRefundable: 0, remaining: facts.remaining, reasonCode: scoped.reasonCode };
            }
            const maxRefundable = Math.min(scoped.maxRefundable, attributionCeiling, facts.remaining);
            const channel = facts.paymentChannel === 'billing' ? null : facts.paymentChannel;
            const payerKnown = facts.legs.length > 0 && facts.legs.every((l) => Boolean(l.payerPhone));
            return {
                ...base,
                remaining: facts.remaining,
                eligible: maxRefundable > 0,
                maxRefundable: Math.max(0, maxRefundable),
                reasonCode: maxRefundable > 0 ? undefined : ERROR_CODES.REFUND_NOT_ELIGIBLE,
                paymentChannel: channel,
                autoSend: channel === 'card' || (channel === 'mobile_money' && payerKnown),
            };
        } catch (error) {
            // Never throws on ineligibility: a refusal from the money side becomes the reason.
            if (error instanceof AppError && error.statusCode < 500) {
                return { ...base, eligible: false, maxRefundable: 0, reasonCode: error.code };
            }
            throw error;
        }
    }

    private async toResult(
        request: IRefundRequest,
        orderId: string,
        returnPolicy: IVendorReturnPolicy | null
    ): Promise<RefundResultDto> {
        const [totalRefunded, order] = await Promise.all([
            sumCompletedRefundsForOrder(orderId),
            OrderModel.findById(orderId).select('payment_status').lean<{ payment_status?: string } | null>().exec(),
        ]);
        return {
            refundRequestId: request.id,
            refundId: request.id,
            status: request.status,
            amount: request.gross_amount,
            grossAmount: request.gross_amount,
            feeAmount: request.fee_amount,
            netAmount: request.net_amount,
            currency: request.currency,
            paymentChannel: request.payment_channel,
            channel: request.channel ?? null,
            destinationMasked: maskRefundPhone(request.destination?.phone ?? null),
            transferFailureReason: request.transfer_failure_reason ?? null,
            totalRefunded,
            fullyRefunded: request.status === 'completed' && order?.payment_status === 'refunded',
            refundProcessingDays: returnPolicy?.refund_processing_days ?? null,
            returnShippingPayer: returnPolicy?.return_shipping_payer ?? null,
        };
    }

    private async loadOwnedOrder(vendorId: string, orderId: string): Promise<IOrder> {
        if (!Types.ObjectId.isValid(orderId)) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }
        return order;
    }

    private statusForReason(reasonCode?: string): number {
        return refundStatusForReason(reasonCode);
    }
}

/**
 * Before delivery a refund is a CANCELLATION (D-5: everything paid comes back, delivery
 * included); after it, a RETURN (C-1: delivery money only per the return-shipping setting).
 */
export function reasonKindOf(order: Parameters<typeof deliveredAtOf>[0]): RefundReasonKind {
    return deliveredAtOf(order) ? 'return' : 'cancellation';
}

/**
 * The money an order holds, shaped like a payment (`amountSnapshot` / `totalRefunded` /
 * `currencySnapshot`) so `computeVendorRefundEligibility` reads it unchanged:
 *  - online: every succeeded payment of the order (`findSuccessfulPaymentForOrder`);
 *  - COD: the cash COLLECTED from the customer (Σ `expected` of collected collections) and the
 *    completed refunds already recorded against the order. Null when no cash was collected.
 * Shared with the administrator's refund path.
 */
export async function findRefundableMoneyForOrder(
    order: Pick<IOrder, '_id' | 'payment_method' | 'currency'>
): Promise<{ amountSnapshot: number; totalRefunded: number; currencySnapshot: string; gateway?: unknown } | null> {
    const orderId = (order._id as Types.ObjectId).toString();
    if (order.payment_method !== 'cash_on_delivery') return findSuccessfulPaymentForOrder(orderId);
    const coverage = await codCoverageService.coverageForOrder(orderId);
    const collected = coverage.filter((c) => c.status === 'collected');
    if (collected.length === 0) return null;
    return {
        amountSnapshot: collected.reduce((s, c) => s + c.expected, 0),
        totalRefunded: await sumCompletedRefundsForOrder(orderId),
        currencySnapshot: order.currency,
    };
}

/**
 * Find the SUCCEEDED payment that settled an order.
 *
 * `orderIds` as well as `orderId`: a cart checkout writes one payment for N orders and
 * sets only `orderIds`, so matching `orderId` alone reported "no payment" — and therefore
 * "not refundable" — for the majority of orders on the platform. Shared with the admin
 * refund path so both surfaces answer the same question the same way.
 */
export async function findSuccessfulPaymentForOrder(orderId: string) {
    // ⚠ PURPOSE-AWARE (ADR-A11). An order may now hold money in TWO succeeded transactions — its
    // checkout charge and a delivery top-up the customer paid after approving a higher fee. A bare
    // `findOne` picked either arbitrarily, so the eligibility below could report the top-up's
    // small balance as "everything refundable on this order". The checkout charge is returned
    // (its gateway and currency are the order's), with the top-ups' amounts and refunds folded
    // into `amountSnapshot` / `totalRefunded`, so `remaining` describes ALL the money the order
    // holds. `refundPayment` spreads the actual refund over the legs (`payments/domain/refund-legs.ts`).
    const txs = await PaymentTransactionModel.find({
        $or: [
            { orderId: new Types.ObjectId(orderId) },
            { orderIds: new Types.ObjectId(orderId) },
        ],
        status: 'SUCCEEDED'
    }).lean().exec();
    if (txs.length === 0) return null;
    const primary = txs.find((t) => t.purpose !== 'order_delivery_topup') ?? txs[0];
    const topups = txs.filter((t) => t !== primary && t.purpose === 'order_delivery_topup');
    return {
        ...primary,
        amountSnapshot: primary.amountSnapshot + topups.reduce((s, t) => s + t.amountSnapshot, 0),
        totalRefunded: primary.totalRefunded + topups.reduce((s, t) => s + t.totalRefunded, 0),
    };
}

/**
 * Does the VENDOR's return policy allow a refund on this order, and how much?
 *
 * ── Why this is module-level and exported ─────────────────────────────────────
 * It used to be a private method, which meant the only way to consult the vendor's policy
 * was to be gated by it. The administrator's refund path needs the opposite: to REPORT the
 * vendor's verdict — "this is 9 days outside their 14-day window" — while not being bound
 * by it, because a return window is the vendor's commercial promise to their customer and
 * the platform is not party to it.
 *
 * A flag on `VendorRefundService.refund` would have been the smaller diff and the wrong
 * shape: a policy layer that can be told to skip itself is not a policy layer, and it
 * would leave the vendor's own endpoint one boolean away from ignoring the vendor's
 * policy. Pure and shared instead — one definition, two callers, neither able to drift.
 *
 * Never throws. Ineligibility is a `reasonCode`, not an exception.
 */
export function computeVendorRefundEligibility(
    order: IOrder,
    returnPolicy: IVendorReturnPolicy | null,
    paymentTx: { amountSnapshot: number; totalRefunded: number; currencySnapshot: string } | null
): RefundEligibilityDto {
        const currency = paymentTx?.currencySnapshot ?? order.currency ?? null;
        const remaining = paymentTx ? paymentTx.amountSnapshot - paymentTx.totalRefunded : 0;
        const base: RefundEligibilityDto = {
            eligible: false,
            maxRefundable: 0,
            remaining,
            currency,
            refundProcessingDays: returnPolicy?.refund_processing_days ?? null,
            returnShippingPayer: returnPolicy?.return_shipping_payer ?? null,
        };

        // Policy gate
        if (!returnPolicy || !returnPolicy.return_eligible || returnPolicy.refund_type === 'none') {
            return { ...base, reasonCode: ERROR_CODES.REFUND_POLICY_DISABLED };
        }

        // Order must have been paid
        if (order.payment_status !== 'paid') {
            return { ...base, reasonCode: ERROR_CODES.REFUND_ORDER_NOT_PAID };
        }

        // A successful payment with remaining balance must exist
        if (!paymentTx) {
            return { ...base, reasonCode: ERROR_CODES.REFUND_PAYMENT_NOT_FOUND };
        }
        if (remaining <= 0) {
            return { ...base, reasonCode: ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED };
        }

        // Return window, measured from DELIVERY (owner, 2026-10-05, and what the published
        // Returns policy promises: "within N days of receiving it"). It used to run from order
        // CREATION, so a parcel that took a week to arrive had already used half a 14-day window
        // before the customer held it. Not delivered yet → the window has not started, so a
        // refund before delivery (a cancelled paid order) is never "too late".
        const windowStart = deliveredAtOf(order);
        if (windowStart) {
            const windowEnd = windowStart.getTime() + returnPolicy.return_window_days * MS_PER_DAY;
            if (Date.now() > windowEnd) {
                return { ...base, reasonCode: ERROR_CODES.REFUND_WINDOW_EXPIRED };
            }
        }

        // Policy-allowed maximum
        let maxRefundable = remaining;
        if (returnPolicy.refund_type === 'partial') {
            const pct = returnPolicy.refund_percentage ?? 0;
            // Whole units (2026-10-05): a refund request is an integer amount — XAF has no
            // minor unit — and rounding DOWN never offers more than the policy allows.
            maxRefundable = Math.floor(remaining * (pct / 100));
        }

        if (maxRefundable <= 0) {
            return { ...base, reasonCode: ERROR_CODES.REFUND_NOT_ELIGIBLE };
        }

    return { ...base, eligible: true, maxRefundable, remaining, currency };
}

/** The HTTP status an ineligibility reason deserves. Shared by both refund surfaces. */
export function refundStatusForReason(reasonCode?: string): number {
    switch (reasonCode) {
        case ERROR_CODES.REFUND_PAYMENT_NOT_FOUND:
            return 404;
        case ERROR_CODES.REFUND_ORDER_NOT_PAID:
        case ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED:
            return 409;
        default:
            return 422;
    }
}
