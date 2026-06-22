import { CleanupAuditModel, CleanupStage, CleanupAction } from '../models/cleanup-audit.model';

export interface CleanupAuditEntry {
  sweepId: string;
  stage: CleanupStage;
  action: CleanupAction;
  dryRun: boolean;
  fileId?: string;
  entityType?: string;
  entityId?: string;
  vendorId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persistence for cleanup audit rows. Best-effort: auditing must never throw and
 * break a sweep, so writes are swallowed-and-logged on failure.
 */
export class CleanupAuditRepository {
  async record(entry: CleanupAuditEntry): Promise<void> {
    try {
      await CleanupAuditModel.create({
        sweepId: entry.sweepId,
        stage: entry.stage,
        action: entry.action,
        dryRun: entry.dryRun,
        fileId: entry.fileId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        vendorId: entry.vendorId,
        reason: entry.reason,
        metadata: entry.metadata,
      });
    } catch (error) {
      console.error('[CleanupAudit] Failed to record audit entry:', error);
    }
  }
}
