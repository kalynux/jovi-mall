import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IFileRepository } from '../../repositories/interfaces/file.repository.interface';
import { IStorageProvider } from '../../../../core/storage/storage-provider.interface';
import { Page } from '../../repositories/types';
import { FileDetail, ProductListItem } from '../../read-models/product-detail.read-model';
import { toFileDetail } from '../../read-models/file-detail.resolver';

export interface ProductListFilters {
    type?: 'physical' | 'digital' | 'service';
    status?: string;
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

        const data: ProductListItem[] = projection.data.map(p => ({
            id: p.id,
            title: p.title,
            type: p.type,
            status: p.status,
            mode: p.mode,
            category: p.category,
            fileIds: p.fileIds
                .map(id => fileDetailById.get(id))
                .filter((f): f is FileDetail => Boolean(f)),
            hasVariants: p.hasVariants,
            vectorisationEnabled: p.vectorisationEnabled,
            vectorisationStatus: p.vectorisationStatus,
        }));

        return { data, meta: projection.meta };
    }
}
