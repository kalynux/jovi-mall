import { FilterQuery, Types } from 'mongoose';
import { BaseRepository, Page, PaginationOptions, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IProduct, ProductModel } from '../../models';
import { IProductRepository, AgencyStoredVariant } from '../interfaces/product.repository.interface';
import { COLLECTIONS } from '../../../../core/database/collections';
import { Product, ProductMapper } from '../mappers/product.mapper';
import { ProductListProjection } from '../../read-models/product-detail.read-model';
import { ProductStatus, ProductSuspensionReason, ProductType } from '../../models/product.model';

export class ProductRepositoryMongo extends BaseRepository<IProduct, Product> implements IProductRepository {
  constructor() {
    super(ProductModel, new ProductMapper());
  }

  async create(product: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<Product> {
    // Override create to handle the Omit type if necessary, or just cast.
    // BaseRepository.create expects DomainT. 
    // We can just pass the partial object if the mapper handles it or constructs persistence correctly.
    // simpler:
    const persistence = {
      ...product,
      // defaults
    } as any;

    const [doc] = await this.model.create([persistence], options?.session ? { session: options.session } : {});
    return this.mapper.toDomain(doc);
  }

  // @ts-expect-error - Intentionally overriding with vendor-scoped version
  async findById(id: string, vendorId: string, options?: RepositoryOptions): Promise<Product | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    // Use protected findOne from base, not protected findById
    return this.findOne({ _id: id, vendorId: vendorId as any }, options);
  }

  async findByIdUnscoped(id: string, options?: RepositoryOptions): Promise<Product | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.findOne({ _id: id }, options);
  }

  async findBySlug(slug: string, vendorId: string, options?: RepositoryOptions): Promise<Product | null> {
    return this.findOne({ slug, vendorId: vendorId as any }, options);
  }

  async findByVendor(vendorId: string, pagination: PaginationOptions, options?: RepositoryOptions): Promise<Page<Product>> {
    return this.paginate({ vendorId: vendorId as any }, pagination, options);
  }

  async findByStatus(status: string, vendorId: string, pagination: PaginationOptions, options?: RepositoryOptions): Promise<Page<Product>> {
    return this.paginate({ status, vendorId: vendorId as any }, pagination, options);
  }

  async existsBySlug(slug: string, vendorId: string, options?: RepositoryOptions): Promise<boolean> {
    const doc = await this.model.exists({ slug, vendorId, deletedAt: null });
    return !!doc;
  }

  /**
   * Count a vendor's active products for plan-limit enforcement. "Active" here
   * means any non-archived, non-deleted product (it occupies a catalog slot).
   */
  async countActiveByVendor(vendorId: string): Promise<number> {
    return this.model.countDocuments({
      vendorId,
      deletedAt: null,
      status: { $ne: 'archived' },
    });
  }

  async update(id: string, vendorId: string, updates: Partial<Product>, options?: RepositoryOptions): Promise<Product | null> {
    if (!Types.ObjectId.isValid(id)) return null;

    // Invariant: `suspension` only carries meaning while status === 'suspended'
    // (see product.model.ts). Any status write that leaves 'suspended' — vendor
    // manual reactivation via PATCH /:id/status, bulk activate, system restore —
    // must drop the snapshot, or a stale one lingers on an active/draft product.
    const set: Partial<Product> = { ...updates };
    if (updates.status && updates.status !== 'suspended' && updates.suspension === undefined) {
      set.suspension = null;
    }

    const query = this.model.findOneAndUpdate(
      { _id: id, vendorId, deletedAt: null },
      { $set: set },
      { new: true, session: options?.session }
    );

    const doc = await query.exec();
    return doc ? this.mapper.toDomain(doc) : null;
  }

  // @ts-expect-error - Intentionally overriding with vendor-scoped version  
  async softDelete(id: string, vendorId: string, options?: RepositoryOptions, purgeAt?: Date): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;

    // Override base softDelete to enforce vendor scope and set purgeAt
    await this.model.updateOne(
      { _id: id, vendorId, deletedAt: null },
      {
        deletedAt: new Date(),
        ...(purgeAt && { purgeAt })
      },
      options?.session ? { session: options.session } : {}
    ).exec();
  }

  // @ts-expect-error - Intentionally overriding with vendor-scoped version
  async restore(id: string, vendorId: string, options?: RepositoryOptions): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;

    // Override base restore to enforce vendor scope and clear purgeAt
    await this.model.updateOne(
      { _id: id, vendorId, deletedAt: { $ne: null } },
      {
        deletedAt: null,
        purgeAt: null
      },
      options?.session ? { session: options.session } : {}
    ).exec();
  }

  /**
   * Advanced search and filter with sorting support
   */
  async searchAndFilter(
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
  ): Promise<Page<Product>> {
    const query: FilterQuery<IProduct> = {
      vendorId: vendorId as any,
      deletedAt: null,
    };

    // Type filter
    if (filters.type) {
      query.type = filters.type as any;
    }

    // Status filter
    if (filters.status) {
      query.status = filters.status as any;
    }

    // Text search on title and description
    if (filters.searchQuery) {
      query.$or = [
        { title: { $regex: filters.searchQuery, $options: 'i' } },
        { description: { $regex: filters.searchQuery, $options: 'i' } },
      ];
    }

    // Build sort object
    const sortObj: any = {};
    if (sort) {
      sortObj[sort.sortBy] = sort.sortOrder === 'asc' ? 1 : -1;
    } else {
      // Default sort: newest first
      sortObj.createdAt = -1;
    }

    // Pass sort via pagination options
    const paginationWithSort: PaginationOptions = {
      ...pagination,
      sort: sortObj,
    };

    return this.paginate(query, paginationWithSort, options);
  }

  /**
   * List-view projection for the vendor products grid/list UI.
   * Projects only the fields the UI needs and runs lean — no domain mapping.
   */
  async searchListView(
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
  ): Promise<Page<ProductListProjection>> {
    const query: FilterQuery<IProduct> = {
      vendorId: vendorId as any,
      deletedAt: null,
    };

    if (filters.type) query.type = filters.type as any;
    if (filters.status) query.status = filters.status as any;
    if (filters.searchQuery) {
      query.$or = [
        { title: { $regex: filters.searchQuery, $options: 'i' } },
        { description: { $regex: filters.searchQuery, $options: 'i' } },
      ];
    }

    const sortObj: Record<string, 1 | -1> = sort
      ? { [sort.sortBy]: sort.sortOrder === 'asc' ? 1 : -1 }
      : { createdAt: -1 };

    const { page, limit } = pagination;
    const skip = (page - 1) * limit;

    const countQuery = this.model.countDocuments(query);
    const findQuery = this.model
      .find(query)
      .select('_id title type status mode category hasVariants vectorisationEnabled vectorisationStatus fileIds')
      .sort(sortObj)
      .skip(skip)
      .limit(limit)
      .lean();

    if (options?.session) {
      countQuery.session(options.session);
      findQuery.session(options.session);
    }

    const [total, docs] = await Promise.all([countQuery.exec(), findQuery.exec()]);

    const data: ProductListProjection[] = (docs as any[]).map((doc) => ({
      id: doc._id.toString(),
      title: doc.title,
      type: doc.type,
      status: doc.status,
      // Same legacy coercion as ProductMapper.toDomain — this projection is lean
      // and bypasses the mapper entirely.
      mode: doc.mode ?? 'advanced',
      category: doc.category,
      hasVariants: doc.hasVariants ?? false,
      vectorisationEnabled: doc.vectorisationEnabled ?? false,
      vectorisationStatus: doc.vectorisationStatus ?? 'not_started',
      fileIds: Array.isArray(doc.fileIds)
        ? doc.fileIds.map((id: any) => id.toString())
        : [],
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Bulk update product status
   * Returns number of updated products
   */
  async bulkUpdateStatus(
    productIds: string[],
    vendorId: string,
    status: string,
    allowedFromStatuses?: ProductStatus[],
    options?: RepositoryOptions
  ): Promise<number> {
    const validIds = productIds.filter(id => Types.ObjectId.isValid(id));

    if (validIds.length === 0) return 0;

    const result = await this.model.updateMany(
      {
        _id: { $in: validIds.map(id => new Types.ObjectId(id)) },
        vendorId: vendorId as any,
        deletedAt: null,
        // Caller-supplied transition constraint (e.g. vendors can't move a
        // 'suspended' product — that status is a system lock). Ineligible
        // products are skipped, not errored.
        ...(allowedFromStatuses && { status: { $in: allowedFromStatuses } }),
      },
      {
        // Same invariant as update(): leaving 'suspended' drops the suspension snapshot.
        $set: { status, updatedAt: new Date(), ...(status !== 'suspended' && { suspension: null }) },
      },
      options?.session ? { session: options.session } : {}
    ).exec();

    return result.modifiedCount;
  }

  /**
   * Bulk archive products (set status to 'archived')
   * Returns number of archived products
   */
  async bulkArchive(
    productIds: string[],
    vendorId: string,
    options?: RepositoryOptions
  ): Promise<number> {
    const validIds = productIds.filter(id => Types.ObjectId.isValid(id));

    if (validIds.length === 0) return 0;

    const result = await this.model.updateMany(
      {
        _id: { $in: validIds.map(id => new Types.ObjectId(id)) },
        vendorId: vendorId as any,
        deletedAt: null,
        // Mirror of ProductArchiveService's single-product rule: only draft and
        // active products are archivable — 'suspended' is a system lock a vendor
        // can't route around via bulk, and re-archiving archived is pointless.
        status: { $in: ['draft', 'active'] },
      },
      {
        $set: { status: 'archived', updatedAt: new Date() },
      },
      options?.session ? { session: options.session } : {}
    ).exec();

    return result.modifiedCount;
  }

  /**
   * Suspend all of a vendor's currently-ACTIVE physical products, capturing each
   * product's own current status via an aggregation-pipeline update so it can be
   * restored to that exact status later.
   *
   * Only 'active' products are suspended: a draft/archived/pending_review product
   * can never reach 'active' without passing the activation gate
   * (ProductStatusValidationService requires an active default agency + active
   * connection), so suspending it adds nothing — and would needlessly lock the
   * vendor out of editing it while the agency problem lasts.
   */
  async suspendVendorPhysicalProducts(
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
  ): Promise<string[]> {
    const sessionOpt = options?.session ? { session: options.session } : {};
    const filter: FilterQuery<IProduct> = {
      vendorId: vendorId as any,
      type: 'physical',
      status: 'active',
      deletedAt: null,
      vectorisationStatus: { $ne: 'pending' },
    };

    const docs = await this.model.find(filter, { _id: 1 }, sessionOpt).lean();
    if (docs.length === 0) return [];

    const ids = docs.map(d => d._id);
    await this.model.updateMany(
      { _id: { $in: ids } },
      [
        {
          $set: {
            suspension: { reason, previousStatus: '$status', suspendedAt: '$$NOW' },
            status: 'suspended',
            updatedAt: '$$NOW',
          },
        },
      ] as any,
      sessionOpt,
    ).exec();

    return ids.map(id => id.toString());
  }

  /**
   * Suspend all of a vendor's currently-ACTIVE products, of EVERY type.
   *
   * The type filter is the only difference from `suspendVendorPhysicalProducts`, and
   * it is the point: that sweep answers a broken delivery agency, which can only
   * affect something that ships, while this one answers the vendor being suspended —
   * where a digital download and a bookable service must stop selling exactly as a
   * parcel does.
   *
   * The two exclusions are carried over deliberately rather than by habit. Only
   * `active` products are swept, for the reason above. And a product mid-vectorisation
   * is skipped because `VectorisationService` writes `status: 'active'` when its job
   * completes — suspending one would be silently undone by that worker, which is worse
   * than not suspending it, because the suspension would appear to have taken.
   */
  async suspendAllVendorProducts(
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
  ): Promise<string[]> {
    const sessionOpt = options?.session ? { session: options.session } : {};
    const filter: FilterQuery<IProduct> = {
      vendorId: vendorId as any,
      status: 'active',
      deletedAt: null,
      vectorisationStatus: { $ne: 'pending' },
    };

    const docs = await this.model.find(filter, { _id: 1 }, sessionOpt).lean();
    if (docs.length === 0) return [];

    const ids = docs.map(d => d._id);
    await this.model.updateMany(
      { _id: { $in: ids } },
      [
        {
          $set: {
            suspension: { reason, previousStatus: '$status', suspendedAt: '$$NOW' },
            status: 'suspended',
            updatedAt: '$$NOW',
          },
        },
      ] as any,
      sessionOpt,
    ).exec();

    return ids.map(id => id.toString());
  }

  /**
   * Suspend a single product (no-op unless currently 'active' — see
   * suspendVendorPhysicalProducts for why non-active statuses are left alone),
   * capturing its current status. Returns whether it was suspended.
   *
   * `types` defaults to `['physical']` so every pre-existing caller keeps its exact
   * meaning; an administrator's `platform_oversight` takedown passes all three.
   */
  async suspendProduct(
    productId: string,
    vendorId: string,
    reason: ProductSuspensionReason,
    options?: RepositoryOptions,
    actor?: { agencyId?: string; note?: string | null },
    types: ProductType[] = ['physical'],
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(productId)) return false;
    const sessionOpt = options?.session ? { session: options.session } : {};

    const suspension: Record<string, unknown> = {
      reason,
      previousStatus: '$status',
      suspendedAt: '$$NOW',
    };
    if (actor) {
      // Absent for an administrator's takedown: there is no agency, and the id is an
      // authorisation predicate rather than provenance. What authorises the way back
      // out of `platform_oversight` is the reason itself — only the admin endpoint
      // lifts it — and who did it is the wi-admin audit row.
      if (actor.agencyId) suspension.suspendedByAgencyId = new Types.ObjectId(actor.agencyId);
      // `$literal` because this is an aggregation-pipeline update, where a plain
      // string beginning with `$` is read as a FIELD PATH. A note like
      // "$40 000 storage unpaid" would otherwise resolve to a missing field and
      // silently store nothing.
      suspension.note = { $literal: actor.note ?? null };
    }

    const result = await this.model.updateOne(
      {
        _id: productId,
        vendorId: vendorId as any,
        type: { $in: types },
        status: 'active',
        deletedAt: null,
        vectorisationStatus: { $ne: 'pending' },
      },
      [
        {
          $set: {
            suspension,
            status: 'suspended',
            updatedAt: '$$NOW',
          },
        },
      ] as any,
      sessionOpt,
    ).exec();

    return result.modifiedCount > 0;
  }

  /**
   * Find a vendor's physical products currently suspended for any of the given
   * reasons. Restoration is validated by the caller, not blind — see
   * ProductDeliveryAgencySuspensionService.
   */
  async findSuspendedByVendorAndReasons(
    vendorId: string,
    reasons: ProductSuspensionReason[],
    options?: RepositoryOptions,
    types: ProductType[] = ['physical'],
  ): Promise<Product[]> {
    const sessionOpt = options?.session ? { session: options.session } : {};
    const filter: FilterQuery<IProduct> = {
      vendorId: vendorId as any,
      type: { $in: types },
      status: 'suspended',
      'suspension.reason': { $in: reasons },
      deletedAt: null,
    };

    const query = this.model.find(filter);
    if (sessionOpt.session) query.session(sessionOpt.session);
    const docs = await query.exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  /**
   * Find physical products, across ANY vendor, whose OWN delivery.agencyId override
   * points at the given agency.
   */
  async findPhysicalByOwnDeliveryAgency(
    agencyId: string,
    options?: RepositoryOptions,
  ): Promise<Product[]> {
    if (!Types.ObjectId.isValid(agencyId)) return [];
    const filter: FilterQuery<IProduct> = {
      type: 'physical',
      'delivery.agency_id': agencyId as any,
      deletedAt: null,
    };

    const query = this.model.find(filter);
    if (options?.session) query.session(options.session);
    const docs = await query.exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  /**
   * Per-address product counts for the given vendor (see interface doc).
   */
  async countPhysicalByVendorAndPickupAddresses(
    vendorId: string,
    addressIds: string[],
    options?: RepositoryOptions,
  ): Promise<Record<string, number>> {
    if (addressIds.length === 0) return {};

    const aggregation = this.model.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $match: {
          vendorId: new Types.ObjectId(vendorId),
          type: 'physical',
          deletedAt: null,
          'delivery.pickup_location.source': 'vendor_address',
          'delivery.pickup_location.vendor_address_id': { $in: addressIds.map(id => new Types.ObjectId(id)) },
        },
      },
      { $group: { _id: '$delivery.pickup_location.vendor_address_id', count: { $sum: 1 } } },
    ]);
    if (options?.session) aggregation.session(options.session);
    const rows = await aggregation.exec();

    const result: Record<string, number> = {};
    for (const row of rows) result[row._id.toString()] = row.count;
    return result;
  }

  /** See IProductRepository.findAgencyStoredVariants. */
  async findAgencyStoredVariants(
    agencyId: string,
    options?: RepositoryOptions,
  ): Promise<AgencyStoredVariant[]> {
    if (!Types.ObjectId.isValid(agencyId)) return [];
    const agencyOid = new Types.ObjectId(agencyId);

    const aggregation = this.model.aggregate<{
      vendorId: Types.ObjectId;
      productId: Types.ObjectId;
      variantId: Types.ObjectId;
      agencyAddressId: Types.ObjectId | null;
    }>([
      // Narrow on the product's own fields first — this is the indexed part.
      //
      // `agency_storage_suspended` products stay in the roster on purpose: that
      // suspension is the AGENCY's own act, and sweeping its rows would delete the
      // row the unsuspend button lives on. Every other suspension reason means the
      // product stopped being warehoused here, so those are excluded and swept.
      {
        $match: {
          type: 'physical',
          deletedAt: null,
          'delivery.pickup_location.source': 'agency_storage',
          $or: [
            { status: 'active' },
            { status: 'suspended', 'suspension.reason': 'agency_storage_suspended' },
          ],
        },
      },
      // The vendor is needed ONLY for the default-agency fallback below.
      {
        $lookup: {
          from: COLLECTIONS.VENDOR,
          localField: 'vendorId',
          foreignField: '_id',
          as: 'vendor',
        },
      },
      { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: false } },
      // "Which agency actually fulfils this?" — the product's own override wins,
      // else the vendor's default. Same order as ProductStatusValidationService's
      // activation gate and order.service.ts's checkout resolution. Expressed
      // here rather than in JS so the whole roster is one round trip; note
      // `{ 'delivery.agency_id': null }` matches an ABSENT field too, which is
      // what a product with no override actually has.
      {
        $match: {
          $or: [
            { 'delivery.agency_id': agencyOid },
            { 'delivery.agency_id': null, 'vendor.default_delivery_agency_id': agencyOid },
          ],
        },
      },
      // Stock lives on the variant, so the roster is per variant, not per product.
      {
        $lookup: {
          from: COLLECTIONS.PRODUCT_VARIANT,
          let: { pid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$productId', '$$pid'] },
                status: 'active',
                deletedAt: null,
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'variants',
        },
      },
      { $unwind: { path: '$variants', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          _id: 0,
          vendorId: '$vendorId',
          productId: '$_id',
          variantId: '$variants._id',
          // Passed through RAW — resolving a dangling id is the caller's call.
          agencyAddressId: { $ifNull: ['$delivery.pickup_location.agency_address_id', null] },
        },
      },
    ]);
    if (options?.session) aggregation.session(options.session);
    const rows = await aggregation.exec();

    return rows.map(r => ({
      vendorId: r.vendorId.toString(),
      productId: r.productId.toString(),
      variantId: r.variantId.toString(),
      agencyAddressId: r.agencyAddressId ? r.agencyAddressId.toString() : null,
    }));
  }

  /**
   * Find a single vendor's physical products whose OWN delivery.agencyId override
   * points at the given agency — scoped version of findPhysicalByOwnDeliveryAgency,
   * used by the agency-connections pause/reapprove cascade (see interface doc).
   */
  async findPhysicalByVendorAndOwnDeliveryAgency(
    vendorId: string,
    agencyId: string,
    options?: RepositoryOptions,
  ): Promise<Product[]> {
    if (!Types.ObjectId.isValid(agencyId)) return [];
    const filter: FilterQuery<IProduct> = {
      vendorId: vendorId as any,
      type: 'physical',
      'delivery.agency_id': agencyId as any,
      deletedAt: null,
    };

    const query = this.model.find(filter);
    if (options?.session) query.session(options.session);
    const docs = await query.exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  /**
   * An agency's "products I'm set up to deliver" view (requirement #8) —
   * combined: physical products with an explicit `delivery.agencyId` override to
   * this agency, OR belonging to a vendor whose `default_delivery_agency_id` is
   * this agency AND that don't have their own override (which would take
   * precedence over the vendor default at order time). `vendorIdsUsingAsDefault`
   * is resolved by the caller via VendorRepository.findVendorIdsByDefaultAgency —
   * kept out of this repository to avoid a cross-module repo dependency.
   */
  async findByEffectiveDeliveryAgency(
    agencyId: string,
    vendorIdsUsingAsDefault: string[],
    pagination: PaginationOptions,
    options?: RepositoryOptions,
  ): Promise<Page<Product>> {
    if (!Types.ObjectId.isValid(agencyId)) {
      return { data: [], meta: { total: 0, page: pagination.page, limit: pagination.limit, pages: 0 } };
    }

    const vendorObjIds = vendorIdsUsingAsDefault.filter(id => Types.ObjectId.isValid(id));

    const filter: FilterQuery<IProduct> = {
      type: 'physical',
      $or: [
        { 'delivery.agency_id': agencyId as any },
        ...(vendorObjIds.length > 0
          ? [{ vendorId: { $in: vendorObjIds as any[] }, 'delivery.agency_id': null }]
          : []),
      ],
    };

    return this.paginate(filter, pagination, options);
  }
}
