import { transactionManager } from '../../../core/database/transaction.manager';
import { EarningsAllocationRepository } from '../repositories/earnings-allocation.repository';
import { EarningsAccountService, earningsAccountService } from './earnings-account.service';
import { EarningsSourceType } from '../models/earnings-allocation.model';

/**
 * EarningsRefundService - reverses a source's escrow when it is refunded.
 *
 * Still-`held` allocations are reversed out of `pending_balance` (the money never
 * became withdrawable, so nothing is owed). Allocations that were ALREADY
 * released are left untouched and surfaced via a warning: clawing money back out
 * of an available balance is a manual/admin decision, not an automatic one.
 *
 * Idempotent and concurrency-safe: each allocation flips `held → reversed`
 * through an atomic conditional update, so a re-fired refund reverses nothing the
 * second time.
 */
export class EarningsRefundService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService
  ) {}

  async onRefund(sourceType: EarningsSourceType, sourceId: string): Promise<void> {
    const allAllocations = await this.allocationRepo.findBySource(sourceType, sourceId);
    if (allAllocations.length === 0) return;

    const alreadyReleased = allAllocations.filter((a) => a.status === 'released');
    if (alreadyReleased.length > 0) {
      console.warn(
        `[EarningsRefundService] ${alreadyReleased.length} allocation(s) for ${sourceType} ${sourceId} ` +
          `were already released; manual clawback required.`
      );
    }

    const held = allAllocations.filter((a) => a.status === 'held');
    if (held.length === 0) return;

    await transactionManager.runInTransaction(async (session) => {
      for (const allocation of held) {
        // Atomically claim the allocation; null means a concurrent reversal/release
        // already moved it — skip to stay idempotent.
        const claimed = await this.allocationRepo.markReversed(allocation._id, new Date(), session);
        if (!claimed) continue;
        await this.accounts.reverseInSession(allocation, false, session);
      }
    });
  }
}

export const earningsRefundService = new EarningsRefundService();
