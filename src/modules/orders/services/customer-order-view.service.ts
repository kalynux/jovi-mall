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
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { resolveProductImages, ProductImageRef } from '../../catalog/read-models/product-image.resolver';
import { cashCollectionService } from '../../cod/services/cash-collection.service';
import { CustomerOrderDto, toCustomerOrderDto } from '../dto/customer-order.dto';

export class CustomerOrderViewService {
    constructor(
        private readonly storeRepository = new StoreRepository(),
        private readonly fileRepository = new FileRepositoryMongo(),
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
        const codOrders = orders.filter((o) => o.payment_method === 'cash_on_delivery');
        const codByOrder = codOrders.length > 0
            ? await cashCollectionService.getCodBlocksForOrders(codOrders.map((o) => String(o._id)), true)
            : new Map<string, unknown[]>();

        return orders.map((order) => {
            const vendorId = order.vendor_id.toString();
            return toCustomerOrderDto({
                order,
                storeName: namesByVendor.get(vendorId)?.name ?? null,
                storeSlug: slugsByVendor.get(vendorId) ?? null,
                imagesByKey,
                codCollections:
                    order.payment_method === 'cash_on_delivery'
                        ? (codByOrder.get(String(order._id)) ?? [])
                        : undefined,
            });
        });
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
