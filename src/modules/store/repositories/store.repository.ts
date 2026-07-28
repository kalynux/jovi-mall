import { StoreModel, IStore } from '../models/store.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Store Repository
 * 
 * CRITICAL: Vendors access stores by vendorId ONLY.
 * storeId-based methods are internal/admin-only.
 */
export class StoreRepository {
  /**
   * VENDOR-FACING: Find store by vendor ID
   * 
   * Main access pattern for vendor API.
   * FAILS LOUDLY if store not found (system bug, not business case).
   * 
   * @param vendorId - Vendor ID
   * @returns Store document
   * @throws NotFoundError if store not found
   */
  async findByVendorId(vendorId: string): Promise<IStore> {
    const store = await StoreModel.findOne({ vendor_id: vendorId });

    if (!store) {
      throw createAppError(ERROR_CODES.STORE_NOT_FOUND, 404, `Store not found for vendor ${vendorId}. This is a system bug - vendors should always have a store.`);
    }

    return store;
  }

  /**
   * VENDOR-FACING: Find store by vendor ID, or null when none exists yet.
   *
   * Used by the provisioning path (get-or-create) — unlike findByVendorId,
   * a missing store here is a normal state, not a bug.
   */
  async findByVendorIdOrNull(vendorId: string): Promise<IStore | null> {
    return await StoreModel.findOne({ vendor_id: vendorId });
  }

  /**
   * VENDOR-FACING: Update store by vendor ID with optimistic locking
   * 
   * @param vendorId - Vendor ID
   * @param currentVersion - Expected current version
   * @param updates - Fields to update
   * @returns Updated store or null if version mismatch
   */
  async updateByVendorId(
    vendorId: string,
    currentVersion: number,
    updates: Partial<IStore>
  ): Promise<IStore | null> {
    return await StoreModel.findOneAndUpdate(
      { vendor_id: vendorId, version: currentVersion },
      {
        ...updates,
        $inc: { version: 1 }, // Increment version atomically
      },
      { new: true }
    );
  }

  /**
   * VENDOR-FACING: Update store status (vacation mode) by vendor ID
   * 
   * @param vendorId - Vendor ID
   * @param currentVersion - Expected current version
   * @param isOpen - Vacation mode state (true = open, false = on vacation)
   * @returns Updated store or null if version mismatch
   */
  async updateStatusByVendorId(
    vendorId: string,
    currentVersion: number,
    isOpen: boolean
  ): Promise<IStore | null> {
    return await StoreModel.findOneAndUpdate(
      { vendor_id: vendorId, version: currentVersion },
      {
        is_open: isOpen,
        $inc: { version: 1 },
      },
      { new: true }
    );
  }

  /**
   * INTERNAL/ADMIN: Find store by ID
   * 
   * Not exposed to vendor API.
   * Used for admin operations, cross-module references.
   */
  async findById(storeId: string): Promise<IStore | null> {
    return await StoreModel.findById(storeId);
  }

  /**
   * INTERNAL/ADMIN: Find store by slug
   * 
   * Used for:
   * - Public storefront routing
   * - Admin slug validation/changes
   */
  async findBySlug(slug: string): Promise<IStore | null> {
    return await StoreModel.findOne({ slug });
  }

  /**
   * PROVISIONING ONLY: Create store
   *
   * Called ONLY by StoreProvisioningService (onboarding Step 1 hook and the
   * get-or-create path on first store access).
   * Not exposed in store profile management API.
   */
  async create(storeData: Partial<IStore>): Promise<IStore> {
    const store = new StoreModel(storeData);
    return await store.save();
  }

  /**
   * Batch-resolve vendor ids → their business name + logo file id, keyed by
   * vendor id string. Vendors without a store are simply absent from the map.
   * The Store is the source of truth for a vendor's business name/logo, so any
   * read-heavy path (orders, connections, notifications, admin) that used to read
   * `vendor.business_name` resolves it here instead — in ONE query, not N+1.
   */
  async findNamesByVendorIds(
    vendorIds: Array<string>,
  ): Promise<Map<string, { name: string; logoFileId: string | null }>> {
    const ids = [...new Set(vendorIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await StoreModel.find({ vendor_id: { $in: ids } })
      .select('vendor_id name logo_file_id')
      .lean()
      .exec();
    return new Map(
      rows.map((r) => [
        r.vendor_id.toString(),
        { name: r.name, logoFileId: r.logo_file_id ? r.logo_file_id.toString() : null },
      ]),
    );
  }

  /** Convenience single-id name lookup. Returns null when no store exists yet. */
  async findNameByVendorId(vendorId: string): Promise<string | null> {
    const row = await StoreModel.findOne({ vendor_id: vendorId }).select('name').lean().exec();
    return row?.name ?? null;
  }
}
