import { UploadPipelineContext, UploadRequest, FileContext, UploadPolicyViolation } from './upload-policy.types';

/**
 * Upload Pipeline Context
 * 
 * Mutable context that flows through the entire upload pipeline.
 * Processors and validators can read and modify file state.
 */
export class UploadPipelineContextImpl implements UploadPipelineContext {
  public readonly request: UploadRequest;
  public readonly startTime: Date;
  public files: FileContext[];
  public violations: UploadPolicyViolation[];
  public processingSteps: string[];

  constructor(request: UploadRequest) {
    this.request = request;
    this.startTime = new Date();
    this.violations = [];
    this.processingSteps = [];
    
    // Initialize file contexts
    this.files = request.files.map((fileInput) => ({
      // Original immutable properties
      originalBuffer: fileInput.buffer,
      originalMimeType: fileInput.mimeType,
      originalName: fileInput.originalName,
      
      // Current mutable state
      buffer: fileInput.buffer,
      mimeType: fileInput.mimeType,
      size: fileInput.buffer.length,
      
      // Computed properties (set by processors)
      hash: undefined,
      dimensions: undefined,
      
      // Processing flags
      wasSniffed: false,
      wasFingerprinted: false,
      wasResized: false,
      wasConverted: false,
      wasCompressed: false,
      
      // Storage results
      storageKey: undefined,
      checksum: undefined,
    }));
  }

  /**
   * Add a violation to the context
   */
  addViolation(violation: UploadPolicyViolation): void {
    this.violations.push(violation);
  }

  /**
   * Add multiple violations
   */
  addViolations(violations: UploadPolicyViolation[]): void {
    this.violations.push(...violations);
  }

  /**
   * Check if context has any violations
   */
  hasViolations(): boolean {
    return this.violations.length > 0;
  }

  /**
   * Add a processing step for audit trail
   */
  addProcessingStep(step: string): void {
    this.processingSteps.push(step);
  }

  /**
   * Get total size of all files
   */
  getTotalSize(): number {
    return this.files.reduce((sum, file) => sum + file.size, 0);
  }

  /**
   * Get file count
   */
  getFileCount(): number {
    return this.files.length;
  }

  /**
   * Get user ID from context
   */
  getUserId(): string {
    return this.request.context.userId;
  }

  /**
   * Get vendor ID from context (if applicable)
   */
  getVendorId(): string | undefined {
    return this.request.context.vendorId;
  }

  /**
   * Get user role
   */
  getUserRole(): string {
    return this.request.context.role;
  }

  /**
   * Get the request's folder strategy — a concrete folder, or `'by-type'` when
   * each file is filed under its own media type (resolved at storage time).
   */
  getFolder(): string {
    return this.request.folder;
  }
}
