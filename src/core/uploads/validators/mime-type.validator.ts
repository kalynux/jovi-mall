import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * MIME Type Validator
 * 
 * Enforces MIME type allowlist.
 * Validates against DETECTED MIME type (from FileSniffingProcessor), not client-provided.
 */
export class MimeTypeValidator implements IUploadValidator {
  constructor(private readonly config: UploadPolicyConfig) {}

  async validate(context: UploadPipelineContext): Promise<void> {
    for (let i = 0; i < context.files.length; i++) {
      const fileContext = context.files[i];
      const mimeType = fileContext.mimeType; // This is the DETECTED MIME type
      const mimeConfig = this.config.perMimeType[mimeType];

      // Check if MIME type is configured
      if (!mimeConfig) {
        context.addViolation({
          code: 'MIME_NOT_ALLOWED',
          message: `MIME type not allowed: ${mimeType}`,
          fileIndex: i,
          metadata: {
            mimeType,
            originalName: fileContext.originalName,
          },
        });
        continue;
      }

      // Check if explicitly disallowed
      if (!mimeConfig.allowed) {
        context.addViolation({
          code: 'MIME_NOT_ALLOWED',
          message: `MIME type explicitly blocked: ${mimeType}`,
          fileIndex: i,
          metadata: {
            mimeType,
            originalName: fileContext.originalName,
          },
        });
      }
    }
  }
}
