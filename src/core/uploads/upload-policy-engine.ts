import { UploadPipelineContext, UploadPolicyViolationError, IUploadValidator, IUploadObserver, IVirusScanner } from './upload-policy.types';
import { UploadPolicyConfig } from './upload-config';
import { UploadPipelineContextImpl } from './upload-pipeline-context';
import { FileSniffingProcessor } from './processors/file-sniffing.processor';
import { FileFingerprintProcessor } from './processors/file-fingerprint.processor';
import { PermissionValidator } from './validators/permission.validator';
import { FileCountValidator } from './validators/file-count.validator';
import { MimeTypeValidator } from './validators/mime-type.validator';
import { FileSizeValidator } from './validators/file-size.validator';
import { TotalSizeValidator } from './validators/total-size.validator';
import { VirusScanValidator } from './validators/virus-scan.validator';
import { DuplicateFileValidator } from './validators/duplicate-file.validator';
import { UserQuotaValidator } from './validators/user-quota.validator';
import { IFileRepository } from '../../modules/catalog/repositories/interfaces/file.repository.interface';

/**
 * Upload Policy Engine
 * 
 * Orchestrates the validation pipeline:
 * 1. File sniffing (detect real MIME type)
 * 2. Fingerprinting (compute hash)
 * 3. Run all validators
 * 4. Collect violations and throw if any found
 * 
 * Provides atomic validation - all files pass or all fail.
 */
export class UploadPolicyEngine {
  private validators: IUploadValidator[];
  private fileSniffingProcessor: FileSniffingProcessor;
  private fileFingerprintProcessor: FileFingerprintProcessor;

  constructor(
    private readonly config: UploadPolicyConfig,
    private readonly fileRepository: IFileRepository,
    private readonly virusScanner: IVirusScanner,
    private readonly observer: IUploadObserver
  ) {
    // Initialize processors
    this.fileSniffingProcessor = new FileSniffingProcessor();
    this.fileFingerprintProcessor = new FileFingerprintProcessor(config);

    // Initialize validators in execution order
    this.validators = [
      new PermissionValidator(config),
      new FileCountValidator(config),
      new MimeTypeValidator(config),
      new FileSizeValidator(config),
      new TotalSizeValidator(config),
      new VirusScanValidator(config, virusScanner),
      new DuplicateFileValidator(config, fileRepository),
      new UserQuotaValidator(config, fileRepository),
    ];
  }

  /**
   * Validate upload request
   * Runs file sniffing, fingerprinting, and all validators
   * 
   * @throws {UploadPolicyViolationError} if any validation fails
   */
  async validate(context: UploadPipelineContext): Promise<void> {
    // Notify observer: validation started
    await this.observer.onValidationStarted?.(context);

    try {
      // Step 1: File sniffing (SECURITY CRITICAL - runs first)
      await this.fileSniffingProcessor.process(context);

      // Step 2: Fingerprinting (compute hashes)
      await this.fileFingerprintProcessor.process(context);

      // Step 3: Run all validators
      for (const validator of this.validators) {
        await validator.validate(context);
      }

      // Check for violations
      if (context.hasViolations()) {
        // Notify observer: validation failed
        await this.observer.onValidationFailed?.(context, context.violations);
        throw new UploadPolicyViolationError(context.violations);
      }

      // Notify observer: validation passed
      await this.observer.onValidationPassed?.(context);

    } catch (error) {
      // If not already a violation error, wrap it
      if (!(error instanceof UploadPolicyViolationError)) {
        await this.observer.onUploadFailed?.(context, error as Error);
        throw error;
      }
      throw error;
    }
  }
}
