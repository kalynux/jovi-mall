/**
 * Upload Policy Types
 * 
 * Core types and interfaces for the upload security layer.
 * Defines contracts for validators, processors, observers, and error handling.
 */

/**
 * User role for permission validation
 */
export type UserRole = 'admin' | 'vendor' | 'user';

/**
 * Upload folder destinations
 */
export type UploadFolder = 'products' | 'variants' | 'digital' | 'videos' | 'system';

/**
 * Upload request context - who is uploading
 */
export interface UploadRequestContext {
  userId: string;
  vendorId?: string;
  role: UserRole;
}

/**
 * Individual file input
 */
export interface UploadFileInput {
  buffer: Buffer;
  mimeType: string;  // Client-provided MIME type (will be overridden by file sniffing)
  originalName?: string;
}

/**
 * Complete upload request
 */
export interface UploadRequest {
  context: UploadRequestContext;
  files: UploadFileInput[];
  folder: UploadFolder;
}

/**
 * Per-file context in the pipeline
 * Mutable - processors can modify these properties
 */
export interface FileContext {
  // Original input (immutable)
  readonly originalBuffer: Buffer;
  readonly originalMimeType: string;
  readonly originalName?: string;
  
  // Current state (mutable by processors)
  buffer: Buffer;
  mimeType: string;  // Detected MIME type (overridden by FileSniffingProcessor)
  size: number;
  
  // Computed properties
  hash?: string;  // SHA256 or MD5 hash
  dimensions?: {
    width: number;
    height: number;
  };
  
  // Processing flags
  wasSniffed: boolean;
  wasFingerprinted: boolean;
  wasResized: boolean;
  wasConverted: boolean;
  wasCompressed: boolean;
  
  // Storage result (set after upload)
  storageKey?: string;
  checksum?: string;
}

/**
 * Upload pipeline context
 * Flows through validators, processors, storage, and persistence
 */
export interface UploadPipelineContext {
  // Request-level immutable properties
  readonly request: UploadRequest;
  readonly startTime: Date;
  
  // File-level mutable contexts
  files: FileContext[];
  
  // Validation state
  violations: UploadPolicyViolation[];
  
  // Processing metadata
  processingSteps: string[];
  
  // Helper methods
  addViolation(violation: UploadPolicyViolation): void;
  addViolations(violations: UploadPolicyViolation[]): void;
  hasViolations(): boolean;
  addProcessingStep(step: string): void;
  getTotalSize(): number;
  getFileCount(): number;
  getUserId(): string;
  getVendorId(): string | undefined;
  getUserRole(): string;
  getFolder(): string;
}

/**
 * Policy violation error codes
 */
export type UploadPolicyViolationCode =
  | 'FILE_TOO_LARGE'
  | 'MIME_NOT_ALLOWED'
  | 'TOO_MANY_FILES'
  | 'QUOTA_EXCEEDED'
  | 'VIRUS_DETECTED'
  | 'PERMISSION_DENIED'
  | 'TOTAL_SIZE_EXCEEDED'
  | 'DUPLICATE_FILE'
  | 'MIME_TYPE_MISMATCH'
  | 'POLYGLOT_DETECTED'
  | 'UNDETECTABLE_TYPE';

/**
 * Individual policy violation
 */
export interface UploadPolicyViolation {
  code: UploadPolicyViolationCode;
  message: string;
  fileIndex?: number;  // If violation is for specific file
  metadata?: Record<string, any>;
}

/**
 * Upload policy violation error
 */
export class UploadPolicyViolationError extends Error {
  constructor(
    public readonly violations: UploadPolicyViolation[]
  ) {
    super(`Upload policy violated: ${violations.map(v => v.code).join(', ')}`);
    this.name = 'UploadPolicyViolationError';
  }
}

/**
 * Validator interface
 * Validates upload request against policy rules
 */
export interface IUploadValidator {
  /**
   * Validate the upload request
   * @throws {UploadPolicyViolationError} if validation fails
   */
  validate(context: UploadPipelineContext): Promise<void>;
}

/**
 * Processor interface
 * Processes files and modifies pipeline context
 */
export interface IUploadProcessor {
  /**
   * Process files in the pipeline context
   * Modifies context.files in place
   */
  process(context: UploadPipelineContext): Promise<void>;
}

/**
 * Virus scanner interface
 */
export interface IVirusScanner {
  /**
   * Scan a file buffer for viruses
   * @returns Result with clean status and optional reason
   */
  scan(buffer: Buffer, filename?: string): Promise<{
    clean: boolean;
    reason?: string;
    virus?: string;
  }>;
}

/**
 * Upload observer interface
 * Lifecycle hooks for monitoring, logging, and audit trails
 */
export interface IUploadObserver {
  onValidationStarted?(context: UploadPipelineContext): void | Promise<void>;
  onValidationFailed?(context: UploadPipelineContext, violations: UploadPolicyViolation[]): void | Promise<void>;
  onValidationPassed?(context: UploadPipelineContext): void | Promise<void>;
  onProcessingStarted?(context: UploadPipelineContext): void | Promise<void>;
  onFileProcessed?(context: UploadPipelineContext, fileIndex: number): void | Promise<void>;
  onVirusScanCompleted?(context: UploadPipelineContext, results: Array<{ fileIndex: number; clean: boolean }>): void | Promise<void>;
  onStorageStarted?(context: UploadPipelineContext): void | Promise<void>;
  onUploadCompleted?(context: UploadPipelineContext, fileIds: string[]): void | Promise<void>;
  onUploadFailed?(context: UploadPipelineContext, error: Error): void | Promise<void>;
}
