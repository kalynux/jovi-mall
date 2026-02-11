/**
 * Upload Security Layer
 * 
 * Policy-driven file intake security layer with validators, processors, and observability.
 * All file uploads MUST go through UploadIntakeService.
 */

// Core types and interfaces
export * from './upload-policy.types';
export * from './upload-config';
export * from './upload-pipeline-context';

// Main services
export * from './upload-policy-engine';
export * from './upload-intake.service';

// Processors
export * from './processors/file-sniffing.processor';
export * from './processors/file-fingerprint.processor';
export * from './processors/image-resize.processor';
export * from './processors/image-format-convert.processor';
export * from './processors/image-compress.processor';

// Validators
export * from './validators/permission.validator';
export * from './validators/file-count.validator';
export * from './validators/total-size.validator';
export * from './validators/file-size.validator';
export * from './validators/mime-type.validator';
export * from './validators/virus-scan.validator';
export * from './validators/duplicate-file.validator';
export * from './validators/user-quota.validator';

// Scanners
export * from './scanners/mock-scanner';
export * from './scanners/clamav-scanner';

// Observers
export * from './observers/logging-observer';
export * from './observers/noop-observer';
