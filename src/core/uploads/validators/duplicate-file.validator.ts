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

    // Duplicate detection is scoped per-vendor: a vendor cannot re-upload a
    // file they already own, but identical content from other owners is not a
    // duplicate. Uploads without a vendor (e.g. system) are not deduplicated.
    const ownerId = context.getVendorId();
    if (!ownerId) {
      return;
    }

    // Tracks content hashes already seen earlier in THIS request, so two
    // identical files in a single upload are caught even though neither is
    // persisted yet. Maps hash -> the file index that first carried it.
    const seenHashes = new Map<string, number>();

    for (let i = 0; i < context.files.length; i++) {
      const fileContext = context.files[i];

      // Skip if file wasn't fingerprinted
      if (!fileContext.hash) {
        continue;
      }

      // In-request duplicate: an earlier file in this same upload had the same
      // content. The DB check below can't catch this because nothing is stored
      // until validation passes.
      const firstIndex = seenHashes.get(fileContext.hash);
      if (firstIndex !== undefined) {
        if (this.config.duplicateDetection.blockDuplicates) {
          context.addViolation({
            code: 'DUPLICATE_FILE',
            message: `Duplicate file detected. Identical content was already provided earlier in this request.`,
            fileIndex: i,
            metadata: {
              hash: fileContext.hash,
              duplicateOfIndex: firstIndex,
              originalName: fileContext.originalName,
            },
          });
        } else {
          console.info(`Duplicate file detected in request (hash: ${fileContext.hash}, index ${i} duplicates ${firstIndex}), but duplicates are allowed`);
        }
        // Already flagged/logged against the first occurrence; no need to also
        // hit the DB for this copy.
        continue;
      }
      seenHashes.set(fileContext.hash, i);

      try {
        // Cross-request duplicate: this vendor already owns a stored file with
        // the same content hash.
        const existingFile = await this.fileRepository.findByChecksum(fileContext.hash, ownerId);

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
}
