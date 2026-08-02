import { UploadRequest, UploadPolicyViolationError, IUploadObserver, IVirusScanner, IUploadProcessor } from './upload-policy.types';
import { UploadPolicyConfig } from './upload-config';
import { UploadPipelineContextImpl } from './upload-pipeline-context';
import { UploadPolicyEngine } from './upload-policy-engine';
import { resolveTypeFolder } from './media-folder';
import { ImageResizeProcessor } from './processors/image-resize.processor';
import { ImageFormatConvertProcessor } from './processors/image-format-convert.processor';
import { ImageCompressProcessor } from './processors/image-compress.processor';
import { IStorageProvider } from '../storage/storage-provider.interface';
import { IFileRepository } from '../../modules/catalog/repositories/interfaces/file.repository.interface';
import { File } from '../../modules/catalog/repositories/mappers/file.mapper';

/**
 * Upload Intake Service
 * 
 * MAIN ENTRY POINT for all file uploads.
 * This is the ONLY way to upload files in the application.
 * 
 * Flow:
 * 1. Create pipeline context
 * 2. Validate via UploadPolicyEngine (includes file sniffing + fingerprinting)
 * 3. Run image processors (resize, convert, compress)
 * 4. Upload to storage provider
 * 5. Create File records in database
 * 6. Return uploaded File entities
 * 
 * All storage provider calls MUST go through this service.
 */
export class UploadIntakeService {
  private policyEngine: UploadPolicyEngine;
  private imageProcessors: IUploadProcessor[];

  constructor(
    private readonly config: UploadPolicyConfig,
    private readonly storageProvider: IStorageProvider,
    private readonly fileRepository: IFileRepository,
    private readonly observer: IUploadObserver,
    private readonly virusScanner: IVirusScanner
  ) {
    // Initialize policy engine
    this.policyEngine = new UploadPolicyEngine(
      config,
      fileRepository,
      virusScanner,
      observer
    );

    // Initialize image processors
    this.imageProcessors = [
      new ImageResizeProcessor(config),
      new ImageFormatConvertProcessor(config),
      new ImageCompressProcessor(config),
    ];
  }

  /**
   * Execute file upload with full security pipeline
   * 
   * @param request - Upload request with context and files
   * @returns Array of created File entities
   * @throws {UploadPolicyViolationError} if validation fails
   */
  async execute(request: UploadRequest): Promise<File[]> {
    // Create pipeline context
    const context = new UploadPipelineContextImpl(request);

    try {
      // Phase 1: Validation (includes file sniffing + fingerprinting)
      await this.policyEngine.validate(context);

      // Phase 2: Processing
      await this.observer.onProcessingStarted?.(context);

      for (const processor of this.imageProcessors) {
        await processor.process(context);
      }

      // Notify after each file processed
      for (let i = 0; i < context.files.length; i++) {
        await this.observer.onFileProcessed?.(context, i);
      }

      // Phase 3: Storage
      await this.observer.onStorageStarted?.(context);

      const uploadedFiles: File[] = [];

      for (const fileContext of context.files) {
        // A purpose folder applies to the whole request; 'by-type' files each
        // upload under the folder for its own media type. Resolved here (after
        // processing) so it reflects the DETECTED — and, for a converted image,
        // the final — MIME type rather than what the client claimed.
        const folder =
          request.folder === 'by-type'
            ? resolveTypeFolder(fileContext.mimeType)
            : request.folder;

        // Upload to storage provider
        const storageResult = await this.storageProvider.put(fileContext.buffer, {
          mimeType: fileContext.mimeType,  // Use detected MIME type
          folder,
          filename: fileContext.originalName,
        });

        // Store storage key in context
        fileContext.storageKey = storageResult.key;
        fileContext.checksum = storageResult.checksum;

        // Create File record in database
        const file = await this.fileRepository.create({
          key: storageResult.key,
          provider: this.getProviderType(),
          mimeType: fileContext.mimeType,  // Detected MIME type
          size: fileContext.size,
          checksum: fileContext.hash || storageResult.checksum,  // Use fingerprint hash if available
          originalName: fileContext.originalName,
          // Prefer the explicit per-role owner resolved by the api layer; fall
          // back to the legacy vendor-only stamping for callers that don't set it.
          ownerType: request.context.ownerType ?? (request.context.vendorId ? 'vendor' : 'system'),
          ownerId: request.context.ownerId ?? request.context.vendorId ?? undefined,
          deletedAt: null,
          purgeAt: null,
        });

        uploadedFiles.push(file);
      }

      // Phase 4: Completion
      await this.observer.onUploadCompleted?.(context, uploadedFiles.map(f => f.id));

      return uploadedFiles;

    } catch (error) {
      // Notify observer of failure
      await this.observer.onUploadFailed?.(context, error as Error);
      throw error;
    }
  }

  /**
   * Get storage provider type
   * TODO: Make this configurable or detect from storage provider
   */
  private getProviderType(): 'local' | 's3' | 'gcs' | 'r2' {
    // For now, return 'local' - should be configurable
    return 'local';
  }
}
