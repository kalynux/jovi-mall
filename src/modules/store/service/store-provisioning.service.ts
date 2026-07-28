import { StoreRepository } from '../repositories/store.repository';
import { IStore } from '../models/store.model';
import { VendorRepository } from '../../vendors/vendor.repository';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Store Provisioning Service
 *
 * Every vendor must have exactly one store, but historically nothing created
 * it. This service is the single creation path, used from two places:
 *
 * 1. Vendor onboarding Step 1 (best-effort hook in VendorProfileService).
 * 2. Get-or-create on first access to any /api/vendor/store endpoint —
 *    which also heals pre-existing vendors that never got a store row.
 *
 * The store carries no address/city/country of its own: physical locations
 * are the vendor's geocoded `business_addresses`, and the country lives on
 * the vendor profile (set-once at onboarding).
 */
export class StoreProvisioningService {
  private storeRepo: StoreRepository;
  private vendorRepo: VendorRepository;

  constructor() {
    this.storeRepo = new StoreRepository();
    this.vendorRepo = new VendorRepository();
  }

  /**
   * Return the vendor's store, creating it if it does not exist yet.
   *
   * Concurrency-safe: the unique index on `vendor_id` makes the create race
   * lose cleanly — on a duplicate-key error the winner's row is re-fetched.
   */
  async ensureStoreForVendor(vendorId: string, seedName?: string): Promise<IStore> {
    const existing = await this.storeRepo.findByVendorIdOrNull(vendorId);
    if (existing) return existing;

    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) {
      throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');
    }

    const name = this.deriveStoreName(seedName, vendor.display_name);
    const slug = await this.generateUniqueSlug(name);

    try {
      return await this.storeRepo.create({
        vendor_id: vendor._id,
        name,
        slug,
        is_open: true,
        version: 0,
      });
    } catch (err) {
      // E11000 duplicate key: either a concurrent request created the store
      // (vendor_id) — return theirs — or the slug was taken in the window
      // between the uniqueness check and the insert — retry once.
      if (this.isDuplicateKeyError(err)) {
        const winner = await this.storeRepo.findByVendorIdOrNull(vendorId);
        if (winner) return winner;

        const retrySlug = await this.generateUniqueSlug(`${name} ${Date.now() % 10000}`);
        return await this.storeRepo.create({
          vendor_id: vendor._id,
          name,
          slug: retrySlug,
          is_open: true,
          version: 0,
        });
      }
      throw err;
    }
  }

  /**
   * Store display name: an explicit seed (from signup/onboarding), else the
   * vendor's personal display name, else a placeholder (min 2 chars per schema).
   * The Store's name is the vendor's business-name source of truth.
   */
  private deriveStoreName(seedName: string | undefined, displayName: string | undefined): string {
    const base = (seedName?.trim() || displayName?.trim() || '');
    const name = base.length >= 2 ? base : `${base} Store`.trim();
    return name.slice(0, 100);
  }

  /**
   * URL-safe slug from the store name, auto-suffixed until globally unique.
   * Must satisfy the model's /^[a-z0-9]+(?:-[a-z0-9]+)*$/ pattern.
   */
  private async generateUniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '') // strip everything not URL-safe (incl. underscores)
        .replace(/[\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || 'store';

    let candidate = base;
    let counter = 2;
    while (await this.storeRepo.findBySlug(candidate)) {
      candidate = `${base}-${counter}`;
      counter++;
    }
    return candidate;
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: number }).code === 11000
    );
  }
}
