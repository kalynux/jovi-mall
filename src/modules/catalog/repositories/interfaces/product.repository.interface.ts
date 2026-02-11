import { Product } from '../mappers/product.mapper';
import { Page, PaginationOptions, RepositoryOptions } from '../types';

export interface IProductRepository {
  create(product: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<Product>;

  findById(id: string, vendorId: string, options?: RepositoryOptions): Promise<Product | null>;
  findByIdUnscoped(id: string, options?: RepositoryOptions): Promise<Product | null>;
  findBySlug(slug: string, vendorId: string, options?: RepositoryOptions): Promise<Product | null>;
  findByVendor(vendorId: string, pagination: PaginationOptions, options?: RepositoryOptions): Promise<Page<Product>>;
  findByStatus(status: string, vendorId: string, pagination: PaginationOptions, options?: RepositoryOptions): Promise<Page<Product>>;
  existsBySlug(slug: string, vendorId: string, options?: RepositoryOptions): Promise<boolean>;

  update(id: string, vendorId: string, updates: Partial<Product>, options?: RepositoryOptions): Promise<Product | null>;

  softDelete(id: string, vendorId: string, options?: RepositoryOptions, purgeAt?: Date): Promise<void>;
  restore(id: string, vendorId: string, options?: RepositoryOptions): Promise<void>;

  // Advanced querying with search, filters, and sorting
  searchAndFilter(
    vendorId: string,
    filters: {
      type?: string;
      status?: string;
      searchQuery?: string;
    },
    pagination: PaginationOptions,
    sort?: {
      sortBy: 'createdAt' | 'updatedAt' | 'title';
      sortOrder: 'asc' | 'desc';
    },
    options?: RepositoryOptions
  ): Promise<Page<Product>>;

  // Bulk operations
  bulkUpdateStatus(
    productIds: string[],
    vendorId: string,
    status: string,
    options?: RepositoryOptions
  ): Promise<number>; // Returns number of updated products

  bulkArchive(
    productIds: string[],
    vendorId: string,
    options?: RepositoryOptions
  ): Promise<number>; // Returns number of archived products
}
