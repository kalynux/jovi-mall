import { Types } from 'mongoose';
import { VendorOrderRepository } from '../../orders/vendor-order.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { IVendorReturnPolicy } from '../../vendors/vendor.model';
import { IOrder } from '../../orders/order.model';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { VendorCustomerSyncService } from '../../vendors/services/vendor-customer-sync.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES, ErrorCode } from '../../../core/error-codes';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RefundEligibilityDto {
    eligible: boolean;
    maxRefundable: number;       // Most the vendor may refund right now (per policy + balance)
    remaining: number;           // Remaining un-refunded balance of the payment
    currency: string | null;
    reasonCode?: string;         // Why it's not eligible (when eligible === false)
    // Policy info surfaced for the UI/notification (no money movement here).
    refundProcessingDays: number | null;                  // Expected settle window per policy
    returnShippingPayer: IVendorReturnPolicy['return_shipping_payer'] | null; // Who pays return shipping
}

export interface RefundResultDto {
    refundId: string;
    status: 'completed';
    amount: number;
    currency: string;
    totalRefunded: number;
    fullyRefunded: boolean;
    // Echoed from the vendor return policy so the client can inform the customer.
    refundProcessingDays: number | null;
    returnShippingPayer: IVendorReturnPolicy['return_shipping_payer'] | null;
}

/**
 * VendorRefundService
 *
 * Decides whether an order is refundable under the vendor's return policy and the
 * order's state, computes the policy-allowed amount, and delegates the actual
 * gateway refund + persistence to the PaymentOrchestratorService.
 *
 * Eligibility rules (per vendor return_policy):
 * - Policy must exist, be return_eligible, and not be refund_type 'none'.
 * - Order payment_status must be 'paid'.
 * - now must be within created_at + return_window_days.
 * - maxRefundable: full → remaining balance; partial → remaining * refund_percentage%.
 */
export class VendorRefundService {
    private vendorOrderRepo: VendorOrderRepository;
    private vendorRepo: VendorRepository;
    private orchestrator: PaymentOrchestratorService;
    private vendorCustomerSync: VendorCustomerSyncService;

    constructor() {
        this.vendorOrderRepo = new VendorOrderRepository();
        this.vendorRepo = new VendorRepository();
        this.orchestrator = new PaymentOrchestratorService();
        this.vendorCustomerSync = new VendorCustomerSyncService();
    }

    /**
     * Compute refund eligibility for an order (read-only; never throws on
     * ineligibility — returns eligible:false + reasonCode instead).
     */
    async getEligibility(vendorId: string, orderId: string): Promise<RefundEligibilityDto> {
        const order = await this.loadOwnedOrder(vendorId, orderId);
        const vendor = await this.vendorRepo.findById(vendorId);
        const returnPolicy = vendor?.policies?.return_policy ?? null;
        const paymentTx = await this.findSuccessfulPayment(orderId);

        return this.computeEligibility(order, returnPolicy, paymentTx);
    }

    /**
     * Action a refund. Throws an AppError when the order is not refundable or the
     * requested amount exceeds the policy-allowed maximum.
     */
    async refund(
        vendorId: string,
        orderId: string,
        input: { amount?: number; reason?: string },
        initiatedBy: string
    ): Promise<RefundResultDto> {
        const order = await this.loadOwnedOrder(vendorId, orderId);
        const vendor = await this.vendorRepo.findById(vendorId);
        const returnPolicy = vendor?.policies?.return_policy ?? null;
        const paymentTx = await this.findSuccessfulPayment(orderId);

        const eligibility = this.computeEligibility(order, returnPolicy, paymentTx);
        if (!eligibility.eligible) {
            throw createAppError(
                (eligibility.reasonCode as ErrorCode) ?? ERROR_CODES.REFUND_NOT_ELIGIBLE,
                this.statusForReason(eligibility.reasonCode)
            );
        }

        // Default to the policy-computed amount; allow an explicit override downward.
        const requested = input.amount ?? eligibility.maxRefundable;
        if (requested <= 0 || requested > eligibility.maxRefundable) {
            throw createAppError(ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX, 400, undefined, {
                requested,
                maxRefundable: eligibility.maxRefundable
            });
        }

        const result = await this.orchestrator.refundPayment({
            source: { kind: 'order', orderId },
            vendorId,
            initiatedBy,
            initiatedByRole: 'vendor',
            amount: requested,
            reason: input.reason
        });

        // On a full refund the order leaves the 'paid' set, so roll back the
        // customer's denormalized lifetime spend. Secondary side-effect only.
        if (result.fullyRefunded) {
            try {
                await this.vendorCustomerSync.recordFullRefund(
                    vendorId,
                    order.customer_id,
                    order.total_amount
                );
            } catch (error) {
                console.error('[VendorRefundService] Failed to sync vendor customer on refund:', error);
            }
        }

        return {
            refundId: result.refundId,
            status: 'completed',
            amount: result.amount,
            currency: result.currency,
            totalRefunded: result.totalRefunded,
            fullyRefunded: result.fullyRefunded,
            refundProcessingDays: returnPolicy?.refund_processing_days ?? null,
            returnShippingPayer: returnPolicy?.return_shipping_payer ?? null
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

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

    private async findSuccessfulPayment(orderId: string) {
        return findSuccessfulPaymentForOrder(orderId);
    }

    private computeEligibility(
        order: IOrder,
        returnPolicy: IVendorReturnPolicy | null,
        paymentTx: { amountSnapshot: number; totalRefunded: number; currencySnapshot: string } | null
    ): RefundEligibilityDto {
        return computeVendorRefundEligibility(order, returnPolicy, paymentTx);
    }

    private statusForReason(reasonCode?: string): number {
        return refundStatusForReason(reasonCode);
    }
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
    return PaymentTransactionModel.findOne({
        $or: [
            { orderId: new Types.ObjectId(orderId) },
            { orderIds: new Types.ObjectId(orderId) },
        ],
        status: 'SUCCEEDED'
    }).lean().exec();
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

        // Return window (measured from order creation)
        const windowEnd = new Date(order.created_at).getTime() + returnPolicy.return_window_days * MS_PER_DAY;
        if (Date.now() > windowEnd) {
            return { ...base, reasonCode: ERROR_CODES.REFUND_WINDOW_EXPIRED };
        }

        // Policy-allowed maximum
        let maxRefundable = remaining;
        if (returnPolicy.refund_type === 'partial') {
            const pct = returnPolicy.refund_percentage ?? 0;
            maxRefundable = Math.round(remaining * (pct / 100) * 100) / 100;
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
