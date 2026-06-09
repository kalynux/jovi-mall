import { Types } from 'mongoose';
import { VendorCustomerModel } from '../models/vendor-customer.model';

type IdLike = string | Types.ObjectId;

function toObjectId(id: IdLike): Types.ObjectId {
    return id instanceof Types.ObjectId ? id : new Types.ObjectId(id);
}

/**
 * VendorCustomerSyncService
 *
 * Maintains the first-class vendor↔customer relation and its denormalized stats
 * as orders move through their lifecycle. Called directly from the order/payment
 * flows (the app's event bus is not wired for consumers, so direct calls are the
 * reliable channel). Every method is idempotent-friendly and safe to fire as a
 * secondary side-effect — callers should swallow errors so a stats hiccup never
 * fails the primary operation.
 */
export class VendorCustomerSyncService {
    /**
     * A new order was placed: ensure the relation exists (reviving a soft-deleted
     * one), bump the order count, and advance last_order_at.
     */
    async recordOrderPlaced(
        vendorId: IdLike,
        customerId: IdLike,
        orderCreatedAt: Date
    ): Promise<void> {
        const vendor_id = toObjectId(vendorId);
        const customer_id = toObjectId(customerId);
        await VendorCustomerModel.updateOne(
            { vendor_id, customer_id },
            {
                // Operator paths ($inc/$max) must not also appear in $setOnInsert.
                $setOnInsert: {
                    vendor_id,
                    customer_id,
                    source: 'order',
                    total_spent: 0,
                    flag_ids: [],
                    display_name_override: null
                },
                $set: { deletedAt: null },
                $inc: { order_count: 1 },
                $max: { last_order_at: orderCreatedAt }
            },
            { upsert: true }
        ).exec();
    }

    /** An order was fully paid: add its total to the customer's lifetime spend. */
    async recordPaymentPaid(vendorId: IdLike, customerId: IdLike, amount: number): Promise<void> {
        if (!amount) return;
        const vendor_id = toObjectId(vendorId);
        const customer_id = toObjectId(customerId);
        await VendorCustomerModel.updateOne(
            { vendor_id, customer_id },
            {
                $setOnInsert: {
                    vendor_id,
                    customer_id,
                    source: 'order',
                    order_count: 0,
                    flag_ids: [],
                    display_name_override: null,
                    last_order_at: null
                },
                $set: { deletedAt: null },
                $inc: { total_spent: amount }
            },
            { upsert: true }
        ).exec();
    }

    /**
     * A paid order was fully refunded: subtract its total from lifetime spend,
     * clamped at zero. Mirrors the live aggregation, which excludes fully-refunded
     * orders entirely (partial refunds leave the order 'paid' and are not subtracted).
     */
    async recordFullRefund(vendorId: IdLike, customerId: IdLike, amount: number): Promise<void> {
        if (!amount) return;
        const vendor_id = toObjectId(vendorId);
        const customer_id = toObjectId(customerId);
        await VendorCustomerModel.updateOne({ vendor_id, customer_id }, [
            {
                $set: {
                    total_spent: {
                        $max: [0, { $subtract: [{ $ifNull: ['$total_spent', 0] }, amount] }]
                    }
                }
            }
        ]).exec();
    }
}
