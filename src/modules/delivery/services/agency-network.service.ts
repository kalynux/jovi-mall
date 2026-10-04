import { VendorRepository } from '../../vendors/vendor.repository';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { PaginationOptions, Page } from '../../../core/repositories/base.repository';
import { categoryCatalogCache } from '../../categories/services/category-catalog.cache';
import { DeliverableProductFilters } from '../../catalog/repositories/interfaces/product.repository.interface';
import { StoreRepository } from '../../store/repositories/store.repository';
import { resolveVendorSummaries } from '../../vendors/read-models/vendor-summary.resolver';
import { buildSearchRegex } from '../../../core/utils/regex.util';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { AgencyProductsQueryInput } from '../validators/agency-products.validator';

/**
 * Read-only "who's connected to me" views for an agency:
 * - vendors who set this agency as their default (requirement #7)
 * - products this agency is set up to deliver, explicit override + inherited
 *   via a vendor default (requirement #8)
 *
 * Neither view lets the agency change anything — vendors/products are owned
 * and configured on the vendor side.
 */
export class AgencyNetworkService {
    private vendorRepo: VendorRepository;
    private productRepo: ProductRepositoryMongo;
    private storeRepo: StoreRepository;
    private storage: IStorageProvider;

    constructor() {
        this.vendorRepo = new VendorRepository();
        this.productRepo = new ProductRepositoryMongo();
        this.storeRepo = new StoreRepository();
        this.storage = getStorageProvider();
    }

    async listVendorsUsingAsDefault(agencyId: string, pagination: PaginationOptions): Promise<Page<any>> {
        const page = await this.vendorRepo.findByDefaultAgency(agencyId, pagination);
        return {
            data: page.data.map(v => ({
                id: v._id.toString(),
                businessName: v.store?.name ?? '',
                displayName: v.display_name ?? null,
                email: v.email ?? null,
                phone: v.phone ?? null,
                status: v.status,
                businessAddress: v.business_addresses?.[0] ? {
                    label: v.business_addresses[0].label,
                    city: v.business_addresses[0].city,
                    state: v.business_addresses[0].state,
                } : null,
            })),
            meta: page.meta,
        };
    }

    /**
     * `search` is a case-insensitive SUBSTRING match (not prefix-only) over the product
     * title, any variant SKU, the vendor's store name or display name, and any category
     * name. The vendor and category arms are resolved to ids first and OR'ed in; the SKU arm
     * is resolved by the repository against this agency's own deliverable products.
     */
    async listDeliverableProducts(agencyId: string, query: AgencyProductsQueryInput): Promise<{
        data: any[];
        meta: { total: number; page: number; limit: number; pages: number; totalPages: number };
    }> {
        const defaultVendorIds = await this.vendorRepo.findVendorIdsByDefaultAgency(agencyId);

        const filters: DeliverableProductFilters = {
            source: query.source,
            status: query.status,
            categoryId: query.categoryId,
            vendorId: query.vendorId,
        };

        if (query.search) {
            const regex = buildSearchRegex(query.search);
            const [byStoreName, byDisplayName, categories] = await Promise.all([
                this.storeRepo.findVendorIdsByNameMatch(regex),
                this.vendorRepo.findIdsByDisplayNameMatch(regex),
                categoryCatalogCache.list(),
            ]);
            filters.search = {
                regex,
                vendorIds: [...new Set([...byStoreName, ...byDisplayName])],
                categoryIds: categories.filter(c => regex.test(c.name)).map(c => c.id),
            };
        }

        const dir = query.sortDir === 'asc' ? 1 : -1;
        // `_id` breaks ties so two products with one title cannot swap pages between requests.
        const sort: Record<string, 1 | -1> = query.sortBy === 'title'
            ? { title: dir, _id: dir }
            : { createdAt: dir, _id: dir };

        const page = await this.productRepo.findByEffectiveDeliveryAgency(
            agencyId,
            defaultVendorIds,
            { page: query.page, limit: query.limit, sort },
            undefined,
            filters,
        );

        const [categoryRefs, vendors] = await Promise.all([
            categoryCatalogCache.refsForMany(page.data.map(p => p.categoryIds)),
            resolveVendorSummaries(page.data.map(p => p.vendorId), this.storage),
        ]);

        return {
            data: page.data.map((p, i) => ({
                id: p.id,
                vendorId: p.vendorId,
                vendor: vendors.get(p.vendorId) ?? {
                    id: p.vendorId, businessName: '', displayName: null, logo: null, verified: false,
                },
                title: p.title,
                status: p.status,
                categories: categoryRefs[i],
                // Deprecated single value — the primary category's name.
                category: categoryRefs[i][0]?.name ?? null,
                source: p.delivery?.agencyId ? 'own_override' : 'vendor_default',
            })),
            // `pages` kept for existing clients; `totalPages` is what every other agency list says.
            meta: { ...page.meta, totalPages: page.meta.pages },
        };
    }
}

export const agencyNetworkService = new AgencyNetworkService();
