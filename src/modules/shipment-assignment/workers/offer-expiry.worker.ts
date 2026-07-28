import { shipmentAssignmentService } from '../domain/services/shipment-assignment.service';
import { ASSIGNMENT_CONFIG } from '../config/assignment.config';

/**
 * AssignmentSweepWorker — the polling engine behind the acceptance workflow's
 * time-driven behaviour. Each tick does two independent jobs:
 *
 *   1. ADVANCE due auto-assignment sessions — a session whose 2-minute frontier
 *      window has elapsed offers the next ranked candidate (or re-nudges an
 *      ignored one in round 2, or gives up after the last round). This is the
 *      "Ignore ⇒ offer the next agent" branch of the requirement.
 *   2. EXPIRE due MANUAL offers — a one-shot agency pick nobody answered returns
 *      the shipment to the agency queue. (Auto offers never expire on timeout —
 *      an ignored agent keeps an acceptable offer; the session drives them.)
 *
 * setInterval, not node-cron: a sub-minute cadence, like the tracking dispatcher.
 * Guarded so ticks never overlap ON THIS INSTANCE; across instances, session
 * advancement is a guarded compare-and-set and manual expiry a guarded
 * transition, so several instances running this sweep cannot double-offer or
 * double-expire.
 */
export class AssignmentSweepWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer) {
      console.log('[AssignmentSweepWorker] Already started');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS);
    console.log(
      `[AssignmentSweepWorker] Started (every ${ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS}ms; offer timeout ${ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS}s, max ${ASSIGNMENT_CONFIG.MAX_ROUNDS} rounds)`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep: advance due sessions, then expire due manual offers. */
  async sweepOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const advanced = await shipmentAssignmentService.advanceDueSessions();
      if (advanced > 0) console.log(`[AssignmentSweepWorker] Advanced ${advanced} assignment session(s)`);
      const expired = await shipmentAssignmentService.expireDueOffers();
      if (expired > 0) console.log(`[AssignmentSweepWorker] Expired ${expired} manual offer(s)`);
    } catch (error) {
      console.error('[AssignmentSweepWorker] Sweep failed:', error);
    } finally {
      this.running = false;
    }
  }
}

export const assignmentSweepWorker = new AssignmentSweepWorker();

// Backwards-compatible aliases — the boot code imported `offerExpiryWorker`.
export const OfferExpiryWorker = AssignmentSweepWorker;
export const offerExpiryWorker = assignmentSweepWorker;
