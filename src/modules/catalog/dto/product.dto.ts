import type { RichDoc } from '../../../core/richtext';
import { ProductType, ProductStatus, DigitalConfig } from '../models/product.model';

/**
 * DTO for creating a new product
 */
export interface CreateProductDto {
    type: ProductType;
    title: string;
    description?: string;
    /** The structured description `description` is the plain-text projection of. */
    descriptionRich?: RichDoc | null;
    images?: string[];

    // SEO
    seoTitle?: string;
    seoDescription?: string;

    // Type-specific configs (service config + price live on the service variant)
    digitalConfig?: Partial<DigitalConfig>;
}

/**
 * DTO for updating an existing product
 * Images field replaces the entire array (deterministic)
 */
export interface UpdateProductDto {
    title?: string;
    description?: string;
    /** Absent leaves the stored document alone; `null` clears it. */
    descriptionRich?: RichDoc | null;
    images?: string[]; // Full replacement, not partial

    // SEO
    seoTitle?: string;
    seoDescription?: string;

    // Type-specific configs (service config + price live on the service variant)
    digitalConfig?: Partial<DigitalConfig>;
}

/**
 * DTO for changing product status
 */
export interface ChangeProductStatusDto {
    status: ProductStatus;
}

/**
 * Sort options for product listing
 */
export type ProductSortBy = 'createdAt' | 'updatedAt' | 'title';
export type SortOrder = 'asc' | 'desc';

/**
 * DTO for querying/filtering products
 */
export interface ProductQueryDto {
    type?: ProductType;
    status?: ProductStatus;
    q?: string; // Search query for title/description

    // Sorting
    sortBy?: ProductSortBy;
    sortOrder?: SortOrder;

    // Pagination
    page?: number;
    limit?: number;
}

/**
 * DTO for bulk archiving products
 */
export interface BulkArchiveDto {
    productIds: string[];
}

/**
 * DTO for bulk status change
 */
export interface BulkStatusChangeDto {
    productIds: string[];
    status: ProductStatus;
}

/**
 * Response for bulk operations
 */
export interface BulkOperationResponse {
    success: number;
    failed: number;
    total: number;
    errors?: Array<{
        productId: string;
        reason: string;
    }>;
}
