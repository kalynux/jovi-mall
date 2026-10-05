import type { PauseTarget } from '../../earnings/services/earnings-pause.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * The ports `RefundRequestService` needs from modules it must not import (REFUND-FLOW-PLAN
 * § 11.2 — the contract between the parallel workstreams). refund-core DEFINES them; wave 2
 * implements them and calls `registerRefundPorts(...)` once at boot.
 *
 * ── Why ports, not imports ─────────────────────────────────────────────────────
 * `earnings` and `cod` both already import from `payments` (merchant references, the gateway
 * registry, payout routing). A direct import back would close a require cycle — the shape that
 * has crashed this service at boot before ("AuthService is not a constructor"). The negotiated
 * price seam (`catalog/domain/ports/negotiated-price.port.ts`) is the precedent.
 *
 * ── Why a missing port THROWS ─────────────────────────────────────────────────
 * `RefundRequestService` throws `REFUND_PORT_NOT_REGISTERED` at the point of use and never
 * silently skips. A skipped earnings recovery is money paid to a vendor that the platform has
 * already handed back to the customer — the failure nobody reports as a bug.
 */

export interface RefundEarningsPort {
  /**
   * A request opened for an order/booking: pause its earnings with reason 'refund_in_progress'.
   * Resolves `true` when THIS call raised the pause (false/undefined: a pause already stood —
   * someone else's, which a failed create must never lift; review finding 7).
   */
  onRequestOpened(target: PauseTarget, refundRequestId: string): Promise<boolean | void>;
  /** Rejected, or failed and abandoned: resume, ONLY if the active pause reason is 'refund_in_progress'. */
  onRequestClosedWithoutRefund(target: PauseTarget, refundRequestId: string): Promise<void>;
  /** Money arrived: claw back by attribution, then close the pause. */
  onRefundCompleted(input: {
    refundKey: string;
    target: PauseTarget;
    attribution: { goods: number; delivery: number };
    codCollectionIds: string[];
  }): Promise<void>;
}

export interface CodCoveragePort {
  coverageForOrder(orderId: string): Promise<CodCollectionCoverage[]>;
}

export interface CodCollectionCoverage {
  collectionId: string;
  shipmentId: string;
  kind: 'order' | 'delivery_fee';
  expected: number;
  settled: number;
  settledAt: Date | null;
  status: 'pending' | 'collected' | 'cancelled';
}

export interface RefundPorts {
  earnings: RefundEarningsPort;
  codCoverage: CodCoveragePort;
}

let registered: Partial<RefundPorts> = {};

/**
 * Register the implementations. Called ONCE at boot (wave 2 wires it in `lifecycle.ts`).
 * Partial on purpose, so the two owners can register their halves independently; a second
 * call replaces only what it names.
 */
export function registerRefundPorts(ports: Partial<RefundPorts>): void {
  registered = { ...registered, ...ports };
}

function missing(name: keyof RefundPorts): never {
  throw createAppError(
    ERROR_CODES.REFUND_PORT_NOT_REGISTERED,
    500,
    `The refund ${name} port is not registered — registerRefundPorts was not called at boot`,
    { port: name }
  );
}

export function getRefundEarningsPort(): RefundEarningsPort {
  return registered.earnings ?? missing('earnings');
}

export function getCodCoveragePort(): CodCoveragePort {
  return registered.codCoverage ?? missing('codCoverage');
}

/** Whether a port is registered — for diagnostics and tests, never to decide whether to skip. */
export function isRefundPortRegistered(name: keyof RefundPorts): boolean {
  return registered[name] !== undefined;
}

/** `test:refund-flow` / verify suites only. */
export function __resetRefundPortsForTests(): void {
  registered = {};
}

/** A COD collection counts as covered ONLY when its cash fully reached the platform (R-5, R-6). */
export function collectionFullyCovered(c: CodCollectionCoverage): boolean {
  return c.status === 'collected' && c.settledAt !== null && c.settled >= c.expected;
}
