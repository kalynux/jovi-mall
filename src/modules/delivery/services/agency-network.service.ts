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
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { isRenderableImage } from '../../catalog/read-models/product-image.resolver';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { Product } from '../../catalog/repositories/mappers/product.mapper';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { IAgencyHeadquartersAddress } from '../../magazin/models/magazin.model';
import { resolveHqAddress } from '../../magazin/domain/hq-address.resolver';
import { IVendor } from '../../vendors/vendor.model';
import { fromHqAddress, fromVendorBusinessAddress } from '../../../core/read-models/address-detail.resolver';
import { AgencyStockLevelRepository } from '../../inventory/repositories/agency-stock-level.repository';

/** How many images a row carries. A list renders a stack of three and a "+N" chip. */
const LIST_IMAGE_CAP = 4;

/** Where a deliverable product is picked up, labelled for a list row. */
export interface DeliverableProductPickup {
    source: 'vendor_address' | 'agency_storage';
    label: string | null;
    city: string | null;
    state: string | null;
    /** The depot id for `agency_storage` (the resolved one — null names the primary); null for a vendor address. */
    depotId: string | null;
}

/** One depot holding this product, summed across its variants. */
export interface DeliverableProductStockDepot {
    /** Null when the row's depot has since been deleted — "unassigned". */
    id: string | null;
    label: string | null;
    city: string | null;
    /** Sum of COUNTED on-hand across the product's variants at this depot. 0 when `counted` is false. */
    quantityOnHand: number;
    /**
     * False when every row here is `derived` — configured to be stored here, never counted.
     * That is NOT "we hold none"; render it differently from a counted zero.
     */
    counted: boolean;
}

export interface DeliverableProductStock {
    depots: DeliverableProductStockDepot[];
    /** Sum of counted on-hand across all depots. */
    totalOnHand: number;
    /** True when at least one depot carries a counted figure. */
    counted: boolean;
}

function productImages(
    fileIds: string[],
    fileById: Map<string, FileDetail>,
): { images: FileDetail[]; imageCount: number } {
    const all = fileIds.map(id => fileById.get(id)).filter(isRenderableImage);
    return { images: all.slice(0, LIST_IMAGE_CAP), imageCount: all.length };
}

/**
 * Label a product's pickup location from batch-loaded addresses.
 *
 * `vendor_address` with a dangling or missing id falls back to the vendor's address only when
 * they have exactly ONE — the same rule `derivePickupLocation` applies: with several there is
 * no primary flag, so guessing would name the wrong building. Unresolved → label/city null.
 * `agency_storage` uses `resolveHqAddress`, the one place the primary-depot fallback lives.
 */
function resolvePickup(
    p: Product,
    depots: IAgencyHeadquartersAddress[],
    vendorAddresses: Map<string, IVendor['business_addresses']>,
): DeliverableProductPickup | null {
    const pickup = p.delivery?.pickupLocation;
    if (!pickup) return null;

    if (pickup.source === 'vendor_address') {
        const addresses = vendorAddresses.get(p.vendorId) ?? [];
        const match = (pickup.vendorAddressId
            ? addresses.find(a => a._id?.toString() === pickup.vendorAddressId)
            : undefined) ?? (addresses.length === 1 ? addresses[0] : undefined);
        const detail = fromVendorBusinessAddress(match);
        return {
            source: 'vendor_address',
            label: detail?.label ?? null,
            city: detail?.city ?? null,
            state: detail?.state ?? null,
            depotId: null,
        };
    }

    const depot = resolveHqAddress(depots, pickup.agencyAddressId);
    const detail = fromHqAddress(depot);
    return {
        source: 'agency_storage',
        label: detail?.label ?? null,
        city: detail?.city ?? null,
        state: detail?.state ?? null,
        depotId: depot?._id?.toString() ?? null,
    };
}

/** Roll a page of stock rows (one per variant per depot) up to product → depot. */
function groupAgencyStock(
    facts: Array<{ productId: string; locationId: string | null; source: 'derived' | 'counted'; quantityOnHand: number }>,
    depotsById: Map<string, IAgencyHeadquartersAddress>,
): Map<string, DeliverableProductStock> {
    const byProduct = new Map<string, Map<string, DeliverableProductStockDepot>>();

    for (const f of facts) {
        let perDepot = byProduct.get(f.productId);
        if (!perDepot) {
            perDepot = new Map();
            byProduct.set(f.productId, perDepot);
        }
        const key = f.locationId ?? '';
        let entry = perDepot.get(key);
        if (!entry) {
            const depot = f.locationId ? depotsById.get(f.locationId) : undefined;
            const detail = fromHqAddress(depot);
            entry = {
                // A row naming a depot that no longer exists is unassigned, same as the inventory list.
                id: depot ? f.locationId : null,
                label: detail?.label ?? null,
                city: detail?.city ?? null,
                quantityOnHand: 0,
                counted: false,
            };
            perDepot.set(key, entry);
        }
        if (f.source === 'counted') {
            entry.counted = true;
            entry.quantityOnHand += f.quantityOnHand;
        }
    }

    // Depots in the agency's own order (primary first), unassigned last.
    const order = new Map([...depotsById.keys()].map((id, i) => [id, i]));
    const result = new Map<string, DeliverableProductStock>();
    for (const [productId, perDepot] of byProduct) {
        const depots = [...perDepot.values()].sort(
            (a, b) => (a.id ? order.get(a.id) ?? 0 : Number.MAX_SAFE_INTEGER)
                - (b.id ? order.get(b.id) ?? 0 : Number.MAX_SAFE_INTEGER),
        );
        result.set(productId, {
            depots,
            totalOnHand: depots.reduce((sum, d) => sum + d.quantityOnHand, 0),
            counted: depots.some(d => d.counted),
        });
    }
    return result;
}

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
    private fileRepo: FileRepositoryMongo;
    private magazinRepo: MagazinRepository;
    private stockLevelRepo: AgencyStockLevelRepository;

    constructor() {
        this.vendorRepo = new VendorRepository();
        this.productRepo = new ProductRepositoryMongo();
        this.storeRepo = new StoreRepository();
        this.storage = getStorageProvider();
        this.fileRepo = new FileRepositoryMongo();
        this.magazinRepo = new MagazinRepository();
        this.stockLevelRepo = new AgencyStockLevelRepository();
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

        const productIds = page.data.map(p => p.id);
        // Only vendors whose product picks up from a vendor address need their addresses.
        const pickupVendorIds = page.data
            .filter(p => p.delivery?.pickupLocation?.source === 'vendor_address')
            .map(p => p.vendorId);

        // A fixed number of queries per page, whatever its size.
        const [categoryRefs, vendors, fileById, depotLists, vendorAddresses, stockFacts] = await Promise.all([
            categoryCatalogCache.refsForMany(page.data.map(p => p.categoryIds)),
            resolveVendorSummaries(page.data.map(p => p.vendorId), this.storage),
            resolveFileDetails(page.data.flatMap(p => p.fileIds), this.fileRepo, this.storage),
            this.magazinRepo.findHqAddressListsByAgencyIds([agencyId]),
            this.vendorRepo.findBusinessAddressesByIds(pickupVendorIds),
            this.stockLevelRepo.findStockFactsForAgencyProducts(agencyId, productIds),
        ]);

        // Every product on this list is delivered by THIS agency (own override, or the vendor
        // default with no override), so an `agency_storage` pickup always means one of our depots.
        const depots = depotLists.get(agencyId) ?? [];
        const depotsById = new Map(depots.map(d => [d._id.toString(), d]));
        const stockByProduct = groupAgencyStock(stockFacts, depotsById);

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
                // Product-level gallery, in the vendor's order, renderable images only.
                ...productImages(p.fileIds, fileById),
                pickup: resolvePickup(p, depots, vendorAddresses),
                agencyStock: stockByProduct.get(p.id) ?? null,
            })),
            // `pages` kept for existing clients; `totalPages` is what every other agency list says.
            meta: { ...page.meta, totalPages: page.meta.pages },
        };
    }
}

export const agencyNetworkService = new AgencyNetworkService();
