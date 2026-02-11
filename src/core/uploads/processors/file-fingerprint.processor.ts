import * as crypto from 'crypto';
import { IUploadProcessor, UploadPipelineContext } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * File Fingerprint Processor
 * 
 * HIGH PRIORITY - RUNS SECOND (after file sniffing)
 * 
 * Computes cryptographic hash of file buffer for:
 * - Duplicate detection
 * - Abuse prevention
 * - Content-addressable storage
 * - Cache optimization
 * 
 * Supports SHA256 (default) and MD5 algorithms.
 */
export class FileFingerprintProcessor implements IUploadProcessor {
  constructor(private readonly config: UploadPolicyConfig) {}

  async process(context: UploadPipelineContext): Promise<void> {
    if (!this.config.fingerprinting.enabled) {
      return;
    }

    context.addProcessingStep('FileFingerprintting');

    const algorithm = this.config.fingerprinting.algorithm;

    for (const fileContext of context.files) {
      try {
        // Compute hash of original buffer (before any transformations)
        const hash = crypto
          .createHash(algorithm)
          .update(fileContext.buffer)
          .digest('hex');

        fileContext.hash = hash;
        fileContext.wasFingerprinted = true;

      } catch (error: any) {
        // Fingerprinting failure is not critical, but should be logged
        console.error(`Failed to compute ${algorithm} hash:`, error.message);
      }
    }
  }
}
