import { shipmentAssignmentService } from '../domain/services/shipment-assignment.service';
import { ASSIGNMENT_CONFIG } from '../config/assignment.config';

/**
 * OfferExpiryWorker — the "Ignore ⇒ timeout" branch of the acceptance workflow.
 *
 * Polls on a short interval (well under the offer timeout) for pending offers
 * past their `expires_at`, expires each, and advances the assignment: an auto
 * offer moves to the next ranked candidate, a manual one returns the shipment to
 * the agency queue with a notification.
 *
 * setInterval, not node-cron: like the tracking dispatcher this is a sub-minute
 * cadence. Guarded so ticks never overlap.
 */
export class OfferExpiryWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) {
      console.log('[OfferExpiryWorker] Already started');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS);
    console.log(
      `[OfferExpiryWorker] Started (every ${ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS}ms; offer timeout ${ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS}s)`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Expire one batch of due offers. Guarded so ticks never overlap. */
  async sweepOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await shipmentAssignmentService.expireDueOffers();
      if (expired > 0) console.log(`[OfferExpiryWorker] Expired ${expired} offer(s)`);
    } catch (error) {
      console.error('[OfferExpiryWorker] Sweep failed:', error);
    } finally {
      this.running = false;
    }
  }
}

export const offerExpiryWorker = new OfferExpiryWorker();
