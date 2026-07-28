import { Product } from '../mappers/product.mapper';
import { Page, PaginationOptions, RepositoryOptions } from '../types';
import { ProductListProjection } from '../../read-models/product-detail.read-model';
import { ProductStatus, ProductSuspensionReason } from '../../models/product.model';

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
  /**
   * `allowedFromStatuses`, when given, restricts the update to products currently
   * in one of those statuses (transition policy, e.g. vendors can't touch
   * 'suspended'); products outside it are skipped, not errored. A status write
   * leaving 'suspended' clears the suspension snapshot.
   */
  bulkUpdateStatus(
    productIds: string[],
    vendorId: string,
    status: string,
    allowedFromStatuses?: ProductStatus[],
    options?: RepositoryOptions
  ): Promise<number>; // Returns number of updated products

  /** Only 'draft'/'active' products are archived — same rule as ProductArchiveService. */
  bulkArchive(
    productIds: string[],
    vendorId: string,
    options?: RepositoryOptions
  ): Promise<number>; // Returns number of archived products

  /**
   * Suspend all of a vendor's currently-ACTIVE physical products, capturing each
   * product's own current status so it can be restored later. Non-active products
   * (draft/archived/pending_review) are left alone — they can't reach 'active'
   * without the activation gate anyway, and suspending them would only block editing.
   * Returns the affected product ids.
   */
  suspendVendorPhysicalProducts(
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
  ): Promise<string[]>;

  /**
   * Suspend a single physical product (no-op unless currently 'active'), capturing
   * its current status so it can be restored later. Returns whether it was suspended.
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
   * Find a SINGLE vendor's physical products whose OWN delivery.agencyId override
   * points at the given agency. Unlike findPhysicalByOwnDeliveryAgency (agency-wide,
   * across every vendor — correct for the admin deactivate/reactivate cascade), this
   * is scoped to one vendor — used by the agency-connections pause/reapprove cascade,
   * which must never touch a vendor's products tied to a *different*, unaffected agency.
   */
  findPhysicalByVendorAndOwnDeliveryAgency(
    vendorId: string,
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

  /**
   * For each given business-address id, count how many of this vendor's
   * (non-deleted) physical products currently have it set as their
   * `delivery.pickupLocation` (source `vendor_address`). Used to block
   * removing a business address that's still in use — see
   * VendorProfileService.assertRemovedAddressesNotInUse. Ids with no matching
   * products are simply absent from the returned map (treat as 0).
   */
  countPhysicalByVendorAndPickupAddresses(
    vendorId: string,
    addressIds: string[],
    options?: RepositoryOptions,
  ): Promise<Record<string, number>>;
}
