import { IFileRepository } from '../../catalog/repositories/interfaces/file.repository.interface';
import { FileDeleteService } from '../../catalog/domain/services/media/FileDeleteService';
import { FileCleanupConfig, daysAgo } from '../../../config/file-cleanup.config';
import { DigitalEntitlementGuard } from './DigitalEntitlementGuard';
import { CleanupAuditRepository } from '../repositories/cleanup-audit.repository';

export interface DeleteStageResult {
  filesDeleted: number;
  skippedProtected: number;
  failed: number;
}

/**
 * LonelyFileDeletionService — Stage B.
 *
 * Permanently deletes files that have had no live references ("lonely") for
 * `lonelyGraceDays`. The lonely clock is File.orphanedAt (set when the last
 * reference was removed), falling back to createdAt for files that were uploaded
 * but never attached — so this also reclaims abandoned uploads.
 *
 * Deletion goes through FileDeleteService, which removes the physical object and
 * hard-deletes the record. The entitlement guard is applied as a final safety
 * net: a file backing a live customer download is never deleted, even if it
 * somehow appears lonely.
 */
export class LonelyFileDeletionService {
  constructor(
    private readonly fileRepository: IFileRepository,
    private readonly fileDeleteService: FileDeleteService,
    private readonly guard: DigitalEntitlementGuard,
    private readonly audit: CleanupAuditRepository,
    private readonly config: FileCleanupConfig,
  ) {}

  async run(sweepId: string, now: Date = new Date()): Promise<DeleteStageResult> {
    const cutoff = daysAgo(this.config.lonelyGraceDays, now);
    const result: DeleteStageResult = { filesDeleted: 0, skippedProtected: 0, failed: 0 };

    const lonelyFiles = await this.fileRepository.findLonely(cutoff, this.config.batchSize);

    for (const file of lonelyFiles) {
      const vendorId = file.ownerType === 'vendor' ? file.ownerId : undefined;

      if (this.config.protectDigitalEntitlements && (await this.guard.isProtected(file.id))) {
        await this.audit.record({
          sweepId,
          stage: 'lonely_delete',
          action: 'skip',
          dryRun: this.config.dryRun,
          fileId: file.id,
          vendorId,
          reason: 'protected: live customer download entitlement',
        });
        result.skippedProtected += 1;
        continue;
      }

      if (this.config.dryRun) {
        await this.audit.record({
          sweepId,
          stage: 'lonely_delete',
          action: 'delete',
          dryRun: true,
          fileId: file.id,
          vendorId,
          reason: `lonely ≥ ${this.config.lonelyGraceDays}d`,
          metadata: { size: file.size, key: file.key },
        });
        result.filesDeleted += 1;
        continue;
      }

      try {
        await this.fileDeleteService.execute({ fileId: file.id });
        await this.audit.record({
          sweepId,
          stage: 'lonely_delete',
          action: 'delete',
          dryRun: false,
          fileId: file.id,
          vendorId,
          reason: `lonely ≥ ${this.config.lonelyGraceDays}d`,
          metadata: { size: file.size, key: file.key },
        });
        result.filesDeleted += 1;
      } catch (error) {
        result.failed += 1;
        await this.audit.record({
          sweepId,
          stage: 'lonely_delete',
          action: 'skip',
          dryRun: false,
          fileId: file.id,
          vendorId,
          reason: `delete failed: ${(error as Error)?.message ?? 'unknown error'}`,
        });
      }
    }

    return result;
  }
}
