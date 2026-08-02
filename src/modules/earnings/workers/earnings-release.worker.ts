import cron from 'node-cron';
import { transactionManager } from '../../../core/database/transaction.manager';
import { EarningsAllocationRepository } from '../repositories/earnings-allocation.repository';
import { EarningsAccountRepository } from '../repositories/earnings-account.repository';
import { EarningsAccountService, earningsAccountService } from '../services/earnings-account.service';
import { earningsSplitService } from '../services/earnings-split.service';
import { PayoutRequestRepository } from '../repositories/payout-request.repository';
import { payoutRequestService } from '../services/payout-request.service';
import { OrderModel } from '../../orders/order.model';
import { OrderCompletionService, orderCompletionService } from '../../orders/order-completion.service';
import { ShipmentService } from '../../shipments/shipment.service';
import { ShipmentRepository } from '../../shipments/shipment.repository';
import { EARNINGS_CONFIG, daysAgo } from '../config/earnings.config';
import { IEarningsAllocation, EarningsAllocationModel } from '../models/earnings-allocation.model';
import { EarningsReserveHoldModel } from '../models/earnings-reserve-hold.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { COD_CONFIG, daysFromNow } from '../../cod/config/cod.config';
import { codDiscrepancyService } from '../../cod/services/cod-discrepancy.service';
import { ActorRole } from '../../tickets/types/ticket.types';

/**
 * EarningsReleaseWorker - daily sweep with idempotent stages:
 *
 *  1. Auto-confirm: orders that reached `delivered`/`fulfilled` but were never
 *     confirmed by the customer within `AUTO_CONFIRM_DAYS` are auto-completed
 *     (which starts their escrow hold window).
 *  2. Release: held allocations whose `hold_release_at` has elapsed move from
 *     `pending_balance` to `available_balance` (withdrawable). COD-sourced
 *     allocations additionally require `cash_settled_at` (repo-level filter).
 *  3. COD split recovery: `collected` CashCollections older than an hour with
 *     no allocations get re-split (the post-collect split is best-effort).
 *  3b. Delivery split recovery: settled PREPAID shipments older than an hour
 *     with no allocations get re-split — same reason, the delivery-time split is
 *     equally best-effort.
 *  4. Reserve release: matured COD rolling-reserve holds move to available.
 *  5. Auto-payout: vendor/agency accounts whose `available_balance` reached
 *     `AUTO_PAYOUT_THRESHOLD` get a payout request opened on their behalf, so
 *     the platform never ends up owing an unbounded amount to one account.
 *
 * Lifecycle mirrors `PlanExpiryWorker`/`FileCleanupWorker` (node-cron, daily).
 * Every stage is safe to re-run: completion is guarded by `completion.confirmed_at`,
 * release by an atomic `held → released` claim, and the split by its
 * per-source idempotency index.
 */
export class EarningsReleaseWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;

  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly accountRepo: EarningsAccountRepository = new EarningsAccountRepository(),
    private readonly payoutRepo: PayoutRequestRepository = new PayoutRequestRepository(),
    private readonly orderCompletion: OrderCompletionService = orderCompletionService,
    private readonly shipments: ShipmentService = new ShipmentService(),
    private readonly shipmentRepo: ShipmentRepository = new ShipmentRepository()
  ) {}

  /** Schedule the daily sweep (default 01:00 server time). */
  start(): void {
    if (this.task) {
      console.log('[EarningsReleaseWorker] Already started');
      return;
    }
    this.task = cron.schedule(EARNINGS_CONFIG.CRON, () => {
      void this.runSweep();
    });
    console.log(`[EarningsReleaseWorker] Scheduled daily earnings sweep (${EARNINGS_CONFIG.CRON})`);
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run the full sweep once. Safe to call manually (tests/ops). */
  async runSweep(now: Date = new Date()): Promise<void> {
    console.log('[EarningsReleaseWorker] Starting earnings sweep');
    await this.autoConfirmStaleShipments(now);
    await this.autoConfirmStaleOrders(now);
    await this.releaseMaturedHolds(now);
    await this.recoverMissedCodSplits(now);
    await this.recoverMissedDeliverySplits(now);
    await this.releaseMaturedReserves(now);
    await this.autoTriggerPayoutsOverThreshold();
    console.log('[EarningsReleaseWorker] Earnings sweep complete');
  }

  /**
   * Stage 0 — auto-confirm shipments the customer never confirmed, once their
   * dispute window has elapsed.
   *
   * Runs BEFORE the order stage on purpose: confirming the last outstanding
   * shipment completes its order inside that same call, and anything left over
   * is picked up by the order stage immediately after — so a lapsed order
   * matures in one sweep rather than waiting a day per level.
   */
  private async autoConfirmStaleShipments(now: Date): Promise<void> {
    const cutoff = daysAgo(EARNINGS_CONFIG.SHIPMENT_AUTO_CONFIRM_DAYS, now);
    try {
      const confirmed = await this.shipments.autoConfirmStaleDeliveries(
        cutoff,
        EARNINGS_CONFIG.BATCH_SIZE
      );
      if (confirmed > 0) {
        console.log(
          `[EarningsReleaseWorker] Auto-confirmed ${confirmed} shipment(s) past the ${EARNINGS_CONFIG.SHIPMENT_AUTO_CONFIRM_DAYS}-day dispute window`
        );
      }
    } catch (error) {
      console.error('[EarningsReleaseWorker] Shipment auto-confirm stage failed:', error);
    }
  }

  /**
   * Stage 1 — auto-confirm settled orders the customer never confirmed.
   *
   * `partially_delivered` is in the candidate filter, not just `delivered`: an
   * order with one item delivered and one returned is finished and must still
   * complete, or its escrow is stranded forever. The status filter is only a
   * cheap index-backed pre-filter; `isSettled` decides, because "every item
   * terminal" is not expressible as a single fulfillment_status.
   */
  private async autoConfirmStaleOrders(now: Date): Promise<void> {
    const cutoff = daysAgo(EARNINGS_CONFIG.AUTO_CONFIRM_DAYS, now);
    const stale = await OrderModel.find({
      fulfillment_status: { $in: ['delivered', 'fulfilled', 'partially_delivered'] },
      'completion.confirmed_at': null,
      updated_at: { $lte: cutoff },
    }).limit(EARNINGS_CONFIG.BATCH_SIZE);

    for (const order of stale) {
      try {
        if (!this.orderCompletion.isSettled(order)) continue;
        await this.orderCompletion.complete(order, 'system', true);
      } catch (error) {
        console.error(
          `[EarningsReleaseWorker] Failed to auto-confirm order ${order._id.toString()}:`,
          error
        );
      }
    }
  }

  /** Stage 2 — release matured held allocations into available balances. */
  private async releaseMaturedHolds(now: Date): Promise<void> {
    const matured = await this.allocationRepo.findMaturedHeld(now, EARNINGS_CONFIG.BATCH_SIZE);

    for (const allocation of matured) {
      try {
        await transactionManager.runInTransaction(async (session) => {
          // Atomically claim the allocation; null means another sweep already
          // released/reversed it — skip to stay idempotent.
          const claimed = await this.allocationRepo.markReleased(allocation._id, new Date(), session);
          if (!claimed) return;

          // COD rolling reserve: a slice of each COD-sourced AGENCY release
          // parks in reserve_balance for RESERVE_DAYS as security against
          // cash discrepancies (the agency is the cash-accountable party).
          const reserveAmount = this.reserveAmountFor(claimed);
          if (reserveAmount > 0) {
            const account = await this.accounts.releaseWithReserveInSession(claimed, reserveAmount, session);
            await EarningsReserveHoldModel.create(
              [
                {
                  account_id: account._id,
                  owner_type: 'agency',
                  owner_id: claimed.beneficiary_id,
                  amount: reserveAmount,
                  currency: claimed.currency,
                  source_allocation_id: claimed._id,
                  status: 'held',
                  held_at: now,
                  release_at: daysFromNow(COD_CONFIG.RESERVE_DAYS, now),
                },
              ],
              { session }
            );
          } else {
            await this.accounts.releaseInSession(claimed, session);
          }
        });
      } catch (error) {
        console.error(
          `[EarningsReleaseWorker] Failed to release allocation ${allocation._id.toString()}:`,
          error
        );
      }
    }
  }

  /** Reserve slice for a released allocation: COD agency shares only. */
  private reserveAmountFor(allocation: IEarningsAllocation): number {
    if (!allocation.requires_cash_settlement) return 0;
    if (allocation.beneficiary_type !== 'agency' || !allocation.beneficiary_id) return 0;
    return Math.floor((allocation.amount * COD_CONFIG.RESERVE_PERCENT) / 100);
  }

  /**
   * Stage 4 — release matured reserve holds (reserve → available), but ONLY
   * while the agency has no open cash discrepancies: an unresolved shortfall
   * keeps its reserve parked (that is the reserve's purpose).
   */
  private async releaseMaturedReserves(now: Date): Promise<void> {
    const matured = await EarningsReserveHoldModel.find({
      status: 'held',
      release_at: { $lte: now },
    }).limit(EARNINGS_CONFIG.BATCH_SIZE);

    for (const hold of matured) {
      try {
        const agencyId = hold.owner_id.toString();
        if (await codDiscrepancyService.hasOpenForAgency(agencyId)) {
          continue; // stays parked until the discrepancy is resolved
        }

        const allocation = await EarningsAllocationModel.findById(hold.source_allocation_id);
        if (!allocation) {
          console.error(
            `[EarningsReleaseWorker] Reserve hold ${hold._id.toString()} references missing allocation ${hold.source_allocation_id.toString()}`
          );
          continue;
        }

        await transactionManager.runInTransaction(async (session) => {
          // Atomic claim keeps concurrent sweeps idempotent.
          const claimed = await EarningsReserveHoldModel.findOneAndUpdate(
            { _id: hold._id, status: 'held' },
            { $set: { status: 'released', released_at: new Date() } },
            { new: true, session }
          );
          if (!claimed) return;
          await this.accounts.releaseReserveInSession(allocation, claimed.amount, session);
        });
      } catch (error) {
        console.error(
          `[EarningsReleaseWorker] Failed to release reserve hold ${hold._id.toString()}:`,
          error
        );
      }
    }
  }

  /**
   * Stage 3 — re-split COD collections whose post-collect split never landed
   * (it is best-effort after the collect transaction). One hour of grace
   * avoids racing a split that is still in flight; the split's per-source
   * unique index keeps this idempotent.
   */
  private async recoverMissedCodSplits(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const candidates = await CashCollectionModel.find({
      status: 'collected',
      collected_at: { $lte: cutoff },
    })
      .sort({ collected_at: 1 })
      .limit(EARNINGS_CONFIG.BATCH_SIZE);

    for (const collection of candidates) {
      try {
        if (await this.allocationRepo.existsForSource('cod_collection', collection._id.toString())) {
          continue; // already split — the common case
        }
        const order = await OrderModel.findById(collection.order_id);
        if (!order) {
          console.error(
            `[EarningsReleaseWorker] COD collection ${collection._id.toString()} references missing order ${collection.order_id.toString()}`
          );
          continue;
        }
        await earningsSplitService.splitCodCollection(order, collection);
        console.log(
          `[EarningsReleaseWorker] Recovered missing COD split for collection ${collection._id.toString()}`
        );
      } catch (error) {
        console.error(
          `[EarningsReleaseWorker] Failed to recover COD split for collection ${collection._id.toString()}:`,
          error
        );
      }
    }
  }

  /**
   * Stage 3b — re-split PREPAID shipments whose delivery-time split never landed
   * (it is best-effort after the status-change transaction, exactly like the COD
   * one above).
   *
   * This is the safety net for the money an agent is owed on an online-paid
   * delivery: without it, one lost post-commit call means that agent and their
   * agency are simply never paid for that run, with nothing to notice it.
   *
   * `agent_delivered` is included alongside the terminal statuses because that is
   * where the split fires — waiting for `delivered` would leave a shipment
   * unrecovered for the whole customer-confirmation window. One hour of grace
   * avoids racing a split still in flight; the split's per-source unique index
   * keeps this idempotent, and `splitShipmentDelivery` returns early for COD.
   */
  private async recoverMissedDeliverySplits(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const candidates = await this.shipmentRepo.findSettledSince(
      ['agent_delivered', 'delivered', 'returned'],
      cutoff,
      EARNINGS_CONFIG.BATCH_SIZE
    );

    for (const shipment of candidates) {
      const shipmentId = (shipment._id as any).toString();
      try {
        if (await this.allocationRepo.existsForSource('shipment', shipmentId)) {
          continue; // already split — the common case
        }
        const order = await OrderModel.findById(shipment.order_id);
        if (!order) {
          console.error(
            `[EarningsReleaseWorker] Shipment ${shipmentId} references missing order ${shipment.order_id.toString()}`
          );
          continue;
        }
        if (order.payment_method === 'cash_on_delivery') continue; // COD is stage 3's business

        // `delivered` reached its terminal state THROUGH `agent_delivered`, so
        // both mean the run succeeded; only `returned` earns the rto rate.
        const outcome = shipment.status === 'returned' ? 'returned' : 'delivered';
        await earningsSplitService.splitShipmentDelivery(order, shipment, outcome);
        console.log(
          `[EarningsReleaseWorker] Recovered missing delivery split for shipment ${shipmentId}`
        );
      } catch (error) {
        console.error(
          `[EarningsReleaseWorker] Failed to recover delivery split for shipment ${shipmentId}:`,
          error
        );
      }
    }
  }

  /**
   * Stage 5 — vendor/agency accounts whose `available_balance` has reached
   * `AUTO_PAYOUT_THRESHOLD` get a payout request opened on their behalf,
   * exactly as if they'd called `POST .../earnings/payout` themselves (same
   * ticket + notification flow). Skips accounts that already have a pending
   * request (the "one at a time" rule already enforced for manual requests)
   * and requires `SUPPORT_ADMIN_USER_ID` to be configured as the acting admin
   * (same convention as `TicketService.createSystemTicket`) — logs and skips
   * entirely if it isn't, rather than failing the whole sweep.
   */
  private async autoTriggerPayoutsOverThreshold(): Promise<void> {
    const systemActorUserId = process.env.SUPPORT_ADMIN_USER_ID;
    if (!systemActorUserId) {
      console.warn(
        '[EarningsReleaseWorker] SUPPORT_ADMIN_USER_ID not configured — skipping auto-payout threshold sweep'
      );
      return;
    }

    const accounts = await this.accountRepo.findOverThreshold(EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD);

    for (const account of accounts) {
      // The platform account has no owner_id and nobody to pay itself; skip it
      // rather than let it fail the missing-payout-method check every sweep.
      if (account.owner_type === 'platform' || !account.owner_id) continue;

      const ownerType = account.owner_type as 'vendor' | 'agency' | 'agent';
      const ownerId = account.owner_id.toString();
      try {
        const pending = await this.payoutRepo.findPendingForOwner(ownerType, ownerId);
        if (pending) continue; // already being processed — wait for it to resolve

        await payoutRequestService.requestPayout(
          ownerType,
          ownerId,
          systemActorUserId,
          ActorRole.ADMIN,
          'auto_threshold'
        );
        console.log(
          `[EarningsReleaseWorker] Auto-triggered payout request for ${ownerType} ${ownerId} (balance over ${EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD})`
        );
      } catch (error) {
        // Most commonly EARNINGS_PAYOUT_METHOD_MISSING — the account has no
        // payout method configured yet, so there's nowhere to send funds.
        // Logged for ops follow-up; balance simply stays over threshold
        // until the vendor/agency configures one.
        console.error(
          `[EarningsReleaseWorker] Failed to auto-trigger payout for ${ownerType} ${ownerId}:`,
          error
        );
      }
    }
  }
}

export const earningsReleaseWorker = new EarningsReleaseWorker();
