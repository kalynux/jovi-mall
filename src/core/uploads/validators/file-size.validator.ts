import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * File Size Validator
 * 
 * Enforces per-file size limits based on MIME type.
 * Validates against DETECTED MIME type, not client-provided.
 */
export class FileSizeValidator implements IUploadValidator {
  constructor(private readonly config: UploadPolicyConfig) {}

  async validate(context: UploadPipelineContext): Promise<void> {
    for (let i = 0; i < context.files.length; i++) {
      const fileContext = context.files[i];
      const mimeConfig = this.config.perMimeType[fileContext.mimeType];

      if (!mimeConfig) {
        // No config for this MIME type - will be caught by MIME type validator
        continue;
      }

      const fileSize = fileContext.size;
      const maxSize = mimeConfig.maxSizeBytes;

      if (fileSize > maxSize) {
        context.addViolation({
          code: 'FILE_TOO_LARGE',
          message: `File exceeds size limit for type ${fileContext.mimeType}. Maximum: ${this.formatBytes(maxSize)}, Received: ${this.formatBytes(fileSize)}`,
          fileIndex: i,
          metadata: {
            fileSize,
            maxSize,
            mimeType: fileContext.mimeType,
            originalName: fileContext.originalName,
          },
        });
      }
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
