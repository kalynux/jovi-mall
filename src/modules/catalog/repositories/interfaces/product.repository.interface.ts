import { Product } from '../mappers/product.mapper';
import { Page, PaginationOptions, RepositoryOptions } from '../types';
import { ProductListProjection } from '../../read-models/product-detail.read-model';
import { ProductStatus, ProductSuspensionReason, ProductType } from '../../models/product.model';

export interface IProductRepository {
  create(product: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<Product>;

  findById(id: string, vendorId: string, options?: RepositoryOptions): Promise<Product | null>;
  findByIdUnscoped(id: string, options?: RepositoryOptions): Promise<Product | null>;
  findBySlug(slug: string, vendorId: string, options?: RepositoryOptions): Promise<Product | null>;
  findByVendor(vendorId: string, pagination: PaginationOptions, options?: RepositoryOptions): Promise<Page<Product>>;
  findByStatus(status: string, vendorId: string, pagination: PaginationOptions, options?: RepositoryOptions): Promise<Page<Product>>;
  existsBySlug(slug: string, vendorId: string, options?: RepositoryOptions): Promise<boolean>;

  /**
   * How many catalog slots the vendor occupies, for plan-limit enforcement — every
   * non-archived, non-deleted product EXCEPT those the plan-quota sweep has suspended.
   * That exclusion is what lets the sweep converge; see the implementation.
   */
  countActiveByVendor(vendorId: string, options?: RepositoryOptions): Promise<number>;

  /**
   * Every slot-occupying product, oldest first — the order the plan-quota sweep
   * suspends and restores along. Includes quota-suspended rows (the sweep must see the
   * whole candidate set); it is the count above that excludes them.
   */
  listQuotaSlotsOldestFirst(vendorId: string, options?: RepositoryOptions): Promise<
    Array<{ id: string; status: ProductStatus; createdAt: Date; suspensionReason: ProductSuspensionReason | null }>
  >;

  /**
   * Suspend the named products for `plan_quota_exceeded`, whatever their current
   * (non-archived) status — drafts included, because a draft occupies a slot. Returns
   * the ids actually moved.
   */
  suspendProductsForQuota(vendorId: string, productIds: string[], options?: RepositoryOptions): Promise<string[]>;

  /**
   * Lift a `plan_quota_exceeded` suspension back to `targetStatus`. Pinned to that
   * reason, so an upgrade can never republish a listing an administrator or an agency
   * took down.
   */
  restoreProductFromQuota(
    productId: string,
    vendorId: string,
    targetStatus: Exclude<ProductStatus, 'suspended'>,
    options?: RepositoryOptions,
  ): Promise<boolean>;

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
   * Suspend all of a vendor's currently-ACTIVE products, of EVERY type.
   *
   * The sibling of `suspendVendorPhysicalProducts`, and the type filter is the whole
   * difference. That one exists to answer a broken delivery agency, which can only
   * affect something that ships; this one answers the vendor themselves being
   * suspended, where a digital download and a bookable service must stop selling
   * exactly as a parcel does.
   *
   * Same two exclusions as the physical sweep, for the same reasons: only `active`
   * products are touched, and a product mid-vectorisation is skipped because
   * `VectorisationService` writes `status: 'active'` on completion and would silently
   * undo the suspension.
   *
   * Returns the affected product ids.
   */
  suspendAllVendorProducts(
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
  ): Promise<string[]>;

  /**
   * Suspend a single product (no-op unless currently 'active'), capturing its current
   * status so it can be restored later. Returns whether it was suspended.
   *
   * `actor` is set only by the agency's manual storage suspension: the agency id is
   * what authorises the way back out (only the agency that suspended may unsuspend)
   * and the note is what the vendor is shown. The three delivery-agency cascades
   * have no actor and pass nothing.
   *
   * `types` defaults to `['physical']`, which is every pre-existing caller's meaning.
   * An administrator's `platform_oversight` takedown widens it: a listing can be
   * removed on its merits whatever it ships as. There is no admin actor id here —
   * the record of WHO is the wi-admin audit row, and the vendor-facing explanation
   * rides `note`; only the reason is needed to authorise the way back out.
   */
  suspendProduct(
    productId: string,
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
    actor?: { agencyId?: string; note?: string | null },
    types?: ProductType[],
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
    types?: ProductType[],
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

  /**
   * Every active variant a given agency is configured to WAREHOUSE — the source
   * the agency-inventory roster is derived from.
   *
   * A product qualifies when it is physical, its pickup location is
   * `agency_storage`, and the agency that would actually fulfil it is this one:
   * the product's own `delivery.agency_id` override if set, else the vendor's
   * `default_delivery_agency_id`. That is the same resolution order used at
   * activation and at order creation.
   *
   * Status must be `active` **or** `suspended` with reason
   * `agency_storage_suspended`. That second case is load-bearing: the agency's own
   * suspension must not delete the rows it acts on, or suspending a product would
   * make it vanish from the very screen the unsuspend button lives on. Every other
   * suspension reason means the product genuinely stopped being warehoused here,
   * and its rows are swept as usual.
   *
   * `agencyAddressId` is the depot the product names, passed through RAW —
   * null when none was named, and possibly pointing at a depot the agency has
   * since deleted. Resolving it is the caller's job (see
   * `resolveStockLocationId`), because inventory and routing resolve a dangling
   * id differently and this repository must not pick one.
   */
  findAgencyStoredVariants(
    agencyId: string,
    options?: RepositoryOptions,
  ): Promise<AgencyStoredVariant[]>;
}

/** One (vendor, product, variant) the agency stores, plus the depot the product names. */
export interface AgencyStoredVariant {
  vendorId: string;
  productId: string;
  variantId: string;
  /** Raw, unresolved. Null = the product named no depot. */
  agencyAddressId: string | null;
}
