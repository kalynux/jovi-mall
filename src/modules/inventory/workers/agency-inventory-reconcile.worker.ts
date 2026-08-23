import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { INVENTORY_CONFIG } from '../config/inventory.config';
import {
  AgencyInventoryReconciler,
  agencyInventoryReconciler,
} from '../domain/services/agency-inventory-reconciler';

/**
 * AgencyInventoryReconcileWorker — rebuild every agency's stored-SKU roster, and repair any
 * counter that has drifted from its own movement ledger.
 *
 * ## Why this is a worker now
 *
 * Reconciliation used to run **debounced on the read path** (`reconcileIfStale`, 60 s), and
 * that was the right call while every row was pure configuration with a zero quantity: a
 * stale roster cost nothing, and an agency that had just connected a vendor saw the change on
 * their next page load rather than at 03:00.
 *
 * Step 14 makes both halves of that false. The pass now also walks the movement ledger, which
 * is not work to hang off a customer-facing GET; and an agency nobody happens to be looking at
 * is precisely the one whose roster and whose drift want checking. `INVENTORY_CONFIG` carries
 * the cadence reasoning.
 *
 * ## Two jobs, one pass, and the order matters
 *
 * **Reconcile first, then drift.** The reconcile can create rows; checking drift before it
 * would skip a row created in the same pass, and report it as clean for fifteen minutes. The
 * reverse costs nothing — a row created a moment ago has an empty ledger and zero counters,
 * which is not drift.
 *
 * One agency's failure never aborts the sweep, as in every other worker here.
 */
export class AgencyInventoryReconcileWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;
  private readonly schedule = INVENTORY_CONFIG.RECONCILE_CRON;

  get schedules(): WorkerSchedule[] {
    return [{ kind: 'cron', expression: this.schedule, source: 'AGENCY_INVENTORY_RECONCILE_CRON' }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return INVENTORY_CONFIG.RECONCILE_ENABLED;
  }

  constructor(
    private readonly reconciler: AgencyInventoryReconciler = agencyInventoryReconciler,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
  ) { }

  start(): void {
    if (this.task) {
      console.log('[AgencyInventoryReconcileWorker] Already started');
      return;
    }
    if (!this.enabled) {
      console.log('[AgencyInventoryReconcileWorker] Disabled by AGENCY_INVENTORY_RECONCILE_ENABLED');
      return;
    }
    this.task = cron.schedule(this.schedule, () => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    });
    console.log(`[AgencyInventoryReconcileWorker] Scheduled inventory reconcile (${this.schedule})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /**
   * One pass over every agency. Safe to call manually, and safe to call CONCURRENTLY — a
   * second caller is refused rather than queued (F-19).
   */
  async runSweep(): Promise<boolean> {
    const outcome = await withWorkerLock('agency-inventory-reconcile', async () => {
      this.sweeping = true;
      try {
        // Every agency, not only those that already hold rows: an arrangement made since the
        // last pass has no row yet, and it is exactly the one an agency is waiting to see.
        const agencyIds = await this.agencies.listAllIds();
        let upserted = 0;
        let retired = 0;
        let corrected = 0;
        let failed = 0;

        for (const agencyId of agencyIds) {
          try {
            const result = await this.reconciler.reconcile(agencyId);
            upserted += result.upserted;
            retired += result.retired;

            const drifted = await this.reconciler.correctDrift(agencyId);
            corrected += drifted.length;
            for (const drift of drifted) {
              // Loud on purpose. A counter that disagrees with its ledger means something
              // wrote it outside AgencyStockMovementRepository, and the repair itself leaves
              // no trace — this line is the only evidence that will exist.
              console.warn(
                `[AgencyInventoryReconcileWorker] DRIFT repaired on ${drift.stockLevelId}: ` +
                `on_hand ${drift.onHand}→${drift.ledgerOnHand}, ` +
                `reserved ${drift.reserved}→${drift.ledgerReserved}`,
              );
            }
          } catch (error) {
            failed++;
            console.error(`[AgencyInventoryReconcileWorker] Failed for agency ${agencyId}:`, error);
          }
        }

        console.log(
          `[AgencyInventoryReconcileWorker] ${agencyIds.length} agency(ies): ` +
          `${upserted} row(s) upserted, ${retired} retired, ${corrected} drift(s) repaired` +
          (failed > 0 ? `, ${failed} failed` : ''),
        );
      } catch (error) {
        console.error('[AgencyInventoryReconcileWorker] Sweep failed:', error);
      } finally {
        this.sweeping = false;
      }
    });
    return outcome !== SWEEP_SKIPPED;
  }
}

export const agencyInventoryReconcileWorker = new AgencyInventoryReconcileWorker();
