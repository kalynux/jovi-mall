import { IUploadValidator, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';
import { IFileRepository } from '../../../modules/catalog/repositories/interfaces/file.repository.interface';

/**
 * Duplicate File Validator
 * 
 * Detects duplicate files by comparing SHA256 fingerprints.
 * Can either block duplicates or return existing file reference.
 */
export class DuplicateFileValidator implements IUploadValidator {
  constructor(
    private readonly config: UploadPolicyConfig,
    private readonly fileRepository: IFileRepository
  ) {}

  async validate(context: UploadPipelineContext): Promise<void> {
    if (!this.config.duplicateDetection.enabled) {
      return;
    }

    for (let i = 0; i < context.files.length; i++) {
      const fileContext = context.files[i];

      // Skip if file wasn't fingerprinted
      if (!fileContext.hash) {
        continue;
      }

      try {
        // Check if file with same hash already exists
        // Note: This assumes a method to find by checksum exists
        // You may need to add this to IFileRepository
        const existingFile = await this.findByChecksum(fileContext.hash);

        if (existingFile) {
          if (this.config.duplicateDetection.blockDuplicates) {
            // Block duplicate upload
            context.addViolation({
              code: 'DUPLICATE_FILE',
              message: `Duplicate file detected. File with same content already exists.`,
              fileIndex: i,
              metadata: {
                hash: fileContext.hash,
                existingFileId: existingFile.id,
                originalName: fileContext.originalName,
              },
            });
          } else {
            // Allow duplicate but log for information
            // In a production system, you might want to return the existing file reference
            // instead of uploading again
            console.info(`Duplicate file detected (hash: ${fileContext.hash}), but duplicates are allowed`);
          }
        }

      } catch (error: any) {
        // Duplicate check failure - log but don't block
        console.warn(`Duplicate check failed for ${fileContext.originalName}:`, error.message);
      }
    }
  }

  /**
   * Find file by checksum
   * This is a temporary implementation - ideally this should be in IFileRepository
   */
  private async findByChecksum(checksum: string): Promise<any | null> {
    // TODO: Add findByChecksum method to IFileRepository
    // For now, return null to allow uploads
    return null;
  }
}
