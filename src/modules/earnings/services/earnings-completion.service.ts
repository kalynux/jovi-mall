import { eventBus } from '../../../core/events/event-bus';
import { EarningsAllocationRepository } from '../repositories/earnings-allocation.repository';
import { EarningsSourceType } from '../models/earnings-allocation.model';
import { EARNINGS_CONFIG, daysFromNow } from '../config/earnings.config';

/**
 * EarningsCompletionService - reacts to an order/booking being completed
 * (customer confirmed delivery / satisfaction, or auto-confirmed).
 *
 * It stamps `completed_at` + `hold_release_at` (= completed_at + HOLD_DAYS) on
 * the source's still-`held` allocations. The release worker later moves matured
 * holds to the withdrawable balance. Idempotent: a second call is a no-op because
 * only rows with `completed_at: null` are touched.
 */
export class EarningsCompletionService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository()
  ) {}

  async onSourceCompleted(
    sourceType: EarningsSourceType,
    sourceId: string,
    completedAt: Date = new Date()
  ): Promise<void> {
    const holdReleaseAt = daysFromNow(EARNINGS_CONFIG.HOLD_DAYS, completedAt);
    const modified = await this.allocationRepo.markCompletedBySource(
      sourceType,
      sourceId,
      completedAt,
      holdReleaseAt
    );

    if (modified > 0) {
      try {
        await eventBus.publish('earnings.matured', {
          eventType: 'earnings.matured',
          aggregateId: sourceId,
          payload: { sourceType, sourceId, holdReleaseAt, allocationsTouched: modified },
          occurredAt: new Date(),
        });
      } catch (error) {
        console.error('[EarningsCompletionService] Failed to emit earnings.matured event:', error);
      }
    }
  }
}

export const earningsCompletionService = new EarningsCompletionService();
