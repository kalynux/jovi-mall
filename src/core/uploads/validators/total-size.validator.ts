import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * Total Size Validator
 * 
 * Enforces total size limit across all files in a request.
 */
export class TotalSizeValidator implements IUploadValidator {
  constructor(private readonly config: UploadPolicyConfig) {}

  async validate(context: UploadPipelineContext): Promise<void> {
    const totalSize = context.getTotalSize();
    const maxTotalSize = this.config.maxTotalSizeBytes;

    if (totalSize > maxTotalSize) {
      context.addViolation({
        code: 'TOTAL_SIZE_EXCEEDED',
        message: `Total size exceeds limit. Maximum: ${this.formatBytes(maxTotalSize)}, Received: ${this.formatBytes(totalSize)}`,
        metadata: {
          totalSize,
          maxTotalSize,
        },
      });
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
