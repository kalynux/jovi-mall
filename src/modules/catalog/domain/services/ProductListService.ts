import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IFileRepository } from '../../repositories/interfaces/file.repository.interface';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { IStorageProvider } from '../../../../core/storage/storage-provider.interface';
import { Page } from '../../repositories/types';
import { FileDetail, ProductListItem, ServiceListSummary } from '../../read-models/product-detail.read-model';
import { toFileDetail } from '../../read-models/file-detail.resolver';
import { categoryCatalogCache } from '../../../categories/services/category-catalog.cache';

export interface ProductListFilters {
    type?: 'physical' | 'digital' | 'service';
    status?: string;
    /** Statuses to leave out — filtered in the query, so totals and page sizes reflect it. */
    excludeStatuses?: string[];
    searchQuery?: string;
}

export interface ProductListSort {
    sortBy: 'createdAt' | 'updatedAt' | 'title';
    sortOrder: 'asc' | 'desc';
}

export interface ProductListPagination {
    page: number;
    limit: number;
}

/**
 * ProductListService
 *
 * Handles product listing with advanced filtering, search, and sorting.
 * Enforces vendor ownership and returns a lean payload tailored to the
 * vendor products grid/list UI — only the fields the UI consumes plus a
 * resolved thumbnail URL.
 */
export class ProductListService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly fileRepository: IFileRepository,
        private readonly storage: IStorageProvider,
        private readonly variantRepository: IVariantRepository,
    ) { }

    /**
     * List products with filters, search, and sorting.
     *
     * Performs a projected MongoDB query (only fields used by the UI),
     * then batch-resolves the first product image to a public URL in a
     * single File query.
     */
    async execute(
        vendorId: string,
        filters: ProductListFilters,
        pagination: ProductListPagination,
        sort?: ProductListSort
    ): Promise<Page<ProductListItem>> {
        const projection = await this.productRepository.searchListView(
            vendorId,
            {
                type: filters.type,
                status: filters.status,
                excludeStatuses: filters.excludeStatuses,
                searchQuery: filters.searchQuery,
            },
            {
                page: pagination.page,
                limit: pagination.limit,
            },
            sort
        );

        const allFileIds = Array.from(
            new Set(projection.data.flatMap(p => p.fileIds))
        );

        const fileDetailById = new Map<string, FileDetail>();
        if (allFileIds.length > 0) {
            const files = await this.fileRepository.findManyByIds(allFileIds);
            // Through `toFileDetail`, not hand-built. This was one of THREE sites that
            // assembled the shape themselves, which is how a rule living at the "single choke
            // point" reached only some of the platform's files. The `access`/`url` split in
            // ADR-A01 D-2 is decided in exactly one place now.
            for (const file of files) {
                fileDetailById.set(file.id, toFileDetail(file, this.storage));
            }
        }

        const categoryRefs = await categoryCatalogCache.refsForMany(projection.data.map(p => p.categoryIds));

        // A service's price, length and booking mode live on its single default
        // variant, which this lean projection doesn't carry — without them the
        // services list can show nothing but the title. One batched read per page.
        const serviceVariantIds = projection.data
            .filter(p => p.type === 'service' && p.defaultVariantId)
            .map(p => p.defaultVariantId as string);
        const serviceSummaryByVariantId = new Map<string, ServiceListSummary>();
        if (serviceVariantIds.length > 0) {
            const variants = await this.variantRepository.findManyByIds(serviceVariantIds);
            for (const v of variants) {
                const config = v.serviceConfig;
                serviceSummaryByVariantId.set(v.id, {
                    price: v.price,
                    // Every booking is priced in XAF (BookingPriceResolver).
                    currency: 'XAF',
                    durationMinutes: config?.durationMinutes ?? null,
                    bookingMode: config?.bookingMode ?? null,
                    maxBookings: config?.bookingMode === 'capacity' ? config.maxBookings ?? null : null,
                });
            }
        }

        const data: ProductListItem[] = projection.data.map((p, i) => ({
            id: p.id,
            title: p.title,
            type: p.type,
            status: p.status,
            mode: p.mode,
            categories: categoryRefs[i],
            category: categoryRefs[i][0]?.name ?? null,
            fileIds: p.fileIds
                .map(id => fileDetailById.get(id))
                .filter((f): f is FileDetail => Boolean(f)),
            hasVariants: p.hasVariants,
            vectorisationEnabled: p.vectorisationEnabled,
            vectorisationStatus: p.vectorisationStatus,
            ...(p.type === 'service'
                ? { service: (p.defaultVariantId && serviceSummaryByVariantId.get(p.defaultVariantId)) || null }
                : {}),
        }));

        return { data, meta: projection.meta };
    }
}
