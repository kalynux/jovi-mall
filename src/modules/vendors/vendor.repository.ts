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
   * Update vendor profile with optimistic locking.
   * Checks version matches before applying the update and increments atomically.
   */
  async updateProfileWithVersion(
    vendorId: string,
    currentVersion: number,
    updates: Partial<IVendor>
  ): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { _id: vendorId, version: currentVersion },
      { ...updates, $inc: { version: 1 } },
      { new: true }
    );
  }

  /**
   * Update profile without version check.
   * Use only for system-initiated updates (e.g., onboarding step recalculation).
   */
  async updateProfile(vendorId: string, updates: Partial<IVendor>): Promise<IVendor | null> {
    return await VendorModel.findByIdAndUpdate(vendorId, updates, { new: true });
  }

  /**
   * Atomic onboarding update with optional optimistic concurrency check.
   * When expectedVersion is provided, the update only proceeds if the document's
   * current version matches — returning null on a version mismatch.
   */
  async atomicOnboardingUpdate(
    vendorId: string,
    updates: Partial<IVendor>,
    expectedVersion?: number,
  ): Promise<IVendor | null> {
    const filter: Record<string, unknown> = { _id: vendorId };
    if (expectedVersion !== undefined) {
      filter.version = expectedVersion;
    }
    return await VendorModel.findOneAndUpdate(
      filter,
      { $set: updates, $inc: { version: 1 } },
      { new: true },
    );
  }

  /**
   * Set the onboarding step. Called by the service after field-presence recalculation.
   */
  async updateOnboardingStep(vendorId: string, step: number): Promise<IVendor | null> {
    return await VendorModel.findByIdAndUpdate(
      vendorId,
      { onboarding_step: step, $inc: { version: 1 } },
      { new: true }
    );
  }

  /**
   * Admin-only: flip legit_verified on both top-level (deprecated) and kyc_details.
   */
  async setLegitVerified(vendorId: string, verified: boolean): Promise<IVendor | null> {
    return await VendorModel.findByIdAndUpdate(
      vendorId,
      {
        $set: {
          legit_verified: verified,
          'kyc_details.legit_verified': verified,
        },
      },
      { new: true }
    );
  }

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
