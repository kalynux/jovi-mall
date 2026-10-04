/**
 * Assembles the customer-facing order view.
 *
 * Exists so the enrichment — store identity, product thumbnails, COD blocks — is batched
 * **once per response** rather than per order or per line. A checkout group can hold several
 * per-vendor orders and each of those a handful of lines; done naively that is one store
 * query per order and one file query per item, on the customer's most-visited screen.
 *
 * The projection itself lives in `dto/customer-order.dto.ts`. This service only gathers what
 * that function needs.
 */
import { IOrder } from '../order.model';
import { StoreRepository } from '../../store/repositories/store.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { resolveProductImages, ProductImageRef } from '../../catalog/read-models/product-image.resolver';
import { cashCollectionService } from '../../cod/services/cash-collection.service';
import { deliveryFeePaymentOf } from '../domain/delivery-payer';
import { CustomerOrderDto, CustomerOrderShipmentFeeFacts, toCustomerOrderDto } from '../dto/customer-order.dto';
import { ShipmentModel } from '../../shipments/shipment.model';
import { DeliveryFeeRefundModel } from '../../delivery-fee-proposals/models/delivery-fee-refund.model';
import type { DeliveryFeeRefundStatus } from '../../delivery-fee-proposals/domain/customer-fee-change.rules';

export class CustomerOrderViewService {
    constructor(
        private readonly storeRepository = new StoreRepository(),
        private readonly fileRepository = new FileRepositoryMongo(),
        private readonly vendorRepository = new VendorRepository(),
    ) { }

    /**
     * Project a set of orders for their customer.
     *
     * Takes an array rather than one order because both callers have several — the group
     * view by definition, and the single-order view is just an array of one. Keeping one
     * entry point means the batching cannot be skipped by accident on the path that
     * happens to be simpler.
     */
    async toDtos(orders: IOrder[]): Promise<CustomerOrderDto[]> {
        if (orders.length === 0) return [];

        // ── Store identity, one query for every vendor in the set ─────────────
        // The Store is the source of truth for a vendor's business name; the vendor profile
        // holds only a display name. `findNamesByVendorIds` dedupes internally.
        const namesByVendor = await this.storeRepository.findNamesByVendorIds(
            orders.map((o) => o.vendor_id.toString()),
        );
        const slugsByVendor = await this.resolveSlugs(orders);
        // The "verified" badge lives on the VENDOR (`kyc_details.legit_verified`), not the
        // store — one query for every vendor in the set, ids only.
        const verifiedVendors = await this.vendorRepository.findVerifiedVendorIds(
            orders.map((o) => o.vendor_id.toString()),
        );

        // ── Thumbnails, one file query for every line in the set ──────────────
        const refs: ProductImageRef[] = orders.flatMap((order) =>
            order.items.map((item) => ({
                productId: item.product_id.toString(),
                variantId: item.variant_id ? item.variant_id.toString() : null,
            })),
        );
        const imagesByKey = await resolveProductImages(refs, this.fileRepository, getStorageProvider());

        // ── COD blocks, only when some order actually is COD ──────────────────
        // `true` includes the delivery code: this is the customer's own view and the code is
        // their secret — it is what they hand the agent to prove payment.
        // …and the online orders whose delivery fee is paid to the rider in cash (W-F): their
        // fee-only collections carry a delivery code too.
        const codOrders = orders.filter(
            (o) => o.payment_method === 'cash_on_delivery' || deliveryFeePaymentOf(o) === 'cash_to_rider'
        );
        const codByOrder = codOrders.length > 0
            ? await cashCollectionService.getCodBlocksForOrders(codOrders.map((o) => String(o._id)), true)
            : new Map<string, unknown[]>();

        // ── Per-parcel delivery fees (ADR-A11), one query for every physical order ──
        // The money fields only — what the customer paid per parcel and what is owed back.
        const shipmentsByOrder = await this.resolveShipmentFees(orders);
        // …and the refund ledger it is measured against, so "still owed" clears when a refund
        // completes or an administrator settles a manual one (W-E2). Status + amount only.
        const refundLedgerByOrder = await this.resolveRefundLedgers(shipmentsByOrder);

        return orders.map((order) => {
            const vendorId = order.vendor_id.toString();
            return toCustomerOrderDto({
                shipments: shipmentsByOrder.get(String(order._id)) ?? [],
                deliveryFeeRefundLedger: refundLedgerByOrder.get(String(order._id)) ?? [],
                order,
                storeName: namesByVendor.get(vendorId)?.name ?? null,
                storeSlug: slugsByVendor.get(vendorId) ?? null,
                storeVerified: verifiedVendors.has(vendorId),
                imagesByKey,
                codCollections:
                    order.payment_method === 'cash_on_delivery' || deliveryFeePaymentOf(order) === 'cash_to_rider'
                        ? (codByOrder.get(String(order._id)) ?? [])
                        : undefined,
            });
        });
    }

    /**
     * Order id → its shipments' delivery-money fields, for `deliveryFees` (ADR-A11).
     *
     * ⚠ **A projection of four fields, never the shipment.** A shipment carries the agent, the
     * agency's fee split inputs and the COD state; this view answers "what did I pay to have
     * it delivered", and nothing else from that document belongs in a customer payload.
     */
    private async resolveShipmentFees(orders: IOrder[]): Promise<Map<string, CustomerOrderShipmentFeeFacts[]>> {
        const out = new Map<string, CustomerOrderShipmentFeeFacts[]>();
        const physical = orders.filter((o) => o.order_type === 'physical').map((o) => o._id);
        if (physical.length === 0) return out;

        const rows = await ShipmentModel.find(
            { order_id: { $in: physical } },
            { order_id: 1, status: 1, delivery_payer: 1, customer_delivery_fee: 1, customer_fee_refundable: 1, created_at: 1 },
        )
            .sort({ created_at: 1 })
            .lean()
            .exec();

        for (const row of rows as unknown as Array<CustomerOrderShipmentFeeFacts & { order_id: unknown }>) {
            const key = String(row.order_id);
            const list = out.get(key) ?? [];
            list.push({
                _id: row._id,
                status: row.status ?? null,
                delivery_payer: row.delivery_payer ?? null,
                customer_delivery_fee: row.customer_delivery_fee ?? null,
                customer_fee_refundable: row.customer_fee_refundable ?? null,
            });
            out.set(key, list);
        }
        return out;
    }

    /**
     * Order id → its `delivery_fee_refunds` rows (status + amount), only for orders where some
     * parcel ever owed the customer delivery money — one query, usually skipped entirely.
     */
    private async resolveRefundLedgers(
        shipmentsByOrder: Map<string, CustomerOrderShipmentFeeFacts[]>,
    ): Promise<Map<string, Array<{ status: DeliveryFeeRefundStatus; amount: number }>>> {
        const out = new Map<string, Array<{ status: DeliveryFeeRefundStatus; amount: number }>>();
        const orderIds = [...shipmentsByOrder.entries()]
            .filter(([, list]) => list.some((s) => typeof s.customer_fee_refundable === 'number' && s.customer_fee_refundable > 0))
            .map(([id]) => id);
        if (orderIds.length === 0) return out;
        const rows = await DeliveryFeeRefundModel.find(
            { order_id: { $in: orderIds } },
            { order_id: 1, status: 1, amount: 1 },
        ).lean().exec();
        for (const row of rows as unknown as Array<{ order_id: unknown; status: DeliveryFeeRefundStatus; amount: number }>) {
            const key = String(row.order_id);
            const list = out.get(key) ?? [];
            list.push({ status: row.status, amount: row.amount });
            out.set(key, list);
        }
        return out;
    }

    /**
     * Vendor id → store slug, for linking an order line back to the storefront.
     *
     * A separate pass because `findNamesByVendorIds` projects name + logo only, and widening
     * it would change a method five other callers share for a field only this view wants.
     */
    private async resolveSlugs(orders: IOrder[]): Promise<Map<string, string>> {
        const vendorIds = [...new Set(orders.map((o) => o.vendor_id.toString()))];
        const out = new Map<string, string>();
        await Promise.all(
            vendorIds.map(async (vendorId) => {
                const store = await this.storeRepository.findByVendorIdOrNull(vendorId);
                if (store?.slug) out.set(vendorId, store.slug);
            }),
        );
        return out;
    }
}

export const customerOrderViewService = new CustomerOrderViewService();
