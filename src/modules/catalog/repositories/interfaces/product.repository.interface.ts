import { Product } from '../mappers/product.mapper';
import { Page, PaginationOptions, RepositoryOptions } from '../types';
import { ProductListProjection } from '../../read-models/product-detail.read-model';
import { ProductSuspensionReason } from '../../models/product.model';

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

  /**
   * List-view projection: returns only the fields required by the vendor
   * products grid/list UI. Uses MongoDB projection + lean for minimal
   * payload and bypasses the full domain mapper.
   * The thumbnailFileId is the first entry in fileIds (or null).
   */
  searchListView(
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
  ): Promise<Page<ProductListProjection>>;

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

  /**
   * Suspend all of a vendor's physical products (any status except already-'suspended'),
   * capturing each product's own current status so it can be restored later.
   * Returns the affected product ids.
   */
  suspendVendorPhysicalProducts(
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
  ): Promise<string[]>;

  /**
   * Suspend a single physical product (no-op if already suspended), capturing its
   * current status so it can be restored later. Returns whether it was suspended.
   */
  suspendProduct(
    productId: string,
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
  ): Promise<boolean>;

  /**
   * Find a vendor's physical products currently suspended for any of the given
   * reasons. Pass every reason that could plausibly be resolved by the same fix
   * (e.g. both delivery-agency reasons together) — a product suspended under
   * reason A can only ever be found again by a reason-A-only query, so if reason
   * B's fix is what actually clears it, an A-only sweep would never see it.
   * Restoration is validated (not blind) by the caller — see
   * ProductDeliveryAgencySuspensionService — since a product can be independently
   * still-blocked by whichever reason ISN'T the one that just got fixed.
   */
  findSuspendedByVendorAndReasons(
    vendorId: string,
    reasons: ProductSuspensionReason[],
    options?: RepositoryOptions,
  ): Promise<Product[]>;

  /**
   * Find physical products, across ANY vendor, whose OWN delivery.agencyId override
   * points at the given agency. Used by the agency deactivate/reactivate cascade to
   * find products affected independently of any vendor's default agency.
   */
  findPhysicalByOwnDeliveryAgency(
    agencyId: string,
    options?: RepositoryOptions,
  ): Promise<Product[]>;

  /**
   * An agency's "products I'm set up to deliver" view — combined: explicit
   * per-product override to this agency OR inherited via a vendor's default
   * agency (when that product has no override of its own).
   */
  findByEffectiveDeliveryAgency(
    agencyId: string,
    vendorIdsUsingAsDefault: string[],
    pagination: PaginationOptions,
    options?: RepositoryOptions,
  ): Promise<Page<Product>>;
}
