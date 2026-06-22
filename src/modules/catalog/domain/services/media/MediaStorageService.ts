import { Types, Model } from 'mongoose';
import { FileModel } from '../../../models/file.model';
import { DigitalAssetModel } from '../../../../digital-delivery/models/digital-asset.model';
import { MEDIA_CATEGORIES, MediaCategory, categorySwitchExpr } from './media-category';

export interface CategoryUsage {
  bytes: number;
  count: number;
}

export type UsageByCategory = Record<MediaCategory, CategoryUsage>;

export interface StorageUsage {
  /** Total media bytes (sum of all categories, digital assets excluded for vendors). */
  total: number;
  byCategory: UsageByCategory;
}

export type StorageOwnerType = 'vendor' | 'customer' | 'agent' | 'agency' | 'admin' | 'system';

/**
 * MediaStorageService
 *
 * Single source of truth for per-owner media storage usage. Powers both the
 * storage analytics in the media endpoints / plan response and the plan-driven
 * upload quota enforcement.
 *
 * Counts product media (images, videos, docs, audio, archives) the owner has
 * uploaded. For **vendors**, the vendor's digital-product asset files are
 * subtracted out — those `File` records are vendor-owned but are billed under a
 * separate, plan-independent 500MB/asset cap and must not count toward the media
 * storage limit.
 */
export class MediaStorageService {
  /** Per-category bytes + counts (+ total) for an owner. */
  async getUsageBreakdown(ownerType: StorageOwnerType, ownerId: string): Promise<StorageUsage> {
    const oid = new Types.ObjectId(ownerId);

    const fileMap = await this.aggregateByCategory(FileModel as unknown as Model<unknown>, {
      ownerType,
      ownerId: oid,
      deletedAt: null,
    });

    // Vendors: exclude digital-asset files (counted under their own 500MB/asset cap).
    const digitalMap =
      ownerType === 'vendor'
        ? await this.aggregateByCategory(DigitalAssetModel as unknown as Model<unknown>, {
            vendorId: oid,
            deletedAt: null,
          })
        : new Map<string, CategoryUsage>();

    const byCategory = {} as UsageByCategory;
    let total = 0;
    for (const cat of MEDIA_CATEGORIES) {
      const f = fileMap.get(cat) ?? { bytes: 0, count: 0 };
      const d = digitalMap.get(cat) ?? { bytes: 0, count: 0 };
      const bytes = Math.max(0, f.bytes - d.bytes);
      const count = Math.max(0, f.count - d.count);
      byCategory[cat] = { bytes, count };
      total += bytes;
    }

    return { total, byCategory };
  }

  /** Total media bytes for an owner (convenience for quota checks). */
  async getUsedBytes(ownerType: StorageOwnerType, ownerId: string): Promise<number> {
    const { total } = await this.getUsageBreakdown(ownerType, ownerId);
    return total;
  }

  /** Group a collection's `size` by derived media category. */
  private async aggregateByCategory(
    model: Model<unknown>,
    match: Record<string, unknown>
  ): Promise<Map<string, CategoryUsage>> {
    const rows = await model.aggregate<{ _id: string; bytes: number; count: number }>([
      { $match: match },
      { $group: { _id: categorySwitchExpr('$mimeType'), bytes: { $sum: '$size' }, count: { $sum: 1 } } },
    ]);
    const map = new Map<string, CategoryUsage>();
    for (const row of rows) {
      map.set(row._id, { bytes: row.bytes ?? 0, count: row.count ?? 0 });
    }
    return map;
  }
}

export const mediaStorageService = new MediaStorageService();
