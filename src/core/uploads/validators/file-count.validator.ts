import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * File Count Validator
 * 
 * Enforces maximum files per request limit.
 */
export class FileCountValidator implements IUploadValidator {
  constructor(private readonly config: UploadPolicyConfig) {}

  async validate(context: UploadPipelineContext): Promise<void> {
    const fileCount = context.getFileCount();
    const maxFiles = this.config.maxFilesPerRequest;

    if (fileCount > maxFiles) {
      context.addViolation({
        code: 'TOO_MANY_FILES',
        message: `Too many files in request. Maximum: ${maxFiles}, Received: ${fileCount}`,
        metadata: {
          fileCount,
          maxFiles,
        },
      });
    }
  }
}
