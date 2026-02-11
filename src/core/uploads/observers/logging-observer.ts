import { IUploadObserver, UploadPipelineContext, UploadPolicyViolation } from '../upload-policy.types';

/**
 * Logging Observer
 * 
 * Logs all upload lifecycle events with structured logging.
 * Production-ready implementation.
 */
export class LoggingObserver implements IUploadObserver {
  private logLevel: 'debug' | 'info' | 'warn' | 'error';

  constructor(logLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {
    this.logLevel = logLevel;
  }

  async onValidationStarted(context: UploadPipelineContext): Promise<void> {
    this.log('info', 'Upload validation started', {
      userId: context.getUserId(),
      vendorId: context.getVendorId(),
      role: context.getUserRole(),
      folder: context.getFolder(),
      fileCount: context.getFileCount(),
      totalSize: context.getTotalSize(),
    });
  }

  async onValidationFailed(context: UploadPipelineContext, violations: UploadPolicyViolation[]): Promise<void> {
    this.log('warn', 'Upload validation failed', {
      userId: context.getUserId(),
      vendorId: context.getVendorId(),
      violations: violations.map(v => ({
        code: v.code,
        message: v.message,
        fileIndex: v.fileIndex,
      })),
      violationCount: violations.length,
    });
  }

  async onValidationPassed(context: UploadPipelineContext): Promise<void> {
    this.log('info', 'Upload validation passed', {
      userId: context.getUserId(),
      fileCount: context.getFileCount(),
      totalSize: context.getTotalSize(),
    });
  }

  async onProcessingStarted(context: UploadPipelineContext): Promise<void> {
    this.log('debug', 'Upload processing started', {
      userId: context.getUserId(),
      fileCount: context.getFileCount(),
    });
  }

  async onFileProcessed(context: UploadPipelineContext, fileIndex: number): Promise<void> {
    const file = context.files[fileIndex];
    this.log('debug', 'File processed', {
      fileIndex,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      wasSniffed: file.wasSniffed,
      wasFingerprinted: file.wasFingerprinted,
      wasResized: file.wasResized,
      wasConverted: file.wasConverted,
      wasCompressed: file.wasCompressed,
    });
  }

  async onVirusScanCompleted(context: UploadPipelineContext, results: Array<{ fileIndex: number; clean: boolean }>): Promise<void> {
    const infectedCount = results.filter(r => !r.clean).length;
    
    if (infectedCount > 0) {
      this.log('error', 'Virus scan detected infected files', {
        userId: context.getUserId(),
        totalFiles: results.length,
        infectedCount,
        infectedIndexes: results.filter(r => !r.clean).map(r => r.fileIndex),
      });
    } else {
      this.log('debug', 'Virus scan completed - all clean', {
        fileCount: results.length,
      });
    }
  }

  async onStorageStarted(context: UploadPipelineContext): Promise<void> {
    this.log('debug', 'Storage upload started', {
      userId: context.getUserId(),
      fileCount: context.getFileCount(),
    });
  }

  async onUploadCompleted(context: UploadPipelineContext, fileIds: string[]): Promise<void> {
    const duration = Date.now() - context.startTime.getTime();
    
    this.log('info', 'Upload completed successfully', {
      userId: context.getUserId(),
      vendorId: context.getVendorId(),
      folder: context.getFolder(),
      fileCount: fileIds.length,
      totalSize: context.getTotalSize(),
      durationMs: duration,
      processingSteps: context.processingSteps,
    });
  }

  async onUploadFailed(context: UploadPipelineContext, error: Error): Promise<void> {
    const duration = Date.now() - context.startTime.getTime();
    
    this.log('error', 'Upload failed', {
      userId: context.getUserId(),
      vendorId: context.getVendorId(),
      folder: context.getFolder(),
      fileCount: context.getFileCount(),
      error: error.message,
      errorName: error.name,
      durationMs: duration,
    });
  }

  private log(level: string, message: string, data: any): void {
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentIndex = levels.indexOf(this.logLevel);
    const messageIndex = levels.indexOf(level);

    if (messageIndex >= currentIndex) {
      const logData = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data,
      };

      switch (level) {
        case 'debug':
          console.debug(JSON.stringify(logData));
          break;
        case 'info':
          console.info(JSON.stringify(logData));
          break;
        case 'warn':
          console.warn(JSON.stringify(logData));
          break;
        case 'error':
          console.error(JSON.stringify(logData));
          break;
      }
    }
  }
}
