/**
 * Upload Policy Types
 *
 * Core types and interfaces for the upload security layer.
 * Defines contracts for validators, processors, observers, and error handling.
 */

import { FileOwnerType } from '../../modules/catalog/models/file.model';

/**
 * User role for permission validation
 */
export type UserRole = 'admin' | 'vendor' | 'user';

/**
 * Purpose folders — the caller already knows what the file is FOR, and the
 * folder therefore carries an access rule (see PermissionValidator).
 */
export type PurposeUploadFolder =
  | 'products'
  | 'variants'
  | 'digital'
  | 'system'
  | 'shipments'
  /**
   * The vendor's and the agency's `policies.documents` addenda (plan step 4.A.4c / 25.2).
   *
   * ⚠ **These two existed on disk long before they existed here.** Both endpoints wrote to
   * them through `storageProvider.put`, whose `folder` option is a loose string — so a tree
   * accumulated real files while the pipeline's own vocabulary had never heard of it, which
   * is precisely how the upload path that skipped every check stayed invisible. Naming them
   * in the union is what makes the compiler agree with the disk.
   */
  | 'vendor-policy-documents'
  | 'agency-policy-documents'
  /**
   * Identity-verification documents for a vendor, an agency or an agent — a scan of a
   * national identity card, front and back, a photograph of the holder's face beside it, an
   * agent's vehicle with its rider, and the hand-drawn address sketches.
   *
   * ⚠ **PRIVATE**, classified in `core/storage/storage-trees.ts` and in wi-admin's verbatim
   * copy of that table. A misclassification here is not a broken thumbnail: it is an
   * identity-theft kit served from a static mount at a URL that works forever.
   */
  | 'kyc'
  /**
   * Identity evidence for a member of PLATFORM STAFF — an administrator's own identity card,
   * the selfie holding it, a photograph of their front door and a sketch of how to reach it.
   *
   * ⚠ **PRIVATE**, and deliberately a SEPARATE tree from `kyc` above rather than a reuse of
   * it. The two hold the same kind of document about different subjects: `kyc` holds
   * applicants the platform is deciding whether to admit, this holds employees whose
   * documents are an employment record — a different legal basis, a different retention
   * clock, and a different answer to "export everything you hold about me". Sharing a tree
   * would silently apply any policy written for either to both.
   *
   * ⚠ Nothing in THIS service records what these files depict. The slot, the identity number,
   * the salary and every other employee fact live in wi-admin's private database. See
   * `modules/staff-identity/`.
   */
  | 'admin-identity';

/**
 * Type folders — derived from the file's own (sniffed) media type rather than
 * from a purpose. One per `MediaCategory`; see `resolveTypeFolder`.
 */
export type TypeUploadFolder = 'images' | 'videos' | 'audio' | 'documents' | 'archives' | 'other';

/**
 * Upload folder destinations
 */
export type UploadFolder = PurposeUploadFolder | TypeUploadFolder;

/**
 * How a request picks its destination folder.
 *
 * A concrete `UploadFolder` applies to every file in the request. `'by-type'`
 * means the caller does NOT know what the files are for — the general media
 * intake (`POST /api/files/upload`), where the same batch may hold an avatar, a
 * logo and a PDF, and the purpose is only decided later when the returned id is
 * attached. Each file is then stored under the folder for its own media type,
 * exactly as the video route stores videos under `videos/`.
 */
export type UploadFolderStrategy = UploadFolder | 'by-type';

/**
 * Upload request context - who is uploading
 */
export interface UploadRequestContext {
  userId: string;
  vendorId?: string;
  role: UserRole;
  /**
   * Original-uploader identity stamped onto the created File (`File.ownerType` /
   * `File.ownerId`). Resolved by the api layer from the authenticated role +
   * role_entity so every role owns its own uploads — this is what lets the
   * file-reference layer authorize an attach (see FileReferenceService
   * assertAttachable) and keeps per-owner storage aggregates honest. When
   * omitted, falls back to the legacy vendor-only stamping.
   */
  ownerType?: FileOwnerType;
  ownerId?: string;
  /**
   * Plan-driven storage cap (bytes) for this owner. When set, the
   * UserQuotaValidator enforces it instead of the static config default.
   * Resolved by the caller (api layer) so `core/` stays decoupled from billing.
   */
  storageLimitBytes?: number;
  /** Owner's current media usage (bytes) at request time, paired with the limit above. */
  currentUsageBytes?: number;
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
  /** Destination folder, or `'by-type'` to derive it per file. */
  folder: UploadFolderStrategy;
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
