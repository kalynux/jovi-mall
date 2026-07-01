import { Types } from 'mongoose';
import { OrderModel } from '../../orders/order.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { ProductModel } from '../../catalog/models/product.model';
import { CustomerModel } from '../../customers/customer.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { FileModel } from '../../catalog/models/file.model';
import { getStorageProvider } from '../../../core/storage/storage.instance';

/**
 * Ticket Reference Service
 *
 * Cheap, read-only lookups powering the ticket-creation form: the lightweight
 * lists of orders and products an actor can reference (→ `entityId`), plus the
 * per-order tracking numbers (→ `trackingNumber`, may be null when the order is
 * not yet dispatched).
 *
 * Every query is role-scoped so an actor only ever sees their own references.
 * Enrichment (customer/agency names, product thumbnail) is resolved via batched
 * lookups against existing collections — no field is denormalised onto the base
 * schemas.
 */

export interface ReferencePagination {
    page: number;
    limit: number;
    /** Optional free-text search term. */
    q?: string;
}

interface PagedResult<T> {
    data: T[];
    pagination: { total: number; page: number; limit: number; pages: number };
}

/** Escape user input before using it in a RegExp. */
function escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class TicketReferenceService {
    /**
     * Order scope filter for a role. Returns null for `agent` (resolved via
     * shipments) and an empty filter for `admin` (unscoped).
     */
    private orderScopeFilter(role: string, roleEntityId: string): Record<string, unknown> | null {
        switch (role) {
            case 'customer':
                return { customer_id: new Types.ObjectId(roleEntityId) };
            case 'vendor':
                return { vendor_id: new Types.ObjectId(roleEntityId) };
            case 'agency':
                return { 'items.delivery.agency_id': new Types.ObjectId(roleEntityId) };
            case 'agent':
                return null;
            default:
                return {}; // admin — unscoped
        }
    }

    /** Resolve the effective order filter, handling the agent-via-shipments case. */
    private async resolveOrderFilter(role: string, roleEntityId: string): Promise<Record<string, unknown>> {
        if (role === 'agent') {
            const orderIds = await ShipmentModel.distinct('order_id', { agent_id: new Types.ObjectId(roleEntityId) });
            return { _id: { $in: orderIds } };
        }
        return this.orderScopeFilter(role, roleEntityId) ?? {};
    }

    /**
     * Lightweight list of orders the actor can reference, each with its
     * (role-scoped) shipments and tracking numbers, plus the customer label the
     * picker shows as the primary line. Supports `q` search over order number,
     * customer name, and tracking number.
     */
    async listOrders(role: string, roleEntityId: string, pagination: ReferencePagination): Promise<PagedResult<any>> {
        const { page, limit, q } = pagination;
        const skip = (page - 1) * limit;

        const scope = await this.resolveOrderFilter(role, roleEntityId);
        let filter: Record<string, unknown> = scope;

        // Search across order number + customer name + tracking number.
        if (q && q.trim()) {
            const rx = new RegExp(escapeRegex(q.trim()), 'i');

            const matchingCustomerIds = await CustomerModel.find({ name: rx }).distinct('_id');

            const trackShipmentFilter: Record<string, unknown> = { tracking_number: rx };
            if (role === 'agency') trackShipmentFilter.agency_id = new Types.ObjectId(roleEntityId);
            if (role === 'agent') trackShipmentFilter.agent_id = new Types.ObjectId(roleEntityId);
            const trackingOrderIds = await ShipmentModel.distinct('order_id', trackShipmentFilter);

            const or: Record<string, unknown>[] = [{ order_number: rx }];
            if (matchingCustomerIds.length) or.push({ customer_id: { $in: matchingCustomerIds } });
            if (trackingOrderIds.length) or.push({ _id: { $in: trackingOrderIds } });

            filter = { $and: [scope, { $or: or }] };
        }

        const [orders, total] = await Promise.all([
            OrderModel.find(filter)
                .select('order_number order_type fulfillment_status created_at customer_id')
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            OrderModel.countDocuments(filter)
        ]);

        // ── Batch-resolve customer labels ──
        const customerIds = [...new Set(orders.map(o => o.customer_id?.toString()).filter(Boolean))] as string[];
        const customers = customerIds.length
            ? await CustomerModel.find({ _id: { $in: customerIds } }).select('name avatar_url').lean()
            : [];
        const customerMap = new Map(customers.map(c => [c._id.toString(), c as any]));

        // ── Shipments for this page, scoped to the actor for agency/agent ──
        const orderIds = orders.map(o => o._id);
        const shipmentFilter: Record<string, unknown> = { order_id: { $in: orderIds } };
        if (role === 'agency') shipmentFilter.agency_id = new Types.ObjectId(roleEntityId);
        if (role === 'agent') shipmentFilter.agent_id = new Types.ObjectId(roleEntityId);

        const shipments = await ShipmentModel.find(shipmentFilter)
            .select('order_id agency_id agent_id tracking_number status')
            .lean();

        // ── Batch-resolve agency names ──
        const agencyIds = [...new Set(shipments.map(s => s.agency_id?.toString()).filter(Boolean))] as string[];
        const agencies = agencyIds.length
            ? await DeliveryAgencyModel.find({ _id: { $in: agencyIds } }).select('agency_name').lean()
            : [];
        const agencyNameMap = new Map(agencies.map(a => [a._id.toString(), (a as any).agency_name]));

        const shipmentsByOrder = new Map<string, any[]>();
        for (const s of shipments) {
            const key = s.order_id.toString();
            const agencyId = s.agency_id ? s.agency_id.toString() : null;
            if (!shipmentsByOrder.has(key)) shipmentsByOrder.set(key, []);
            shipmentsByOrder.get(key)!.push({
                shipmentId: s._id.toString(),
                agencyId,
                agencyName: agencyId ? (agencyNameMap.get(agencyId) ?? null) : null,
                agentId: s.agent_id ? s.agent_id.toString() : null,
                trackingNumber: s.tracking_number ?? null,
                status: s.status
            });
        }

        const data = orders.map(o => {
            const customer = o.customer_id ? customerMap.get(o.customer_id.toString()) : null;
            return {
                id: o._id.toString(),
                orderNumber: o.order_number,
                orderType: o.order_type,
                fulfillmentStatus: o.fulfillment_status,
                createdAt: o.created_at,
                customerName: customer?.name ?? null,
                customerAvatarUrl: customer?.avatar_url ?? null,
                shipments: shipmentsByOrder.get(o._id.toString()) ?? []
            };
        });

        return { data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
    }

    /**
     * Lightweight list of products the actor can reference, with the row's
     * secondary line (category/tags) and thumbnail. Supports `q` search over
     * title, category, and tags.
     * - vendor → own catalogue
     * - admin  → all products
     * - customer / agency / agent → products appearing in the orders they can see
     */
    async listProducts(role: string, roleEntityId: string, pagination: ReferencePagination): Promise<PagedResult<any>> {
        const { page, limit, q } = pagination;
        const skip = (page - 1) * limit;

        // Base scope (excludes soft-deleted products).
        let baseFilter: Record<string, unknown>;
        if (role === 'vendor') {
            baseFilter = { vendorId: new Types.ObjectId(roleEntityId), deletedAt: null };
        } else if (role === 'admin') {
            baseFilter = { deletedAt: null };
        } else {
            const orderFilter = await this.resolveOrderFilter(role, roleEntityId);
            const productIds = await OrderModel.distinct('items.product_id', orderFilter);
            baseFilter = { _id: { $in: productIds }, deletedAt: null };
        }

        let filter: Record<string, unknown> = baseFilter;
        if (q && q.trim()) {
            const rx = new RegExp(escapeRegex(q.trim()), 'i');
            filter = { $and: [baseFilter, { $or: [{ title: rx }, { category: rx }, { tags: rx }] }] };
        }

        const [products, total] = await Promise.all([
            ProductModel.find(filter)
                .select('title slug category tags fileIds')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            ProductModel.countDocuments(filter)
        ]);

        // ── Batch-resolve first-image URLs ──
        const firstFileIds = products
            .map(p => (p.fileIds && p.fileIds.length ? p.fileIds[0] : null))
            .filter(Boolean) as Types.ObjectId[];
        const files = firstFileIds.length
            ? await FileModel.find({ _id: { $in: firstFileIds } }).select('key').lean()
            : [];
        const fileKeyMap = new Map(files.map(f => [f._id.toString(), (f as any).key]));
        const storage = getStorageProvider();

        const data = products.map(p => {
            const firstFileId = p.fileIds && p.fileIds.length ? p.fileIds[0].toString() : null;
            const key = firstFileId ? fileKeyMap.get(firstFileId) : null;
            return {
                id: p._id.toString(),
                title: p.title,
                slug: p.slug,
                category: p.category ?? null,
                tags: p.tags ?? [],
                firstFileUrl: key ? storage.getPublicUrl(key) : null
            };
        });

        return { data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
    }
}
