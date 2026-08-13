import { Types } from 'mongoose';
import { IOrder, OrderModel } from './order.model';
import { IVendorReturnPolicy } from '../vendors/vendor.model';
import { VendorRepository } from '../vendors/vendor.repository';
import { VendorCustomerSyncService } from '../vendors/services/vendor-customer-sync.service';
import {
    RefundEligibilityDto,
    computeVendorRefundEligibility,
    findSuccessfulPaymentForOrder,
} from '../vendor/service/vendor-refund.service';
import { PaymentOrchestratorService } from '../payments/services/payment-orchestrator.service';
import { PaymentGatewayType } from '../payments/models/payment-transaction.model';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

/**
 * AdminRefundService — the platform's refund path, and the THIRD policy layer over one
 * money pipeline.
 *
 * ── Why a third layer rather than a flag ──────────────────────────────────────
 * There are two existing entry points and neither fits.
 *
 * `VendorRefundService` is hard-scoped (`loadOwnedOrder(vendorId, orderId)`) and enforces
 * the vendor's four commercial gates: `return_eligible`, `refund_type !== 'none'`, the
 * return window, and `refund_percentage`. Those are the VENDOR's promises to their
 * CUSTOMER. An administrator refunding — settling a chargeback, closing a fraud case,
 * answering a regulator — IS the act of overriding them, so entering there means telling
 * an operator "the vendor's 14-day window expired" about an order the platform has already
 * decided to refund. Adding an `overridePolicy` flag to that service would be worse: a
 * policy layer that can be told to skip itself is not a policy layer, and it would leave
 * the vendor's own endpoint one boolean away from ignoring the vendor's policy.
 *
 * The bare orchestrator is the other extreme. It requires a `vendorId` only the order
 * knows, computes no ceiling of its own, and — the real one — never runs
 * `recordFullRefund`, so an admin path that called it directly would silently drift every
 * refunded customer's denormalised lifetime spend away from the vendor path's.
 *
 * ── What this file may and may not override ───────────────────────────────────
 *
 *   MAY (the vendor's commercial terms)      MUST NOT (the money invariants)
 *   ─────────────────────────────────────    ────────────────────────────────────────────
 *   return_eligible === false                more than the remaining refundable balance
 *   refund_type === 'none'                   an order with no SUCCEEDED payment
 *   the return window                        a gateway with no refund API
 *   refund_percentage                        an already fully-refunded payment
 *                                            the pipeline shape (pending row → gateway →
 *                                            atomic finalize → escrow reversal)
 *
 * Every entry in the right column already lives inside `refundPayment`, and NONE of them
 * is reimplemented here. `overridePolicy` never reaches the orchestrator: an amount above
 * the remaining balance is `REFUND_AMOUNT_EXCEEDS_MAX` whatever the flag says. **The flag
 * overrides a commercial policy, never a money invariant.**
 *
 * The one guard this file adds is COD, which the orchestrator cannot express because it
 * does not know the source is COD.
 */

export interface AdminRefundEligibilityDto {
    /** The MONEY verdict — is there a gateway payment with a balance to refund? */
    eligible: boolean;
    /** The full remaining balance. Deliberately NOT the vendor's policy fraction. */
    maxRefundable: number;
    remaining: number;
    currency: string | null;
    reasonCode?: string;
    gateway: PaymentGatewayType | null;
    /**
     * Whether that gateway can actually refund. Only Stripe implements one; NotchPay and
     * MyCoolPay are explicit placeholders that raise `REFUND_GATEWAY_NOT_SUPPORTED`.
     *
     * Reported UP FRONT on purpose. Discovering it after the button is pressed leaves a
     * `pending` RefundTransaction behind and an operator who thinks money moved.
     */
    gatewayRefundSupported: boolean;
    isCod: boolean;
    /** What the VENDOR's own policy would have allowed. Reported, never enforced. */
    vendorPolicy: RefundEligibilityDto;
    /** Which vendor gates a refund would bypass. Empty ⇒ no override in play. */
    overrides: VendorPolicyOverride[];
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
    refundId: string;
    status: 'completed';
    amount: number;
    currency: string;
    totalRefunded: number;
    fullyRefunded: boolean;
    /** False when the refund went beyond what the vendor's policy would have allowed. */
    withinVendorPolicy: boolean;
    overrides: VendorPolicyOverride[];
}

const NON_REFUNDABLE_GATEWAYS: PaymentGatewayType[] = ['NOTCHPAY', 'MYCOOLPAY'];

export class AdminRefundService {
    private vendorRepo = new VendorRepository();
    private orchestrator = new PaymentOrchestratorService();
    private vendorCustomerSync = new VendorCustomerSyncService();

    /**
     * What an administrator may refund, and what it would cost the vendor's policy.
     *
     * Read-only and never throws on ineligibility — the same contract as the vendor's
     * `getEligibility`, because a dashboard renders this before offering a button.
     */
    async getEligibility(orderId: string): Promise<AdminRefundEligibilityDto> {
        const { order, returnPolicy, paymentTx } = await this.load(orderId);
        return this.evaluate(order, returnPolicy, paymentTx, null);
    }

    /**
     * Refund an order on the platform's authority.
     *
     * `reason` is REQUIRED where the vendor's is optional: an administrator overriding a
     * vendor's commercial policy has to say why, the vendor will ask, and
     * `RefundTransaction.reason` is the only place jovi-mall can store it — wi-admin's
     * audit trail lives in a database this service cannot read.
     */
    async refund(
        orderId: string,
        input: { amount?: number; reason: string; overridePolicy?: boolean },
        actor: { id: string; name?: string | null }
    ): Promise<AdminRefundResultDto> {
        const { order, returnPolicy, paymentTx } = await this.load(orderId);

        // A frozen order is not refundable from here — the dispute path owns that money,
        // and resolving the dispute `lost` is the verb for it. Consistent with every other
        // order write, all of which raise 423 on an active hold.
        if (order.dispute_hold?.active) {
            throw createAppError(ERROR_CODES.ORDER_DISPUTE_HOLD, 423, undefined, {
                disputeId: order.dispute_hold.gateway_dispute_id,
                reason: order.dispute_hold.reason,
            });
        }

        // COD money never went through a gateway, so there is nothing to reverse. Its own
        // code rather than falling through to REFUND_PAYMENT_NOT_FOUND, which reads as
        // "the record is missing" when the truth is "this was cash".
        if (order.payment_method === 'cash_on_delivery') {
            throw createAppError(ERROR_CODES.REFUND_ORDER_IS_COD, 422, undefined, { orderId });
        }

        const verdict = this.evaluate(order, returnPolicy, paymentTx, input.amount ?? null);

        // The MONEY verdict is not overridable. `maxRefundable` here is the full remaining
        // balance, so a failure means there is genuinely nothing to refund.
        if (!verdict.eligible) {
            throw createAppError(
                (verdict.reasonCode as never) ?? ERROR_CODES.REFUND_NOT_ELIGIBLE,
                verdict.reasonCode === ERROR_CODES.REFUND_PAYMENT_NOT_FOUND ? 404 : 409,
                undefined,
                { orderId }
            );
        }
        if (!verdict.gatewayRefundSupported) {
            throw createAppError(ERROR_CODES.REFUND_GATEWAY_NOT_SUPPORTED, 400, undefined, {
                gateway: verdict.gateway,
            });
        }

        // Absent means the full remaining balance — NOT the vendor's policy cap. An
        // administrator asking to "refund this order" means the order, not the fraction
        // the vendor would have offered.
        const amount = input.amount ?? verdict.maxRefundable;

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

        const result = await this.orchestrator.refundPayment({
            source: { kind: 'order', orderId },
            // Supplied FROM THE RECORD, not from the caller's session — an administrator
            // has no vendor of their own. The same move the shipment paths make with
            // `agency_id`: the platform does not bypass the scope, it resolves it.
            vendorId: order.vendor_id.toString(),
            initiatedBy: actor.id,
            // Provenance, not authorization. The field and its Mongoose enum have always
            // accepted 'admin'; this is its first caller.
            initiatedByRole: 'admin',
            amount,
            reason: input.reason,
        });

        // On a full refund the order leaves the 'paid' set, so roll back the customer's
        // denormalized lifetime spend — the same best-effort block the vendor path runs.
        // Omitting it here is how the two paths would drift on a number neither recomputes.
        if (result.fullyRefunded) {
            try {
                await this.vendorCustomerSync.recordFullRefund(
                    order.vendor_id.toString(),
                    order.customer_id,
                    order.total_amount
                );
            } catch (error) {
                console.error('[AdminRefundService] Failed to sync vendor customer on refund:', error);
            }
        }

        return {
            refundId: result.refundId,
            status: 'completed',
            amount: result.amount,
            currency: result.currency,
            totalRefunded: result.totalRefunded,
            fullyRefunded: result.fullyRefunded,
            withinVendorPolicy: verdict.overrides.length === 0,
            overrides: verdict.overrides,
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /** Load unscoped — an administrator is above the vendor scope, not inside it. */
    private async load(orderId: string): Promise<{
        order: IOrder;
        returnPolicy: IVendorReturnPolicy | null;
        paymentTx: Awaited<ReturnType<typeof findSuccessfulPaymentForOrder>>;
    }> {
        if (!Types.ObjectId.isValid(orderId)) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
        }
        const order = await OrderModel.findById(orderId);
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404, undefined, { orderId });
        }
        const vendor = await this.vendorRepo.findById(order.vendor_id.toString());
        const paymentTx = await findSuccessfulPaymentForOrder(orderId);

        return { order, returnPolicy: vendor?.policies?.return_policy ?? null, paymentTx };
    }

    /**
     * Split the verdict into its two halves: what the MONEY allows (binding) and what the
     * VENDOR's policy allows (reported).
     */
    private evaluate(
        order: IOrder,
        returnPolicy: IVendorReturnPolicy | null,
        paymentTx: Awaited<ReturnType<typeof findSuccessfulPaymentForOrder>>,
        requestedAmount: number | null
    ): AdminRefundEligibilityDto {
        const vendorPolicy = computeVendorRefundEligibility(order, returnPolicy, paymentTx);

        const currency = paymentTx?.currencySnapshot ?? order.currency ?? null;
        const remaining = paymentTx ? paymentTx.amountSnapshot - paymentTx.totalRefunded : 0;
        const gateway = paymentTx?.gateway ?? null;
        const isCod = order.payment_method === 'cash_on_delivery';

        const moneyReason =
            isCod ? ERROR_CODES.REFUND_ORDER_IS_COD
                : !paymentTx ? ERROR_CODES.REFUND_PAYMENT_NOT_FOUND
                    : remaining <= 0 ? ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED
                        : undefined;

        const amount = requestedAmount ?? remaining;
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
            eligible: moneyReason === undefined,
            maxRefundable: remaining,
            remaining,
            currency,
            reasonCode: moneyReason,
            gateway,
            gatewayRefundSupported: gateway !== null && !NON_REFUNDABLE_GATEWAYS.includes(gateway),
            isCod,
            vendorPolicy,
            overrides,
        };
    }
}

export const adminRefundService = new AdminRefundService();
