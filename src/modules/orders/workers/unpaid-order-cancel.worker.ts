import cron from 'node-cron';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { OrderModel } from '../order.model';
import { OrderService } from '../order.service';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';
import { UNPAID_ORDER_CANCEL_CONFIG, daysAgo } from '../config/unpaid-order-cancel.config';

/**
 * UnpaidOrderCancelWorker - daily idempotent sweep that cancels orders left
 * unpaid past each vendor's `auto_cancel_unpaid_days` window.
 *
 * Stock is not reserved at order creation, so cancellation is a clean status
 * change + notification (see `OrderService.cancelOrder`). The sweep pre-filters
 * to orders unpaid for at least a day, then applies the per-vendor day cutoff
 * (cached within a run). Lifecycle mirrors `EarningsReleaseWorker` (node-cron,
 * daily) and is safe to re-run: `cancelOrder` no-ops on already-cancelled orders.
 */
export class UnpaidOrderCancelWorker implements ObservableWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private sweeping = false;

  get schedules(): WorkerSchedule[] {
    return [{
      kind: 'cron',
      expression: UNPAID_ORDER_CANCEL_CONFIG.CRON,
      source: 'UNPAID_ORDER_CANCEL_CRON',
    }];
  }

  get scheduled(): boolean {
    return this.task !== null;
  }

  /** Observation only — no overlap guard. See `ObservableWorker`. */
  get executing(): boolean {
    return this.sweeping;
  }

  get enabled(): boolean {
    return UNPAID_ORDER_CANCEL_CONFIG.ENABLED;
  }

  constructor(
    private readonly orderService: OrderService = new OrderService(),
    private readonly settingsRepo: VendorSettingsRepository = new VendorSettingsRepository()
  ) {}

  /** Schedule the daily sweep (default 05:00 server time). */
  start(): void {
    if (this.task) {
      console.log('[UnpaidOrderCancelWorker] Already started');
      return;
    }
    if (!UNPAID_ORDER_CANCEL_CONFIG.ENABLED) {
      console.log('[UnpaidOrderCancelWorker] Disabled via config — not scheduling');
      return;
    }
    this.task = cron.schedule(UNPAID_ORDER_CANCEL_CONFIG.CRON, () => {
      if (maintenanceBlocksWorkers()) return;
      void this.runSweep();
    });
    console.log(
      `[UnpaidOrderCancelWorker] Scheduled daily unpaid-order sweep (${UNPAID_ORDER_CANCEL_CONFIG.CRON})`
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run the sweep once. Safe to call manually (tests/ops). */
  async runSweep(now: Date = new Date()): Promise<void> {
    // Flag only — deliberately NOT an early return. See `ObservableWorker`.
    this.sweeping = true;
    try {
      await this.sweepCandidates(now);
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepCandidates(now: Date): Promise<void> {
    console.log('[UnpaidOrderCancelWorker] Starting unpaid-order sweep');

    // Cheap pre-filter: anything unpaid for less than a day can't have crossed
    // even the smallest (1-day) vendor window. COD orders are excluded — they
    // are unpaid until delivery BY DESIGN; the failed-delivery flow owns their
    // terminal states, not this sweep.
    const candidates = await OrderModel.find({
      payment_status: { $in: ['pending', 'AWAITING_PAYMENT'] },
      payment_method: { $ne: 'cash_on_delivery' },
      fulfillment_status: { $ne: 'cancelled' },
      created_at: { $lte: daysAgo(1, now) },
    }).limit(UNPAID_ORDER_CANCEL_CONFIG.BATCH_SIZE);

    const daysCache = new Map<string, number>();
    let cancelled = 0;

    for (const order of candidates) {
      const vendorId = order.vendor_id.toString();
      let days = daysCache.get(vendorId);
      if (days === undefined) {
        days = await this.settingsRepo.getAutoCancelUnpaidDays(vendorId);
        daysCache.set(vendorId, days);
      }

      // Per-vendor cutoff: skip orders not yet old enough for this vendor.
      if (order.created_at > daysAgo(days, now)) continue;

      if (UNPAID_ORDER_CANCEL_CONFIG.DRY_RUN) {
        console.log(
          `[UnpaidOrderCancelWorker] [dry-run] would cancel order ${order._id.toString()} (vendor ${vendorId}, unpaid > ${days}d)`
        );
        continue;
      }

      try {
        await this.orderService.cancelOrder(order, {
          actorType: 'system',
          actorId: null,
          reason: `Auto-cancelled: unpaid for more than ${days} day(s)`,
        });
        cancelled++;
      } catch (error) {
        console.error(
          `[UnpaidOrderCancelWorker] Failed to cancel order ${order._id.toString()}:`,
          error
        );
      }
    }

    console.log(`[UnpaidOrderCancelWorker] Sweep complete — cancelled ${cancelled} order(s)`);
  }
}

export const unpaidOrderCancelWorker = new UnpaidOrderCancelWorker();
