import { IStorageProvider } from '../../../../../core/storage';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { File } from '../../../repositories/mappers/file.mapper';

export interface UploadFileCommand {
  buffer: Buffer;
  mimeType: string;
  originalName?: string;
  folder: 'products' | 'variants' | 'digital';
  vendorId?: string;  // if vendor-uploaded
}

/**
 * FileUploadService
 * 
 * @deprecated Use UploadIntakeService from '@/core/uploads' instead.
 * 
 * This service bypasses the policy-driven upload security layer.
 * All uploads should go through UploadIntakeService which provides:
 * - MIME type detection from buffer (prevents spoofing)
 * - File fingerprinting for duplicate detection
 * - Virus scanning
 * - Size and quota validation
 * - Permission enforcement
 * - Image processing (resize, convert, compress)
 * - Observability and audit trails
 * 
 * Migration guide:
 * ```typescript
 * // Old way (DEPRECATED)
 * const file = await fileUploadService.execute({
 *   buffer,
 *   mimeType,
 *   originalName,
 *   folder,
 *   vendorId,
 * });
 * 
 * // New way (RECOMMENDED)
 * const [file] = await uploadIntakeService.execute({
 *   context: { userId, vendorId, role },
 *   files: [{ buffer, mimeType, originalName }],
 *   folder,
 * });
 * ```
 * 
 * Files are initially marked as orphaned until attached to an entity.
 * Owner fields (ownerType, ownerId) represent original uploader and are set once here.
 */
export class FileUploadService {
  constructor(
    private readonly storageProvider: IStorageProvider,
    private readonly fileRepository: IFileRepository
  ) {}

  /**
   * Upload file to storage and create DB record
   * @param command - Upload command with file buffer and metadata
   * @returns File domain entity (URL computed via storageProvider.getPublicUrl at read time)
   */
  async execute(command: UploadFileCommand): Promise<File> {
    // Upload to storage
    const result = await this.storageProvider.put(command.buffer, {
      mimeType: command.mimeType,
      folder: command.folder,
      filename: command.originalName,
    });

    // Create file record
    const file = await this.fileRepository.create({
      key: result.key,
      provider: 'local', // TODO: Pass provider type from config or detect from storageProvider
      mimeType: result.mimeType,
      size: result.size,
      checksum: result.checksum,
      originalName: command.originalName,
      isOrphan: true, // initially orphaned until attached
      ownerType: command.vendorId ? 'vendor' : 'system',
      ownerId: command.vendorId,
      deletedAt: null,
      purgeAt: null,
    });

    return file;
  }
}
