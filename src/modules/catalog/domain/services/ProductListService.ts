import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { Page } from '../../repositories/types';

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
 * Enforces vendor ownership for all queries.
 */
export class ProductListService {
    constructor(private readonly productRepository: IProductRepository) { }

    /**
     * List products with filters, search, and sorting
     * 
     * @param vendorId - Vendor ID (ownership enforcement)
     * @param filters - Type, status, and search query filters
     * @param pagination - Page and limit
     * @param sort - Sort by field and order
     * @returns Paginated product list
     */
    async execute(
        vendorId: string,
        filters: ProductListFilters,
        pagination: ProductListPagination,
        sort?: ProductListSort
    ): Promise<Page<Product>> {
        return this.productRepository.searchAndFilter(
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
    }
}
