import cron from 'node-cron';
import { randomUUID } from 'crypto';
import { getStorageProvider } from '../../../core/storage';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileDeleteService } from '../../catalog/domain/services/media/FileDeleteService';
import { FileCleanupConfig, loadFileCleanupConfig } from '../../../config/file-cleanup.config';
import { DigitalEntitlementGuard } from '../services/DigitalEntitlementGuard';
import { CleanupAuditRepository } from '../repositories/cleanup-audit.repository';
import { StorageUsageService } from '../services/StorageUsageService';
import { ProductInactivityDetachService } from '../services/ProductInactivityDetachService';
import { TicketAttachmentCleanupService } from '../services/TicketAttachmentCleanupService';
import { LonelyFileDeletionService } from '../services/LonelyFileDeletionService';
import { StorageAlertService } from '../services/StorageAlertService';

/**
 * FileCleanupWorker — daily storage-lifecycle sweep.
 *
 * Runs the stages in dependency order so a file detached this run can become
 * lonely and (after its grace period) be deleted on a later run:
 *   1. product-media detach   (inactive products)
 *   2. ticket-attachment detach (terminal tickets)
 *   3. lonely-file delete      (Stage B — permanent deletion)
 *   4. storage alerts          (notify vendors near their cap)
 *
 * Mirrors the billing PlanExpiryWorker (node-cron, daily, idempotent). Honors the
 * master switch, per-stage toggles and dryRun from FileCleanupConfig. `runSweep`
 * is safe to call manually for ops/verification.
 */
export class FileCleanupWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;

  private readonly config: FileCleanupConfig;
  private readonly productDetach: ProductInactivityDetachService;
  private readonly ticketDetach: TicketAttachmentCleanupService;
  private readonly lonelyDelete: LonelyFileDeletionService;
  private readonly storageAlert: StorageAlertService;

  constructor(config: FileCleanupConfig = loadFileCleanupConfig()) {
    this.config = config;

    const fileRepository = new FileRepositoryMongo();
    const fileReferenceRepository = new FileReferenceRepositoryMongo();
    const storageProvider = getStorageProvider();
    const fileDeleteService = new FileDeleteService(storageProvider, fileRepository, fileReferenceRepository);

    const guard = new DigitalEntitlementGuard();
    const audit = new CleanupAuditRepository();
    const storageUsage = new StorageUsageService();

    this.productDetach = new ProductInactivityDetachService(fileReferenceRepository, guard, audit, config);
    this.ticketDetach = new TicketAttachmentCleanupService(fileReferenceRepository, audit, config);
    this.lonelyDelete = new LonelyFileDeletionService(fileRepository, fileDeleteService, guard, audit, config);
    this.storageAlert = new StorageAlertService(storageUsage, audit, config);
  }

  /** Schedule the daily sweep per config.cron (default 04:00 server time). */
  start(): void {
    if (!this.config.enabled) {
      console.log('[FileCleanupWorker] Disabled (FILE_CLEANUP_ENABLED=false); not scheduling');
      return;
    }
    if (this.task) {
      console.log('[FileCleanupWorker] Already started');
      return;
    }
    this.task = cron.schedule(this.config.cron, () => {
      void this.runSweep();
    });
    console.log(
      `[FileCleanupWorker] Scheduled daily sweep (${this.config.cron})` +
        `${this.config.dryRun ? ' [DRY RUN]' : ''}`,
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run the full sweep once. Safe to call manually (tests/ops/verification). */
  async runSweep(now: Date = new Date()): Promise<void> {
    if (!this.config.enabled) {
      console.log('[FileCleanupWorker] Disabled; skipping sweep');
      return;
    }

    const sweepId = randomUUID();
    console.log(`[FileCleanupWorker] Starting sweep ${sweepId}${this.config.dryRun ? ' [DRY RUN]' : ''}`);

    if (this.config.stages.productDetach) {
      try {
        const r = await this.productDetach.run(sweepId, now);
        console.log('[FileCleanupWorker] product detach:', r);
      } catch (err) {
        console.error('[FileCleanupWorker] product detach failed:', err);
      }
    }

    if (this.config.stages.ticketDetach) {
      try {
        const r = await this.ticketDetach.run(sweepId, now);
        console.log('[FileCleanupWorker] ticket detach:', r);
      } catch (err) {
        console.error('[FileCleanupWorker] ticket detach failed:', err);
      }
    }

    if (this.config.stages.lonelyDelete) {
      try {
        const r = await this.lonelyDelete.run(sweepId, now);
        console.log('[FileCleanupWorker] lonely delete:', r);
      } catch (err) {
        console.error('[FileCleanupWorker] lonely delete failed:', err);
      }
    }

    if (this.config.stages.storageAlert) {
      try {
        const r = await this.storageAlert.run(sweepId, now);
        console.log('[FileCleanupWorker] storage alerts:', r);
      } catch (err) {
        console.error('[FileCleanupWorker] storage alerts failed:', err);
      }
    }

    console.log(`[FileCleanupWorker] Sweep ${sweepId} complete`);
  }
}

export const fileCleanupWorker = new FileCleanupWorker();
