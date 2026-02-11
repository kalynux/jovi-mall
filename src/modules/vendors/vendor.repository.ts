import { VendorModel, IVendor } from './vendor.model';

export class VendorRepository {
  async create(vendorData: Partial<IVendor>): Promise<IVendor> {
    const vendor = new VendorModel(vendorData);
    return await vendor.save();
  }

  async findByUserId(userId: string): Promise<IVendor | null> {
    return await VendorModel.findOne({ user_id: userId });
  }

  async findById(vendorId: string): Promise<IVendor | null> {
    return await VendorModel.findById(vendorId);
  }

  async markEmailVerified(userId: string): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { user_id: userId },
      { $set: { email_verified: true, status: 'active' } },
      { new: true }
    );
  }

  async updateWaVerified(userId: string, waData: { wa_phone_id: string; name?: string }): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': true,
          'wa.wa_phone_id': waData.wa_phone_id,
          'wa.bound_at': new Date(),
          'wa.last_seen_at': new Date(),
          ...(waData.name ? { 'wa.name': waData.name } : {})
        }
      },
      { new: true }
    );
  }

  async updateStatus(userId: string, status: string): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate({ user_id: userId }, { status }, { new: true });
  }

  /**
   * Update vendor profile with optimistic locking
   * 
   * This method ensures that concurrent updates don't silently overwrite each other.
   * It checks that the version matches before applying the update and increments it atomically.
   * 
   * @param vendorId - Vendor ID
   * @param currentVersion - Expected current version
   * @param updates - Fields to update
   * @returns Updated vendor or null if version mismatch
   */
  async updateProfileWithVersion(
    vendorId: string,
    currentVersion: number,
    updates: Partial<IVendor>
  ): Promise<IVendor | null> {
    // Atomic update: only succeeds if version matches
    return await VendorModel.findOneAndUpdate(
      { _id: vendorId, version: currentVersion },
      {
        ...updates,
        $inc: { version: 1 } // Increment version atomically
      },
      { new: true } // Return updated document
    );
  }

  /**
   * Update profile without version check (use with caution)
   * 
   * This should only be used for system-initiated updates where
   * optimistic locking is not required (e.g., verification status changes)
   */
  async updateProfile(vendorId: string, updates: Partial<IVendor>): Promise<IVendor | null> {
    return await VendorModel.findByIdAndUpdate(vendorId, updates, { new: true });
  }

  /**
   * Unlink WhatsApp account for a vendor
   * @param userId - User ID
   * @returns Updated vendor
   */
  async unlinkWhatsApp(userId: string): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': false,
          'wa.wa_phone_id': null,
          'wa.name': null,
          'wa.bound_at': null,
          'wa.last_seen_at': null
        }
      },
      { new: true }
    );
  }
}
