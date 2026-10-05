import { Types } from 'mongoose';
import { IOrder, OrderModel } from './order.model';
import { IVendorReturnPolicy } from '../vendors/vendor.model';
import { VendorRepository } from '../vendors/vendor.repository';
import {
    RefundEligibilityDto,
    computeVendorRefundEligibility,
    findRefundableMoneyForOrder,
    reasonKindOf,
} from '../vendor/service/vendor-refund.service';
import { refundRequestService, RefundRequestService } from '../payments/services/refund-request.service';
import { sumCompletedRefundsForOrder } from '../payments/services/refund-ledger';
import { IRefundRequest } from '../payments/models/refund-request.model';
import { maxAttributable, ReturnShippingPayer } from '../payments/domain/refund-attribution';
import { PaymentGatewayType } from '../payments/models/payment-transaction.model';
import { AppError, createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

/**
 * The amount at and above which this LEGACY route refuses and points at the refund queue.
 *
 * The same number as wi-admin's `LARGE_REFUND` / `LARGE_PAYOUT` four-eyes line: this route creates
 * AND approves in one call, so it has no second administrator — and the queue
 * (`/api/internal/admin/refunds`) is where wi-admin enforces one. Below the line the legacy
 * route keeps working for the screens that still call it.
 */
export const LEGACY_ADMIN_REFUND_CEILING = 2_000_000;

/**
 * AdminRefundService — the platform's LEGACY refund door (`POST /api/internal/admin/orders/:orderId/refund`).
 *
 * ── What changed (REFUND-FLOW-PLAN § 4, 2026-10-05) ──────────────────────────────
 * It used to call the gateway's refund API synchronously, so it refused mobile money (no API)
 * and COD (no charge). It now OPENS A REFUND REQUEST through `RefundRequestService`, created and
 * approved in one call — the administrator IS the approver — so:
 *   - card       → refunded through Stripe in the call (`completed`);
 *   - mobile money → a transfer to the number that paid (`sending`), fee taken (R-3);
 *   - COD, or no paying number on record → `awaiting_approval` in the refund queue, where a
 *     number is typed with its proof and a SECOND administrator approves (R-7). This route has
 *     no destination field, deliberately: a typed number is the queue's job.
 * ⛔ A refund of 2,000,000 or more is REFUSED here (`422 REFUND_USE_REFUND_QUEUE`): the
 * four-eyes approval at that line lives on the queue, and this route would bypass it.
 *
 * ── What it may and may not override (unchanged) ───────────────────────────────
 *   MAY (the vendor's commercial terms)      MUST NOT (the money invariants)
 *   return_eligible === false                more than the remaining refundable balance
 *   refund_type === 'none'                   more than the attribution rule allows (C-1, D-5)
 *   the return window                        an order with nothing paid
 *   refund_percentage                        a second open refund on the order
 *
 * The money invariants are `RefundRequestService.create`'s and are not reimplemented here.
 * `overridePolicy` overrides a commercial policy, never a money invariant.
 */

export interface AdminRefundEligibilityDto {
    /** The MONEY verdict — is there money with a balance to refund? */
    eligible: boolean;
    /**
     * The most a refund may return: the remaining balance capped by the attribution rule (after
     * delivery the customer's delivery money comes back only per the vendor's return-shipping
     * setting, C-1). Deliberately NOT the vendor's policy fraction.
     */
    maxRefundable: number;
    remaining: number;
    currency: string | null;
    reasonCode?: string;
    gateway: PaymentGatewayType | null;
    /**
     * Whether the money goes back on its own once approved: a card (Stripe's refund API) or a
     * mobile-money payment whose paying number is on record (a payout). False for COD and for a
     * payment with no number — those wait in the refund queue for a typed number.
     */
    gatewayRefundSupported: boolean;
    isCod: boolean;
    /** What the VENDOR's own policy would have allowed. Reported, never enforced. */
    vendorPolicy: RefundEligibilityDto;
    /** Which vendor gates a refund would bypass. Empty ⇒ no override in play. */
    overrides: VendorPolicyOverride[];
    /** A refund request already open on the order — a second one is refused until it closes. */
    openRefundRequest: { id: string; status: IRefundRequest['status'] } | null;
    /** At or above this, this route refuses: use the refund queue (four-eyes). */
    legacyRouteCeiling: number;
}

export type VendorPolicyOverride =
    /** The vendor's return window has closed. */
    | 'return_window_expired'
    /** The vendor does not offer returns, or has refunds switched off. */
    | 'policy_disabled'
    /** The order was never paid, so the vendor's own path would refuse it outright. */
    | 'order_not_paid'
    /** Within policy, but above the fraction the vendor's `refund_percentage` allows. */
    | 'above_policy_maximum';

export interface AdminRefundResultDto {
    /** @deprecated alias of `refundRequestId` (it used to be a `refund_transactions` id). */
    refundId: string;
    refundRequestId: string;
    /** The REQUEST's status — `completed` (card), `sending`, `awaiting_approval`, `failed`, … */
    status: IRefundRequest['status'];
    /** GROSS — what the order loses. */
    amount: number;
    grossAmount: number;
    feeAmount: number;
    netAmount: number;
    currency: string;
    paymentChannel: IRefundRequest['payment_channel'];
    channel: IRefundRequest['channel'];
    transferFailureReason: string | null;
    totalRefunded: number;
    /** True only once the refund COMPLETED and squared the order. */
    fullyRefunded: boolean;
    /** False when the refund went beyond what the vendor's policy would have allowed. */
    withinVendorPolicy: boolean;
    overrides: VendorPolicyOverride[];
}

export class AdminRefundService {
    private vendorRepo = new VendorRepository();

    constructor(private readonly refunds: RefundRequestService = refundRequestService) {}

    /**
     * What an administrator may refund, and what it would cost the vendor's policy.
     *
     * Read-only and never throws on ineligibility — the same contract as the vendor's
     * `getEligibility`, because a dashboard renders this before offering a button.
     */
    async getEligibility(orderId: string): Promise<AdminRefundEligibilityDto> {
        const { order, returnPolicy } = await this.load(orderId);
        return this.evaluate(order, returnPolicy, null, null);
    }

    /**
     * Refund an order on the platform's authority: open a refund request, approved in the same
     * call when there is somewhere to send the money.
     *
     * `reason` is REQUIRED where the vendor's is optional: an administrator overriding a
     * vendor's commercial policy has to say why, the vendor will ask.
     */
    async refund(
        orderId: string,
        input: { amount?: number; reason: string; overridePolicy?: boolean; itemDefective?: boolean },
        actor: { id: string; name?: string | null }
    ): Promise<AdminRefundResultDto> {
        const { order, returnPolicy } = await this.load(orderId);

        // A frozen order is not refundable from here — the dispute path owns that money,
        // and resolving the dispute `lost` is the verb for it. Consistent with every other
        // order write, all of which raise 423 on an active hold.
        if (order.dispute_hold?.active) {
            throw createAppError(ERROR_CODES.ORDER_DISPUTE_HOLD, 423, undefined, {
                disputeId: order.dispute_hold.gateway_dispute_id,
                reason: order.dispute_hold.reason,
            });
        }

        const verdict = await this.evaluate(order, returnPolicy, input.amount ?? null, input.itemDefective ?? null);

        if (verdict.openRefundRequest) {
            throw createAppError(ERROR_CODES.REFUND_ALREADY_OPEN, 409, undefined, {
                refundRequestId: verdict.openRefundRequest.id,
                status: verdict.openRefundRequest.status,
            });
        }
        // The MONEY verdict is not overridable.
        if (!verdict.eligible) {
            throw createAppError(
                (verdict.reasonCode as never) ?? ERROR_CODES.REFUND_NOT_ELIGIBLE,
                verdict.reasonCode === ERROR_CODES.REFUND_PAYMENT_NOT_FOUND ? 404 : 409,
                undefined,
                { orderId }
            );
        }

        // Absent means the most the money allows — NOT the vendor's policy cap.
        const amount = input.amount ?? verdict.maxRefundable;

        // ⛔ The four-eyes line lives on the refund queue; this route has no second administrator.
        // CUMULATIVE per order (review finding 8): what this order already returned plus this
        // amount, so 1,999,999 followed by 1,999,999 cannot slip past the line in pieces. An open
        // request on the order was refused above, so completed refunds are the whole history.
        const alreadyRefunded = await sumCompletedRefundsForOrder(orderId);
        if (alreadyRefunded + amount >= LEGACY_ADMIN_REFUND_CEILING) {
            throw createAppError(
                ERROR_CODES.REFUND_USE_REFUND_QUEUE,
                422,
                'Refunds of 2,000,000 or more on one order need a second administrator — raise it from the refund queue instead',
                {
                    requested: amount,
                    alreadyRefunded,
                    ceiling: LEGACY_ADMIN_REFUND_CEILING,
                    queue: '/api/internal/admin/refunds',
                }
            );
        }

        // The COMMERCIAL verdict is overridable, and has to be deliberate.
        if (verdict.overrides.length > 0 && !input.overridePolicy) {
            throw createAppError(
                ERROR_CODES.REFUND_POLICY_OVERRIDE_REQUIRED,
                422,
                'This refund goes beyond the vendor’s return policy. Confirm the override to proceed.',
                {
                    overrides: verdict.overrides,
                    requested: amount,
                    vendorMaxRefundable: verdict.vendorPolicy.maxRefundable,
                    vendorReasonCode: verdict.vendorPolicy.reasonCode ?? null,
                    maxRefundable: verdict.maxRefundable,
                }
            );
        }

        const request = await this.refunds.create({
            source: { kind: 'order', id: orderId },
            amount,
            reasonKind: reasonKindOf(order),
            reason: input.reason,
            itemDefective: input.itemDefective ?? null,
            overridePolicy: verdict.overrides.length > 0,
            requestedBy: { id: actor.id || null, role: 'admin', name: actor.name ?? null },
            // The administrator IS the approver — when there is somewhere to send the money. COD
            // and a payment with no paying number wait in the queue for a typed number + proof +
            // a second administrator (R-7); asking `create` to approve those would be refused.
            approveNow: verdict.gatewayRefundSupported,
        });

        const [totalRefunded, fresh] = await Promise.all([
            sumCompletedRefundsForOrder(orderId),
            OrderModel.findById(orderId).select('payment_status').lean<{ payment_status?: string } | null>().exec(),
        ]);
        return {
            refundId: request.id,
            refundRequestId: request.id,
            status: request.status,
            amount: request.gross_amount,
            grossAmount: request.gross_amount,
            feeAmount: request.fee_amount,
            netAmount: request.net_amount,
            currency: request.currency,
            paymentChannel: request.payment_channel,
            channel: request.channel ?? null,
            transferFailureReason: request.transfer_failure_reason ?? null,
            totalRefunded,
            fullyRefunded: request.status === 'completed' && fresh?.payment_status === 'refunded',
            withinVendorPolicy: verdict.overrides.length === 0,
            overrides: verdict.overrides,
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /** Load unscoped — an administrator is above the vendor scope, not inside it. */
    private async load(orderId: string): Promise<{ order: IOrder; returnPolicy: IVendorReturnPolicy | null }> {
        if (!Types.ObjectId.isValid(orderId)) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
        }
        const order = await OrderModel.findById(orderId);
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
        }
        const vendor = await this.vendorRepo.findById(order.vendor_id.toString());
        return { order, returnPolicy: vendor?.policies?.return_policy ?? null };
    }

    /**
     * Split the verdict into its two halves: what the MONEY allows (binding — the same ceiling
     * `RefundRequestService.create` enforces) and what the VENDOR's policy allows (reported).
     */
    private async evaluate(
        order: IOrder,
        returnPolicy: IVendorReturnPolicy | null,
        requestedAmount: number | null,
        itemDefective: boolean | null
    ): Promise<AdminRefundEligibilityDto> {
        const orderId = (order._id as Types.ObjectId).toString();
        const money = await findRefundableMoneyForOrder(order);
        let vendorPolicy = computeVendorRefundEligibility(order, returnPolicy, money);
        const isCod = order.payment_method === 'cash_on_delivery';
        const currency = money?.currencySnapshot ?? order.currency ?? null;
        const gateway = !isCod && money ? (((money as { gateway?: PaymentGatewayType }).gateway) ?? null) : null;

        const open = await this.refunds.findOpenForSource('order', orderId);

        let remaining = 0;
        let maxRefundable = 0;
        let moneyReason: string | undefined;
        let autoSend = false;
        try {
            const facts = await this.refunds.describeSource('order', orderId);
            remaining = facts.remaining;
            // Review finding 10: measure the vendor's policy (a partial percentage especially) on
            // THIS order's refundable money, not on a cart-wide payment's balance.
            vendorPolicy = computeVendorRefundEligibility(order, returnPolicy, {
                amountSnapshot: facts.remaining,
                totalRefunded: 0,
                currencySnapshot: facts.currency,
            });
            maxRefundable = Math.min(
                facts.remaining,
                maxAttributable({
                    reasonKind: reasonKindOf(order),
                    returnShippingPayer: (facts.returnShippingPayer ?? null) as ReturnShippingPayer | null,
                    itemDefective,
                    goodsAmount: facts.goodsAmount,
                    deliveryAmountPaid: facts.deliveryAmountPaid,
                    delivered: facts.delivered,
                })
            );
            if (remaining <= 0) moneyReason = ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED;
            else if (maxRefundable <= 0) moneyReason = ERROR_CODES.REFUND_NOT_ELIGIBLE;
            autoSend =
                facts.paymentChannel === 'card'
                || (facts.paymentChannel === 'mobile_money'
                    && facts.legs.length > 0
                    && facts.legs.every((l) => Boolean(l.payerPhone)));
        } catch (error) {
            if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
            moneyReason = error.code;
        }

        const amount = requestedAmount ?? maxRefundable;
        const overrides: VendorPolicyOverride[] = [];
        if (vendorPolicy.reasonCode === ERROR_CODES.REFUND_WINDOW_EXPIRED) {
            overrides.push('return_window_expired');
        }
        if (vendorPolicy.reasonCode === ERROR_CODES.REFUND_POLICY_DISABLED) {
            overrides.push('policy_disabled');
        }
        if (vendorPolicy.reasonCode === ERROR_CODES.REFUND_ORDER_NOT_PAID) {
            overrides.push('order_not_paid');
        }
        // Only meaningful when the vendor WOULD have allowed something: a refund above a
        // ceiling of zero is already described by one of the reasons above, and listing
        // both would read as two separate overrides for one decision.
        if (vendorPolicy.eligible && amount > vendorPolicy.maxRefundable) {
            overrides.push('above_policy_maximum');
        }

        return {
            eligible: moneyReason === undefined && !open,
            maxRefundable: Math.max(0, maxRefundable),
            remaining,
            currency,
            reasonCode: open ? ERROR_CODES.REFUND_ALREADY_OPEN : moneyReason,
            gateway,
            // Kept under its old name for the screens that read it: "will this go back on its own?"
            gatewayRefundSupported: autoSend,
            isCod,
            vendorPolicy,
            overrides,
            openRefundRequest: open ? { id: open.id, status: open.status } : null,
            legacyRouteCeiling: LEGACY_ADMIN_REFUND_CEILING,
        };
    }
}

export const adminRefundService = new AdminRefundService();
