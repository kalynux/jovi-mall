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
export * from './media-folder';

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
//
// ⚠ `MockScanner` is deliberately NOT re-exported. It is a TEST DOUBLE that returns
// `{ clean: true }` for every byte, and it reached the digital-products upload path — the tree
// whose files travel furthest, behind a download token, to a paying stranger — precisely
// because it was importable from the production barrel (ADR-A01 D-1 / D-6). The suites import
// it from `./scanners/mock-scanner` directly; nothing in `src/` may.
//
// `resolveVirusScanner` is the ONLY way a scanner is constructed in the runtime path, and
// `test:uploads` asserts that by source scan.
export * from './scanners/index';

// Observers
export * from './observers/logging-observer';
export * from './observers/noop-observer';
