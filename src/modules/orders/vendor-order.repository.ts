import { OrderModel, IOrder } from './order.model';
import { FilterQuery, Types } from 'mongoose';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { buildSearchRegex } from '../../core/utils/regex.util';

/**
 * Vendor Order Repository
 * 
 * Vendor-scoped order queries with ownership enforcement at DB level.
 * 
 * SECURITY:
 * - ALL queries enforce vendorId filter
 * - Zero possibility of cross-vendor data leakage
 * - Ownership validated at query level, not application level
 * 
 * PERFORMANCE:
 * - Leverages compound indexes on { vendor_id, created_at }
 * - Efficient filtering and sorting
 */

export interface OrderFilters {
    status?: string;
    paymentStatus?: string;
    paymentMethod?: string;  // 'online' | 'cash_on_delivery'
    orderType?: 'physical' | 'digital';  // NEW: Filter by order type
    customerId?: string;                  // NEW: Scope to a single customer (Customer Management)
    dateFrom?: Date;
    dateTo?: Date;
    q?: string;  // Search order number or customer email
}

export class VendorOrderRepository {
    /**
     * Find orders by vendor with filters and pagination
     * 
     * Ownership enforced in query - vendor can ONLY see their orders.
     */
    async findByVendor(
        vendorId: string,
        filters: OrderFilters = {},
        pagination: PaginationOptions
    ): Promise<Page<IOrder>> {
        const query: FilterQuery<IOrder> = {
            vendor_id: vendorId  // CRITICAL: Vendor ownership enforcement
        };

        // Apply filters
        if (filters.status) {
            query.fulfillment_status = filters.status;
        }

        if (filters.paymentStatus) {
            query.payment_status = filters.paymentStatus;
        }

        if (filters.paymentMethod) {
            query.payment_method = filters.paymentMethod;
        }

        // NEW: Order type filter
        if (filters.orderType) {
            query.order_type = filters.orderType;
        }

        // NEW: Customer scope (Customer Management → "View Orders")
        if (filters.customerId) {
            query.customer_id = filters.customerId;
        }

        if (filters.dateFrom || filters.dateTo) {
            query.created_at = {};
            if (filters.dateFrom) {
                query.created_at.$gte = filters.dateFrom;
            }
            if (filters.dateTo) {
                query.created_at.$lte = filters.dateTo;
            }
        }

        if (filters.q) {
            /**
             * Search in order number, case-insensitive substring.
             *
             * ⚠ Fixed 2026-09-07 (DOC-PROGRAM § 30). This was
             * `{ $regex: filters.q, $options: 'i' }` — the raw, caller-supplied string
             * compiled as a pattern, which this repository's own ESLint rule bans on the
             * `new RegExp()` form for exactly this reason. Two problems, not one: a term
             * containing regex metacharacters silently matches the wrong orders, and a
             * crafted one (`(a+)+$` and friends) is a ReDoS against a vendor-authenticated
             * endpoint. `buildSearchRegex` escapes and trims.
             */
            query.order_number = buildSearchRegex(filters.q);
        }

        // Pagination
        const { page = 1, limit = 20, sort = { created_at: -1 } } = pagination;
        const skip = (page - 1) * limit;

        // Execute queries in parallel
        const [total, orders] = await Promise.all([
            OrderModel.countDocuments(query),
            OrderModel
                .find(query)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .select('-items.delivery')  // Exclude delivery details from list view
                .lean()
                .exec()
        ]);

        return {
            data: orders as unknown as IOrder[],
            meta: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit)
            }
        };
    }

    /**
     * Find single order by ID with vendor ownership check
     * 
     * Returns null if order not found OR not owned by vendor.
     * This prevents leaking existence of other vendors' orders.
     */
    async findByIdAndVendor(orderId: string, vendorId: string): Promise<IOrder | null> {
        return await OrderModel
            .findOne({
                _id: orderId,
                vendor_id: vendorId  // CRITICAL: Ownership check
            })
            .lean()
            .exec() as IOrder | null;
    }

    /**
     * Update fulfillment status
     * 
     * Ownership enforced in query.
     * Returns updated order or null if not found/not owned.
     */
    async updateFulfillmentStatus(
        orderId: string,
        vendorId: string,
        newStatus: string
    ): Promise<IOrder | null> {
        return await OrderModel
            .findOneAndUpdate(
                {
                    _id: orderId,
                    vendor_id: vendorId  // CRITICAL: Ownership check
                },
                {
                    $set: { fulfillment_status: newStatus }
                },
                { new: true }
            )
            .lean()
            .exec() as IOrder | null;
    }

    /**
     * Reassign the delivery agency for a SINGLE order item.
     *
     * Uses the positional `$` operator so only the matched item is touched —
     * other items keep their own agency, which is what lets one order be split
     * across several delivery agencies. The item's shipment_id and delivery
     * status are updated to reflect its new shipment (resolved by the caller).
     *
     * RULES:
     * - Ownership enforced in query (vendor_id)
     * - Item must belong to the order (matched via items._id)
     * - Returns updated order or null if not found / not owned / item missing
     */
    async reassignItemDeliveryAgency(
        orderId: string,
        vendorId: string,
        itemId: string,
        deliveryAgencyId: string,
        shipmentId: string,
        deliveryStatus: string
    ): Promise<IOrder | null> {
        return await OrderModel
            .findOneAndUpdate(
                {
                    _id: orderId,
                    vendor_id: vendorId,        // CRITICAL: Ownership check
                    'items._id': new Types.ObjectId(itemId)
                },
                {
                    $set: {
                        'items.$.delivery.agency_id': new Types.ObjectId(deliveryAgencyId),
                        'items.$.delivery.shipment_id': new Types.ObjectId(shipmentId),
                        'items.$.delivery.status': deliveryStatus,
                        'items.$.delivery.hold': null,
                        updated_at: new Date()
                    }
                },
                { new: true }
            )
            .lean()
            .exec() as IOrder | null;
    }

    /**
     * Find physical orders for a vendor with at least one item still riding on
     * the given agency and reassignable (pending/assigned/pending_agency_reassignment
     * — not yet dispatched). Used to auto-move items when the vendor's default
     * delivery agency changes. Terminal orders (delivered/cancelled) are excluded
     * up front.
     */
    async findReassignableByVendorAndAgency(vendorId: string, agencyId: string): Promise<IOrder[]> {
        return await OrderModel
            .find({
                vendor_id: vendorId,
                order_type: 'physical',
                fulfillment_status: { $nin: ['delivered', 'cancelled'] },
                items: {
                    $elemMatch: {
                        'delivery.agency_id': new Types.ObjectId(agencyId),
                        'delivery.status': { $in: ['pending', 'assigned', 'pending_agency_reassignment'] },
                    },
                },
            })
            .lean()
            .exec() as unknown as IOrder[];
    }

    /**
     * Find physical orders for a vendor with at least one item, FOR A SPECIFIC
     * PRODUCT, still riding on the given agency and reassignable. Used when a
     * vendor fixes a product's own delivery-agency override (as opposed to
     * findReassignableByVendorAndAgency, which is triggered by a vendor default
     * change and applies across all of the vendor's products).
     */
    async findReassignableByProductAndAgency(vendorId: string, productId: string, agencyId: string): Promise<IOrder[]> {
        return await OrderModel
            .find({
                vendor_id: vendorId,
                order_type: 'physical',
                fulfillment_status: { $nin: ['delivered', 'cancelled'] },
                items: {
                    $elemMatch: {
                        product_id: new Types.ObjectId(productId),
                        'delivery.agency_id': new Types.ObjectId(agencyId),
                        'delivery.status': { $in: ['pending', 'assigned', 'pending_agency_reassignment'] },
                    },
                },
            })
            .lean()
            .exec() as unknown as IOrder[];
    }

    /**
     * Count orders by vendor (for pagination metadata)
     */
    async countByVendor(vendorId: string, filters: OrderFilters = {}): Promise<number> {
        const query: FilterQuery<IOrder> = {
            vendor_id: vendorId
        };

        if (filters.status) {
            query.fulfillment_status = filters.status;
        }

        if (filters.paymentStatus) {
            query.payment_status = filters.paymentStatus;
        }

        return await OrderModel.countDocuments(query);
    }
}
