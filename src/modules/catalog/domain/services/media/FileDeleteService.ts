import { ConflictError, NotFoundError } from '../../../../../core/errors';
import { IStorageProvider } from '../../../../../core/storage';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';

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
    private readonly fileRepository: IFileRepository
  ) {}

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
      throw new NotFoundError('File not found');
    }

    // Safety check: only delete orphaned files unless forced
    if (!file.isOrphan && !command.force) {
      throw new ConflictError('Cannot delete file that is still referenced. Use force=true to override.');
    }

    // Delete physical file from storage
    await this.storageProvider.delete(file.key);

    // Delete database record (hard delete)
    await this.fileRepository.hardDelete(file.id);
  }
}
