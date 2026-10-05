import type { RefundEarningsPort } from '../../payments/domain/refund-ports';
import { earningsClawbackService, EarningsClawbackService } from './earnings-clawback.service';
import { earningsPauseService, EarningsPauseService, PauseTarget, SYSTEM_PAUSE_ACTOR } from './earnings-pause.service';

/**
 * The earnings half of a refund request (REFUND-FLOW-PLAN § 6.5, § 11.2) — the implementation
 * of `RefundEarningsPort`, registered once at boot by `initializeRefundDomain()`
 * (`payments/refund.bootstrap.ts`). `RefundRequestService` reaches it only through the port, so
 * `payments` never imports `earnings` back (the require cycle the port exists to avoid).
 *
 * Three moments, and each is deliberately narrow:
 *
 *  - **opened** → pause with `refund_in_progress` (C-4). `pause()` is a compare-and-set on
 *    `active ≠ true`, so it is a NO-OP over an existing pause: a seller-cancel, a card dispute or
 *    an administrator's pause is never overwritten, and the refund simply waits behind it.
 *  - **closed without a refund** (rejected, or a create that failed after the pause) → resume,
 *    but ONLY a `refund_in_progress` pause. Anything else on the order stays exactly as it was.
 *  - **completed** → claw back by attribution (§ 6.2), THEN close the pause (`closeOnRefund`
 *    closes only `refund_in_progress | seller_cancelled_paid_order | booking_cancelled_unrefunded`).
 *    Money is recovered when the refund ARRIVES, never when it is accepted, so a failed transfer
 *    leaves nothing to undo. ⚠ If the clawback throws, the pause is deliberately NOT closed:
 *    paused money that should have been recovered is visible in the administrator's queue,
 *    released money that should have been recovered is not.
 */
export class RefundEarningsAdapter implements RefundEarningsPort {
  constructor(
    private readonly pauses: EarningsPauseService = earningsPauseService,
    private readonly clawback: EarningsClawbackService = earningsClawbackService
  ) {}

  /** True when THIS call raised the pause — `create` lifts only a pause it raised itself. */
  async onRequestOpened(target: PauseTarget, refundRequestId: string): Promise<boolean> {
    const outcome = await this.pauses.pause(
      target,
      'refund_in_progress',
      SYSTEM_PAUSE_ACTOR,
      `Refund request ${refundRequestId} in progress`
    );
    return outcome.changed === true;
  }

  async onRequestClosedWithoutRefund(target: PauseTarget, refundRequestId: string): Promise<void> {
    await this.pauses.resume(
      target,
      SYSTEM_PAUSE_ACTOR,
      `Refund request ${refundRequestId} closed without a refund`,
      ['refund_in_progress']
    );
  }

  async onRefundCompleted(input: {
    refundKey: string;
    target: PauseTarget;
    attribution: { goods: number; delivery: number };
    codCollectionIds: string[];
  }): Promise<void> {
    await this.clawback.applyRefund({
      refundKey: input.refundKey,
      target: input.target,
      attribution: input.attribution,
      codCollectionIds: input.codCollectionIds.length > 0 ? input.codCollectionIds : undefined,
    });
    await this.pauses.closeOnRefund(input.target, `Refund ${input.refundKey} completed`);
  }
}

export const refundEarningsAdapter = new RefundEarningsAdapter();
