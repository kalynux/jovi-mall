import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { INVENTORY_CONFIG } from '../config/inventory.config';
import {
  AgencyStorageInvoiceService,
  agencyStorageInvoiceService,
} from '../services/agency-storage-invoice.service';

/**
 * AgencyStorageInvoiceWorker — issue last month's storage statements.
 *
 * Monthly, on the 1st. It bills the **previous** UTC calendar month, so a run on
 * 2026-09-01 issues `2026-08`; `storage-period.ts` carries why the boundary is UTC.
 *
 * ⚠ **This is a RECORD-writing worker, not a money-moving one** (D-7). Nothing here
 * debits a wallet, credits an earnings account or schedules a payout, and nothing should
 * be added that does without reopening that decision — the statement exists so both sides
 * read one number, not so the platform becomes a party to the rent.
 *
 * Safe to trigger by hand and safe to run twice: the generator upserts on
 * `(agency, vendor, period)` and a second pass reports every statement as already issued.
 * That is what makes a mid-sweep restart a non-event.
 */
export class AgencyStorageInvoiceWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;
  private readonly schedule = INVENTORY_CONFIG.STORAGE_INVOICE_CRON;

  get schedules(): WorkerSchedule[] {
    return [{ kind: 'cron', expression: this.schedule, source: 'AGENCY_STORAGE_INVOICE_CRON' }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return INVENTORY_CONFIG.STORAGE_INVOICE_ENABLED;
  }

  constructor(
    private readonly invoices: AgencyStorageInvoiceService = agencyStorageInvoiceService,
  ) { }

  start(): void {
    if (this.task) {
      console.log('[AgencyStorageInvoiceWorker] Already started');
      return;
    }
    if (!this.enabled) {
      console.log('[AgencyStorageInvoiceWorker] Disabled by AGENCY_STORAGE_INVOICE_ENABLED');
      return;
    }
    this.task = cron.schedule(this.schedule, () => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    });
    console.log(`[AgencyStorageInvoiceWorker] Scheduled monthly storage invoicing (${this.schedule})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async runSweep(): Promise<boolean> {
    const outcome = await withWorkerLock('agency-storage-invoice', async () => {
      this.sweeping = true;
      try {
        const result = await this.invoices.runForPeriod(new Date());
        console.log(
          `[AgencyStorageInvoiceWorker] ${result.periodKey}: ` +
          `${result.invoicesCreated} issued, ${result.invoicesAlreadyIssued} already present, ` +
          `${result.agenciesVisited} agency(ies) visited, ` +
          `${result.agenciesSkippedNoPolicy} without a storage policy`,
        );
      } catch (error) {
        console.error('[AgencyStorageInvoiceWorker] Sweep failed:', error);
      } finally {
        this.sweeping = false;
      }
    });
    return outcome !== SWEEP_SKIPPED;
  }
}

export const agencyStorageInvoiceWorker = new AgencyStorageInvoiceWorker();
