import { registerRefundPorts } from './domain/refund-ports';
import { registerRefundCodSubscriber } from './services/refund-request.service';
import { refundEarningsAdapter } from '../earnings/services/refund-earnings.adapter';
import { codCoverageService } from '../cod/services/cod-coverage.service';

let initialized = false;

/**
 * Join the refund request to the two modules it must not import (REFUND-FLOW-PLAN § 11.2), and
 * subscribe the COD release. Called ONCE from `lifecycle.ts`, before the listener opens — the
 * same posture as `initializeNegotiationDomain()`, and imported by PATH there for the same
 * reason (a barrel import is how a require cycle turns into "X is not a constructor" at boot).
 *
 * ⚠ Not optional, and forgetting it is LOUD by design: `RefundRequestService` throws
 * `REFUND_PORT_NOT_REGISTERED` at the point of use rather than skipping the pause or the
 * clawback. A vendor refund on an instance that never ran this answers 500 — never "the customer
 * was paid and the vendor kept the money".
 *
 *  - `earnings`    → `RefundEarningsAdapter` (pause on open, resume on reject, claw + close on arrival);
 *  - `codCoverage` → `CodCoverageService.coverageForOrder` (what of an order's COD cash reached the platform);
 *  - `cod.collections.settled` → `refundRequestService.onCollectionsSettled` (a waiting COD refund
 *    sends the moment its cash is covered). The bus is lossy, so `RefundCashRecheckWorker`
 *    re-checks every `waiting_for_cash` request nightly.
 *
 * Idempotent: a second call registers nothing twice (the bus would otherwise run the release twice).
 */
export function initializeRefundDomain(): void {
  if (initialized) return;
  registerRefundPorts({ earnings: refundEarningsAdapter, codCoverage: codCoverageService });
  registerRefundCodSubscriber();
  initialized = true;
}
