import { Types } from 'mongoose';
import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';
import { IFileRepository } from '../../../modules/catalog/repositories/interfaces/file.repository.interface';
import { FileReferenceModel } from '../../../modules/catalog/models/file-reference.model';
import { COLLECTIONS } from '../../database/collections';

/**
 * User Quota Validator
 * 
 * Checks user/vendor storage quotas.
 * 
 * V1: Queries File repository for current usage (acceptable for initial deployment)
 * Production: Should use cached counters per user/vendor to avoid table scans
 */
export class UserQuotaValidator implements IUploadValidator {
  constructor(
    private readonly config: UploadPolicyConfig,
    private readonly fileRepository: IFileRepository
  ) {}

  async validate(context: UploadPipelineContext): Promise<void> {
    if (!this.config.userQuotas.enabled) {
      return;
    }

    const { userId, vendorId, role, storageLimitBytes, currentUsageBytes } = context.request.context;
    const ownerId = role === 'vendor' && vendorId ? vendorId : userId;
    const ownerType = role === 'vendor' ? 'vendor' : 'system';

    // Plan-driven storage limit (resolved by the caller) overrides the static
    // config cap when provided. Storage is the meaningful, plan-tiered lever.
    const maxStorageBytes = storageLimitBytes ?? this.config.userQuotas.maxStorageBytes;

    try {
      // Prefer the caller-supplied current usage (accurate, media-only); fall
      // back to the repository query otherwise.
      const currentUsage =
        currentUsageBytes !== undefined
          ? { fileCount: 0, totalSize: currentUsageBytes }
          : await this.getCurrentUsage(ownerId, ownerType);

      // Calculate new usage after this upload
      const newFileCount = currentUsage.fileCount + context.getFileCount();
      const newTotalSize = currentUsage.totalSize + context.getTotalSize();

      // Check file count quota
      if (newFileCount > this.config.userQuotas.maxFilesTotal) {
        context.addViolation({
          code: 'QUOTA_EXCEEDED',
          message: `File count quota exceeded. Maximum: ${this.config.userQuotas.maxFilesTotal}, Current: ${currentUsage.fileCount}, Requested: ${context.getFileCount()}`,
          metadata: {
            currentFileCount: currentUsage.fileCount,
            newFileCount,
            maxFiles: this.config.userQuotas.maxFilesTotal,
            ownerId,
            ownerType,
          },
        });
      }

      // Check storage size quota (plan-driven limit when provided)
      if (newTotalSize > maxStorageBytes) {
        context.addViolation({
          code: 'QUOTA_EXCEEDED',
          message: `Storage quota exceeded. Maximum: ${this.formatBytes(maxStorageBytes)}, Current: ${this.formatBytes(currentUsage.totalSize)}, Requested: ${this.formatBytes(context.getTotalSize())}`,
          metadata: {
            currentTotalSize: currentUsage.totalSize,
            newTotalSize,
            maxStorageBytes,
            ownerId,
            ownerType,
          },
        });
      }

    } catch (error: any) {
      // Quota check failure - log but don't block (fail open for availability)
      console.error(`Quota check failed for ${ownerId}:`, error.message);
    }
  }

  /**
   * Get current product-media usage for a user/vendor by aggregating live
   * file references joined to file sizes. Distinct files only (a file shared by
   * several products counts once), scoped to product/variant references so the
   * figure matches the plan's `max_storage_bytes` (which excludes digital assets).
   *
   * Mirrors StorageUsageService; kept inline here so the upload pipeline has no
   * dependency on the file-cleanup module. Fails open (returns zero) on error so
   * a transient aggregation failure never blocks uploads.
   */
  private async getCurrentUsage(
    ownerId: string,
    ownerType: string
  ): Promise<{ fileCount: number; totalSize: number }> {
    if (!Types.ObjectId.isValid(ownerId)) {
      return { fileCount: 0, totalSize: 0 };
    }

    const rows = await FileReferenceModel.aggregate<{ totalSize: number; fileCount: number }>([
      {
        $match: {
          ownerType,
          ownerId: new Types.ObjectId(ownerId),
          deletedAt: null,
          entityType: { $in: ['product', 'variant'] },
        },
      },
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
      fileCount: result?.fileCount ?? 0,
      totalSize: result?.totalSize ?? 0,
    };
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
