import { Types } from 'mongoose';
import { FileReferenceModel } from '../../catalog/models/file-reference.model';
import { COLLECTIONS } from '../../../core/database/collections';
import { VendorPlanModel } from '../../billing/models/vendor-plan.model';
import { PricingPlanModel } from '../../billing/models/pricing-plan.model';

export interface VendorStorageUsage {
  totalSize: number;
  fileCount: number;
}

/**
 * StorageUsageService
 *
 * Computes a vendor's product-media storage footprint and resolves their cap.
 *
 * Scope: only `product`/`variant` file references count toward usage — this
 * matches `PricingPlan.max_storage_bytes`, which by design EXCLUDES digital
 * product assets (the sellable goods, billed/limited separately). A file shared
 * by several products is counted once (distinct fileId), so usage reflects real
 * bytes on disk rather than reference count.
 */
export class StorageUsageService {
  /** Entity types that count against the media storage cap. */
  private static readonly MEDIA_ENTITY_TYPES = ['product', 'variant'];

  /**
   * Aggregate a vendor's distinct media files and sum their sizes.
   */
  async getVendorUsage(vendorId: string): Promise<VendorStorageUsage> {
    if (!Types.ObjectId.isValid(vendorId)) {
      return { totalSize: 0, fileCount: 0 };
    }

    const rows = await FileReferenceModel.aggregate<{ totalSize: number; fileCount: number }>([
      {
        $match: {
          ownerType: 'vendor',
          ownerId: new Types.ObjectId(vendorId),
          deletedAt: null,
          entityType: { $in: StorageUsageService.MEDIA_ENTITY_TYPES },
        },
      },
      // Collapse to distinct files so a file used by N products is counted once.
      { $group: { _id: '$fileId' } },
      {
        $lookup: {
          from: COLLECTIONS.FILE,
          localField: '_id',
          foreignField: '_id',
          as: 'file',
        },
      },
      { $unwind: '$file' },
      { $match: { 'file.deletedAt': null } },
      {
        $group: {
          _id: null,
          totalSize: { $sum: '$file.size' },
          fileCount: { $sum: 1 },
        },
      },
    ]);

    const result = rows[0];
    return {
      totalSize: result?.totalSize ?? 0,
      fileCount: result?.fileCount ?? 0,
    };
  }

  /**
   * Resolve a vendor's storage cap from their active plan, falling back to the
   * provided default when no active plan / plan limit is available.
   */
  async getVendorLimitBytes(vendorId: string, defaultLimitBytes: number): Promise<number> {
    if (!Types.ObjectId.isValid(vendorId)) return defaultLimitBytes;

    const activePlan = await VendorPlanModel.findOne({
      vendor_id: new Types.ObjectId(vendorId),
      status: 'active',
    })
      .select('plan_id')
      .lean();

    if (!activePlan) return defaultLimitBytes;

    const plan = await PricingPlanModel.findById(activePlan.plan_id)
      .select('max_storage_bytes')
      .lean();

    const limit = plan?.max_storage_bytes;
    return typeof limit === 'number' && limit > 0 ? limit : defaultLimitBytes;
  }
}
