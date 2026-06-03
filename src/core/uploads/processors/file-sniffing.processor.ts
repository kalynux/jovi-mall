import { fileTypeFromBuffer } from 'file-type';
import { IUploadProcessor, UploadPipelineContext } from '../upload-policy.types';
import { areMimeTypesEquivalent } from '../mime-aliases';

/**
 * File Sniffing Processor
 * 
 * SECURITY CRITICAL - RUNS FIRST
 * 
 * Detects real MIME type from file buffer using magic bytes.
 * NEVER trusts client-provided MIME types or file extensions.
 * 
 * Benefits:
 * - Prevents malicious files disguised as safe types (.exe as .jpg)
 * - Blocks polyglot attacks (files valid as multiple formats)
 * - Ensures MIME type validation is against actual content
 * - Protects against client-side tampering
 */
export class FileSniffingProcessor implements IUploadProcessor {
  async process(context: UploadPipelineContext): Promise<void> {
    context.addProcessingStep('FileSniffing');

    for (let i = 0; i < context.files.length; i++) {
      const fileContext = context.files[i];
      
      try {
        // Detect real MIME type from buffer
        const detected = await fileTypeFromBuffer(fileContext.buffer);
        
        if (!detected) {
          // Could not detect file type - might be plain text or unknown format
          // Keep original MIME type but mark as unverified
          context.addViolation({
            code: 'UNDETECTABLE_TYPE',
            message: `Could not detect file type from buffer. Claimed: ${fileContext.mimeType}`,
            fileIndex: i,
            metadata: {
              claimedMimeType: fileContext.mimeType,
              originalName: fileContext.originalName,
            },
          });
          continue;
        }

        const detectedMimeType = detected.mime;
        const claimedMimeType = fileContext.mimeType;

        // Override client-provided MIME type with detected type
        fileContext.mimeType = detectedMimeType;
        fileContext.wasSniffed = true;

        // Check for MIME type mismatch (potential spoofing).
        //
        // Only flag a TRUE mismatch — clients (especially Windows browsers)
        // routinely send a vendor/legacy synonym of the canonical sniffed type
        // (e.g. `application/x-zip-compressed` for a real `application/zip`).
        // Those describe identical bytes and must not be rejected. The
        // allowlist still validates against the detected type, so suppressing
        // synonym noise here cannot let a disallowed format through.
        if (!areMimeTypesEquivalent(claimedMimeType, detectedMimeType)) {
          context.addViolation({
            code: 'MIME_TYPE_MISMATCH',
            message: `MIME type mismatch detected. Claimed: ${claimedMimeType}, Actual: ${detectedMimeType}`,
            fileIndex: i,
            metadata: {
              claimedMimeType,
              detectedMimeType,
              originalName: fileContext.originalName,
              extension: detected.ext,
            },
          });
        }

        // Check for potential polyglot files
        // This is a basic check - more sophisticated polyglot detection would require
        // checking if file is valid as MULTIPLE formats simultaneously
        const suspiciousExtensions = ['exe', 'bat', 'cmd', 'sh', 'ps1', 'dll', 'so'];
        if (suspiciousExtensions.includes(detected.ext)) {
          context.addViolation({
            code: 'POLYGLOT_DETECTED',
            message: `Suspicious file extension detected: ${detected.ext}`,
            fileIndex: i,
            metadata: {
              detectedMimeType,
              extension: detected.ext,
              originalName: fileContext.originalName,
            },
          });
        }

      } catch (error: any) {
        // File sniffing failed - this is a critical security failure
        context.addViolation({
          code: 'UNDETECTABLE_TYPE',
          message: `File sniffing failed: ${error.message}`,
          fileIndex: i,
          metadata: {
            error: error.message,
            originalName: fileContext.originalName,
          },
        });
      }
    }
  }
}
