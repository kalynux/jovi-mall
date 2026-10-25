/**
 * The courier hold: how long an AGENCY's share of one delivery (and its rider's) is held, and
 * from when. Pure — no I/O, no clock — so `test:courier-hold` asserts every rule without a
 * database. The I/O half is `EarningsCompletionService.syncShipmentCourierHold`.
 *
 * ── Why a courier is not held like a seller (owner decision, 2026-10-22) ──────────────
 * The 3-day hold exists because Wi-Mall can make a customer whole only out of money it still
 * holds (the protection window, `earnings-hold.ts`). For an agency that is true only of what
 * its OWN terms make it answerable for after delivery:
 *  - it pays for returns (`policies.returns.payer === 'agency'`) → held the whole window;
 *  - it compensates damage reported within N days (`policies.damage.claim_deadline_days`) →
 *    held for N days, never longer than the window ("the shorter of the two": 4 → 3, 2 → 2);
 *  - neither → nothing to hold for: it is released at the next nightly sweep after the
 *    delivery is PROVEN (see `courierHoldStartOf`).
 * The hold is the longer of the two. The rider's share follows their agency's terms.
 *
 * ── Its own parcel, not the whole order ──────────────────────────────────────────────
 * The seller's hold starts when the courier finishes the order's LAST parcel. An agency's
 * starts when ITS parcel is finished: that is when "they did their part", and its claim
 * deadline counts from its own delivery.
 *
 * ── The terms are read once, when the share is written ───────────────────────────────
 * Snapshotted onto the allocation (`courier_hold`) at split time — the delivery, for both
 * payment methods. An agency editing its terms afterwards does not move money already
 * counted (and a policy change already pauses its vendor connections for re-approval).
 * Rows written before this rule have no snapshot and keep the order-level hold.
 *
 * What a held agency answers for (2026-10-22, owner F-6…F-8): a refund takes its fee back only when
 * an administrator finds the DELIVERY at fault inside its window, and a damage claim can charge it
 * up to its own per-item limit (`courier-liability.ts`, `agency-claim.service.ts`). The window is
 * its damage-claim deadline — the same terms that set its hold here.
 */

import { EarningsPauseReason } from './earnings-hold';

/** The beneficiaries a courier hold governs. Never the vendor's RTO leftover on a shipment row. */
export const COURIER_BENEFICIARIES: readonly string[] = ['agency', 'agent'];

/** The terms snapshot carried by an agency or rider row (`EarningsAllocation.courier_hold`). */
export interface CourierHoldSnapshot {
  /** The delivery this share pays for — a COD collection's row points at its shipment too. */
  shipment_id: string;
  agency_id: string;
  /** Days held after the delivery. 0 = released at the next nightly sweep after proof. */
  days: number;
  /** `EARNINGS_HOLD_DAYS` when the terms were read: the ceiling `days` was cut to. */
  protection_days: number;
  /** The two terms as they stood, for whoever later asks why this money waited (or did not). */
  returns_payer: string | null;
  claim_deadline_days: number | null;
}

/** The slice of `DeliveryAgency.policies` the rule reads. Optional all the way down. */
export interface CourierHoldTerms {
  returns?: { payer?: string | null } | null;
  damage?: { claim_deadline_days?: number | null } | null;
}

/**
 * Days an agency's share is held after its delivery.
 *
 * No terms at all (the agency is gone, or its policies are) → the full window: holding is the
 * safe answer when nothing says otherwise. A missing or nonsensical claim deadline reads the
 * same way. A negative one is treated as 0.
 */
export function courierHoldDays(terms: CourierHoldTerms | null | undefined, protectionDays: number): number {
  const window = Math.max(0, Math.floor(protectionDays));
  if (!terms) return window;
  const returnsHold = terms.returns?.payer === 'agency' ? window : 0;
  const raw = terms.damage?.claim_deadline_days;
  const claim = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : window;
  const damageHold = Math.min(claim, window);
  return Math.max(returnsHold, damageHold);
}

/** Build the snapshot written onto an agency or rider row at split time. */
export function courierHoldSnapshot(
  shipmentId: string,
  agencyId: string,
  terms: CourierHoldTerms | null | undefined,
  protectionDays: number
): CourierHoldSnapshot {
  const raw = terms?.damage?.claim_deadline_days;
  return {
    shipment_id: shipmentId,
    agency_id: agencyId,
    days: courierHoldDays(terms, protectionDays),
    protection_days: protectionDays,
    returns_payer: terms?.returns?.payer ?? null,
    claim_deadline_days: typeof raw === 'number' && Number.isFinite(raw) ? raw : null,
  };
}

/** A held share whose terms free it: no hold of its own. */
export function isFreeCourierRow(row: { courier_hold?: { days?: number | null } | null }): boolean {
  return !!row.courier_hold && row.courier_hold.days === 0;
}

/**
 * The statuses at which a delivery's clock may start.
 *
 * HELD agency: the same moments as the seller's hold (`COURIER_FINISHED_STATUSES`) — prepaid
 * `agent_delivered` (the rider's tap), COD `delivered` (the customer's code), `returned`. A tap
 * that turns out wrong (`agent_delivered → failed`) clears the start, and the hold covered it.
 *
 * FREE agency: there is no hold to cover a wrong tap — released money cannot be taken back —
 * so its clock waits for PROOF (owner decision, 2026-10-22): `delivered`, which on a prepaid
 * parcel is the customer's confirmation (or the auto-confirm sweep's, after
 * `EARNINGS_SHIPMENT_AUTO_CONFIRM_DAYS`) and on COD is the code. `returned` ends the parcel's
 * journey with nothing further to wait for.
 */
export function courierStartStatuses(isCod: boolean, free: boolean): readonly string[] {
  if (free) return ['delivered', 'returned'];
  return isCod ? ['delivered', 'returned'] : ['agent_delivered', 'delivered', 'returned'];
}

/** The shipment as `courierHoldStartOf` reads it. */
export interface CourierShipmentFacts {
  status: string;
  status_history?: ReadonlyArray<{ status: string; changed_at: Date | null | undefined }> | null;
  customer_confirmation?: { confirmed_at?: Date | null } | null;
}

/**
 * When this delivery's clock started, or null if it has not (the parcel is not at a starting
 * status). Read from the shipment's own history rather than "now", so a nightly backstop that
 * stamps the row a day late still dates it from the delivery.
 *
 * It is the first entry of the CURRENT unbroken run of starting statuses: for a held prepaid
 * parcel `agent_delivered → delivered` that is the tap; after `agent_delivered → failed →
 * in_transit → agent_delivered` it is the second tap. A prepaid `delivered` with no history
 * falls back to the customer's confirmation, then to `now`.
 */
export function courierHoldStartOf(
  shipment: CourierShipmentFacts,
  isCod: boolean,
  free: boolean,
  now: Date
): Date | null {
  const starts = courierStartStatuses(isCod, free);
  if (!starts.includes(shipment.status)) return null;

  const history = shipment.status_history ?? [];
  let anchor: Date | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!starts.includes(entry.status)) break;
    if (entry.changed_at) anchor = entry.changed_at;
  }
  if (anchor) return anchor;
  if (shipment.status === 'delivered' && shipment.customer_confirmation?.confirmed_at) {
    return shipment.customer_confirmation.confirmed_at;
  }
  return now;
}

/**
 * Does an ORDER-level pause reach this row? Every pause reaches every row, except one: an
 * administrator's pause of the order does not stop an agency whose own terms free it
 * (owner, 2026-10-22). A customer's problem report, a refund, a seller's cancel or a card
 * dispute still does — and a delivery pause (`kind: 'shipment'`) is how an administrator
 * stops a free agency deliberately.
 */
export function orderPauseReachesRow(
  row: { courier_hold?: { days?: number | null } | null },
  reason: EarningsPauseReason | null | undefined
): boolean {
  return !(reason === 'admin' && isFreeCourierRow(row));
}

/** Does a DELIVERY pause reach this row? Only the agency's and the rider's shares of it. */
export function shipmentPauseReachesRow(row: { beneficiary_type: string }): boolean {
  return COURIER_BENEFICIARIES.includes(row.beneficiary_type);
}
