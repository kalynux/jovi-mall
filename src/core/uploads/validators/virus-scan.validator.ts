import { IUploadValidator, UploadPipelineContext, IVirusScanner } from '../upload-policy.types';
import { UploadPolicyConfig } from '../upload-config';

/**
 * Virus Scan Validator
 * 
 * Scans files for viruses using configured scanner.
 * Blocks upload if virus detected and blockOnFailure is enabled.
 */
export class VirusScanValidator implements IUploadValidator {
  constructor(
    private readonly config: UploadPolicyConfig,
    private readonly virusScanner: IVirusScanner
  ) {}

  async validate(context: UploadPipelineContext): Promise<void> {
    if (!this.config.virusScan.enabled) {
      return;
    }

    const scanResults: Array<{ fileIndex: number; clean: boolean }> = [];

    for (let i = 0; i < context.files.length; i++) {
      const fileContext = context.files[i];

      try {
        const result = await this.virusScanner.scan(
          fileContext.buffer,
          fileContext.originalName
        );

        scanResults.push({ fileIndex: i, clean: result.clean });

        if (!result.clean) {
          context.addViolation({
            code: 'VIRUS_DETECTED',
            message: `Virus detected: ${result.virus || result.reason || 'Unknown'}`,
            fileIndex: i,
            metadata: {
              virus: result.virus,
              reason: result.reason,
              originalName: fileContext.originalName,
            },
          });
        }

      } catch (error: any) {
        // Scan failure
        if (this.config.virusScan.blockOnFailure) {
          context.addViolation({
            code: 'VIRUS_DETECTED',
            message: `Virus scan failed: ${error.message}`,
            fileIndex: i,
            metadata: {
              error: error.message,
              originalName: fileContext.originalName,
            },
          });
        } else {
          // Log warning but don't block upload
          console.warn(`Virus scan failed for ${fileContext.originalName}:`, error.message);
        }
      }
    }

    // Note: Observer will be notified in UploadPolicyEngine
  }
}
