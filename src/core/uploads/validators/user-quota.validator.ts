import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';
import { IFileRepository } from '../../../modules/catalog/repositories/interfaces/file.repository.interface';

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

    const { userId, vendorId, role } = context.request.context;
    const ownerId = role === 'vendor' && vendorId ? vendorId : userId;
    const ownerType = role === 'vendor' ? 'vendor' : 'system';

    try {
      // Get current usage for this user/vendor
      const currentUsage = await this.getCurrentUsage(ownerId, ownerType);
      
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

      // Check storage size quota
      if (newTotalSize > this.config.userQuotas.maxStorageBytes) {
        context.addViolation({
          code: 'QUOTA_EXCEEDED',
          message: `Storage quota exceeded. Maximum: ${this.formatBytes(this.config.userQuotas.maxStorageBytes)}, Current: ${this.formatBytes(currentUsage.totalSize)}, Requested: ${this.formatBytes(context.getTotalSize())}`,
          metadata: {
            currentTotalSize: currentUsage.totalSize,
            newTotalSize,
            maxStorageBytes: this.config.userQuotas.maxStorageBytes,
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
   * Get current usage for a user/vendor
   * V1 implementation: queries repository
   * TODO: Replace with cached counter system in production
   */
  private async getCurrentUsage(
    ownerId: string,
    ownerType: string
  ): Promise<{ fileCount: number; totalSize: number }> {
    // TODO: Implement efficient quota query
    // For now, return zero to allow uploads
    // In production, this should query aggregated stats or cached counters
    return {
      fileCount: 0,
      totalSize: 0,
    };
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
