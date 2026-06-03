import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IStorageProvider } from '../../../../../core/storage';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IFileReferenceRepository } from '../../../repositories/interfaces/file-reference.repository.interface';

export interface DeleteFileCommand {
  fileId: string;
  force?: boolean;  // if true, delete even if not orphaned
}

/**
 * FileDeleteService
 * 
 * Deletes file record AND physical file from storage.
 * 
 * Safety rules:
 * - If file is not orphaned and force is false → throw ConflictError
 * - If force is true → delete regardless of orphan status
 * - Always deletes physical file AND database record
 */
export class FileDeleteService {
  constructor(
    private readonly storageProvider: IStorageProvider,
    private readonly fileRepository: IFileRepository,
    private readonly fileReferenceRepository: IFileReferenceRepository
  ) { }

  /**
   * Delete file record and physical file
   * @param command - Delete command with fileId and optional force flag
   * @throws ConflictError if file is not orphaned and force is false
   * @throws NotFoundError if file does not exist
   */
  async execute(command: DeleteFileCommand): Promise<void> {
    // Find file
    const file = await this.fileRepository.findById(command.fileId);

    if (!file) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404);
    }

    // Safety check: only delete files with no live references unless forced
    if (!command.force) {
      const referenceCount = await this.fileReferenceRepository.countByFile(file.id);
      if (referenceCount > 0) {
        throw createAppError(ERROR_CODES.CATALOG_FILE_STILL_REFERENCED, 409, undefined, { referenceCount });
      }
    }

    // Delete physical file from storage
    await this.storageProvider.delete(file.key);

    // Delete database record (hard delete)
    await this.fileRepository.hardDelete(file.id);
  }
}
