/**
 * When an agency ANSWERS for a delivery, and for how much (owner decisions F-6…F-8,
 * 2026-10-22). Pure; pinned by `test:courier-liability`.
 * Plan: PRODUCTION-READINESS/REFUND-FEES-AND-AGENCY-LIABILITY-PLAN.md § 2, § 4.1.
 *
 * ── Two conditions, both required ────────────────────────────────────────────────────────
 *  1. The DELIVERY was at fault (F-7) — an administrator says so, per parcel. A wrong item or a
 *     change of mind never touches the agency.
 *  2. The problem was raised INSIDE the agency's own window (F-6): its damage-claim deadline,
 *     counted from its own parcel's delivery, and at least the protection window when it pays
 *     for returns. A free agency (deadline 0, returns not on it) never answers — its terms are
 *     what released its money early (courier-hold.ts), so they must also be what protects it.
 *
 * ── What it gives back ────────────────────────────────────────────────────────────────────
 *  - On a refund at fault: its delivery fee for that parcel, and its rider's (the rider follows
 *    the agency, as for holds). The agency's COD handling fee stays (C-3): the cash was handled.
 *  - On a damage claim (F-8, `agency_claims`): up to its own max refund per item × the damaged
 *    items, plus its investigation fee. The agency alone, never the rider.
 */

import { cumulativeShares } from './clawback-plan';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The two terms the window reads — from an allocation's `courier_hold` snapshot or live policies. */
export interface AgencyLiabilityTerms {
  returns_payer?: string | null;
  claim_deadline_days?: number | null;
}

/**
 * Days after its parcel's delivery during which an agency answers for a problem. A missing or
 * nonsensical deadline answers for nothing: an agency is held to the terms it published, never
 * to terms it does not have.
 */
export function agencyWindowDays(terms: AgencyLiabilityTerms | null | undefined, protectionDays: number): number {
  if (!terms) return 0;
  const raw = terms.claim_deadline_days;
  const claim = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  const returns = terms.returns_payer === 'agency' ? Math.max(0, Math.floor(protectionDays)) : 0;
  return Math.max(claim, returns);
}

/** The last instant a problem may be raised for the agency to answer. Null when it never answers. */
export function agencyWindowEndsAt(deliveredAt: Date | null, windowDays: number): Date | null {
  if (!deliveredAt || windowDays <= 0) return null;
  return new Date(deliveredAt.getTime() + windowDays * DAY_MS);
}

/** Was the problem raised inside the window? A problem raised before delivery is not the courier's. */
export function insideAgencyWindow(deliveredAt: Date | null, raisedAt: Date, windowDays: number): boolean {
  const end = agencyWindowEndsAt(deliveredAt, windowDays);
  return !!end && !!deliveredAt && raisedAt.getTime() >= deliveredAt.getTime() && raisedAt.getTime() <= end.getTime();
}

/** The earliest of the moments a problem became known. Ignores nulls; `fallback` when none. */
export function problemRaisedAt(candidates: ReadonlyArray<Date | null | undefined>, fallback: Date): Date {
  const times = candidates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime())).map((d) => d.getTime());
  return times.length ? new Date(Math.min(...times)) : fallback;
}

/** A courier row of one parcel, as the give-back rule sees it. */
export interface CourierRowFacts {
  id: string;
  beneficiary_type: 'agency' | 'agent' | string;
  amount: number;
  /** `amount − clawed_amount` (0 when reversed). */
  remaining: number;
}

export interface CourierGiveLine {
  id: string;
  /** The most this row may still give back for the delivery fee. */
  give: number;
}

/**
 * How much of each courier row is DELIVERY FEE that can still be given back.
 *
 * The rider's rows are all delivery fee. An agency row is its share of the fee — `fee − the
 * rider's cut` — plus, on a COD collection, the COD handling fee, which stays with it (C-3). With
 * no fee snapshot (an old shipment) the agency row is read as all fee. Already-clawed money counts
 * against the cap, so a second refund on the same parcel cannot take the fee twice.
 */
export function courierGiveback(rows: readonly CourierRowFacts[], deliveryFeeSnapshot: number | null): CourierGiveLine[] {
  const agentTotal = rows.filter((r) => r.beneficiary_type === 'agent').reduce((s, r) => s + Math.max(0, r.amount), 0);
  let agencyCapLeft =
    deliveryFeeSnapshot !== null && Number.isFinite(deliveryFeeSnapshot)
      ? Math.max(0, Math.round(deliveryFeeSnapshot) - agentTotal)
      : Number.POSITIVE_INFINITY;
  return rows.map((r) => {
    const remaining = Math.max(0, r.remaining);
    if (r.beneficiary_type === 'agent') return { id: r.id, give: remaining };
    if (r.beneficiary_type !== 'agency') return { id: r.id, give: 0 };
    const clawedBefore = Math.max(0, r.amount - remaining);
    const feePart = Math.min(Math.max(0, r.amount), agencyCapLeft);
    agencyCapLeft = Math.max(0, agencyCapLeft - feePart);
    return { id: r.id, give: Math.max(0, Math.min(remaining, feePart - clawedBefore)) };
  });
}

/**
 * Spread `need` over the give-back lines in proportion to what each may give (D'Hondt, exact sum,
 * never above a line). Returns what each row gives now, and what nobody could cover.
 */
export function takeFromCouriers(lines: readonly CourierGiveLine[], need: number): { lines: CourierGiveLine[]; short: number } {
  const want = Math.max(0, Math.round(need));
  const weights = lines.map((l) => Math.max(0, l.give));
  const shares = cumulativeShares(want, weights);
  const taken = shares.reduce((s, x) => s + x, 0);
  return {
    lines: lines.map((l, i) => ({ id: l.id, give: shares[i] })).filter((l) => l.give > 0),
    short: want - taken,
  };
}

/**
 * A damage claim's chargeable amount (F-8): what the administrator claims, capped at the agency's
 * own max refund per item × the damaged items. A cap of 0 (the agency set none) allows nothing.
 */
export function damageClaimCap(maxPerItem: number | null | undefined, itemCount: number): number {
  const per = typeof maxPerItem === 'number' && Number.isFinite(maxPerItem) ? Math.max(0, Math.round(maxPerItem)) : 0;
  return per * Math.max(0, Math.floor(itemCount));
}

export function damageClaimAmount(claimed: number, cap: number): number {
  return Math.max(0, Math.min(Math.round(claimed), cap));
}
