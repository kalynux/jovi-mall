import { StoreModel, IStore } from '../models/store.model';
import { NotFoundError } from '../../../core/errors';

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
      throw new NotFoundError(
        `Store not found for vendor ${vendorId}. This is a system bug - vendors should always have a store.`
      );
    }
    
    return store;
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
   * ONBOARDING ONLY: Create store
   * 
   * Called ONLY during vendor onboarding.
   * Not exposed in store profile management API.
   */
  async create(storeData: Partial<IStore>): Promise<IStore> {
    const store = new StoreModel(storeData);
    return await store.save();
  }
}
