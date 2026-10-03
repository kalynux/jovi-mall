import { ShipmentStatus } from '../../shipments/shipment.model';
import { ICodHandlingFee } from '../../delivery/delivery-agency.model';
import { evaluateDeliveryCostCap } from '../../earnings/services/delivery-cost-cap';
import {
  DeliveryFeeProposalStatus,
  DeliveryFeeProposerRole,
} from '../models/delivery-fee-proposal.model';

/**
 * The delivery-fee proposal rules — the pure half, DB-free so `test:delivery-fee-proposals`
 * runs the real decisions with no connection.
 *
 * Every function here RETURNS a refusal rather than throwing it; the service maps a refusal
 * onto its error code. That keeps the authority table readable in one place and testable
 * without an error envelope.
 */

/**
 * Where a proposal may be raised — before pickup.
 *
 *  - `assigned`     the agency holds the shipment; an agent may or may not have accepted it.
 *  - `handing_over` a post-pickup reassignment awaiting its replacement's pickup — the
 *                   replacement's run is a new pickup, at a place the original quote never
 *                   priced (`shipment.handover.pickup`), so it is renegotiable too.
 *
 * Deliberately NOT:
 *  - `pending`                      — not dispatched yet; the agency has not been handed it.
 *  - `pending_agency_reassignment`  — the agency went inactive; it is not answering for it.
 *  - everything from `picked_up` on — the run the fee prices has started.
 */
export const DELIVERY_FEE_PROPOSAL_WINDOW: readonly ShipmentStatus[] = ['assigned', 'handing_over'];

/** Two non-withdrawn proposals per shipment: the first, and ONE more after a rejection. */
export const MAX_NON_WITHDRAWN_PROPOSALS = 2;

/** Statuses that count against `MAX_NON_WITHDRAWN_PROPOSALS`. */
export const COUNTED_PROPOSAL_STATUSES: readonly DeliveryFeeProposalStatus[] = [
  'pending',
  'approved',
  'rejected',
];

export type ProposalRefusal =
  | { code: 'window_closed'; status: ShipmentStatus }
  | { code: 'agents_not_allowed' }
  | { code: 'agent_not_on_shipment' }
  | { code: 'already_pending'; proposalId: string }
  | { code: 'limit_reached'; used: number; max: number }
  | { code: 'invalid_fee' }
  | { code: 'no_change'; currentFee: number }
  | { code: 'vendor_net_not_positive' };

export function isInProposalWindow(status: ShipmentStatus): boolean {
  return DELIVERY_FEE_PROPOSAL_WINDOW.includes(status);
}

export interface ProposerCheckInput {
  role: DeliveryFeeProposerRole;
  /** `assignment_settings.agents_can_propose_delivery_fee` of the shipment's agency. */
  agentsMayPropose: boolean;
  /** The agent id on the shipment (bound at accept), or null. */
  shipmentAgentId: string | null;
  /** The calling agent (role 'agent' only). */
  actorAgentId?: string | null;
}

/**
 * Who may propose. The agency always may (ownership is enforced by the scoped read). The
 * agent may only when (a) they hold the ACCEPTED offer — `shipment.agent_id` is written on
 * accept and nowhere else — and (b) their agency opted in.
 */
export function checkProposer(input: ProposerCheckInput): ProposalRefusal | null {
  if (input.role === 'agency') return null;
  if (!input.actorAgentId || input.shipmentAgentId !== input.actorAgentId) {
    return { code: 'agent_not_on_shipment' };
  }
  if (!input.agentsMayPropose) return { code: 'agents_not_allowed' };
  return null;
}

export interface CreationCheckInput {
  shipmentStatus: ShipmentStatus;
  pendingProposalId: string | null;
  /** Non-withdrawn proposals already on the shipment. */
  countedProposals: number;
  proposedFee: number;
  currentFee: number;
}

/** The structural creation rules, in the order a caller is best told about them. */
export function checkCreation(input: CreationCheckInput): ProposalRefusal | null {
  if (!isInProposalWindow(input.shipmentStatus)) {
    return { code: 'window_closed', status: input.shipmentStatus };
  }
  if (input.pendingProposalId) return { code: 'already_pending', proposalId: input.pendingProposalId };
  if (input.countedProposals >= MAX_NON_WITHDRAWN_PROPOSALS) {
    return { code: 'limit_reached', used: input.countedProposals, max: MAX_NON_WITHDRAWN_PROPOSALS };
  }
  if (!Number.isInteger(input.proposedFee) || input.proposedFee < 0) return { code: 'invalid_fee' };
  if (input.proposedFee === input.currentFee) return { code: 'no_change', currentFee: input.currentFee };
  return null;
}

// ── The vendor-net ceiling ────────────────────────────────────────────────────

/**
 * The vendor's net on ONE COD shipment at `fee` — the unit `splitCodCollection` splits on.
 * `evaluateDeliveryCostCap` is reused for its arithmetic only (same floors as the split);
 * its 30% verdict is deliberately ignored — the cap does not apply to a negotiated fee.
 */
export function codShipmentVendorNet(input: {
  shipmentGross: number;
  aiMargin: number;
  commissionPercent: number;
  fee: number;
  codHandling: ICodHandlingFee | null;
}): number {
  return evaluateDeliveryCostCap({
    subtotal: input.shipmentGross,
    aiMargin: input.aiMargin,
    commissionPercent: input.commissionPercent,
    deliveryFee: input.fee,
    codHandling: input.codHandling,
    // The ratio half is irrelevant here; 100 keeps its scan cheap and its verdict unread.
    maxDeliveryPercent: 100,
  }).vendorNet;
}

/**
 * The vendor's net on a PREPAID order not yet split, at `fee` for the target shipment and
 * the other shipments' effective fees — `splitOrder`'s formula, with no COD fee.
 */
export function prepaidOrderVendorNet(input: {
  orderGross: number;
  aiMargin: number;
  commissionPercent: number;
  /** Σ of every OTHER shipment's effective fee on the order. */
  otherShipmentsFees: number;
  fee: number;
}): number {
  return evaluateDeliveryCostCap({
    subtotal: input.orderGross,
    aiMargin: input.aiMargin,
    commissionPercent: input.commissionPercent,
    deliveryFee: input.otherShipmentsFees + input.fee,
    codHandling: null,
    maxDeliveryPercent: 100,
  }).vendorNet;
}

/**
 * The vendor's net on a PREPAID order ALREADY split: the written allocation moved by the fee
 * delta. Exact by construction — it is the same number `adjustHeldAmount` will write.
 */
export function splitOrderVendorNetAfter(input: {
  vendorAllocation: number;
  chargedFee: number;
  fee: number;
}): number {
  return input.vendorAllocation + input.chargedFee - input.fee;
}

export function checkVendorNet(vendorNet: number): ProposalRefusal | null {
  return vendorNet > 0 ? null : { code: 'vendor_net_not_positive' };
}

// ── Money application on approval ────────────────────────────────────────────

export interface ApplicationPlanInput {
  isCod: boolean;
  /** `shipment.delivery_fee_snapshot` — what the vendor was charged at payment, if split. */
  snapshot: number | null;
  /** The vendor's `('order', vendor)` allocation, if the order was split. */
  vendorAllocation: { amount: number; status: 'held' | 'released' | 'reversed' } | null;
  /**
   * Whether ANY `('order', …)` allocation exists. `splitOrder` writes the snapshots BEFORE
   * it persists the allocations, so a snapshot with no allocation at all is a split that
   * failed half-way — the retry will re-derive every fee (override included).
   */
  orderSplit: boolean;
  newFee: number;
}

export type ApplicationPlan =
  | {
      ok: true;
      /** Rewrite `delivery_fee_snapshot` to `newFee`. */
      rewriteSnapshot: boolean;
      /** Re-price the vendor's held allocation by this much (0 = untouched). */
      allocationDelta: number;
      allocationAfter: number | null;
    }
  | { ok: false; reason: 'allocation_not_held' | 'vendor_net_not_positive' };

/**
 * How an approved fee lands on the money, decided without I/O.
 *
 *  - COD: nothing is written yet — the split runs at collection and reads the override.
 *  - Prepaid, not split yet (no snapshot): the override is enough; `splitOrder` charges it.
 *  - Prepaid, split (snapshot present): the vendor's net was ALREADY reduced by the snapshot
 *    at payment, so the snapshot is rewritten and the vendor's held `('order', vendor)`
 *    allocation re-priced in place by `snapshot − newFee`. In place rather than an adjusting
 *    row because (a) allocations cannot be negative, so a fee INCREASE has no adjusting row
 *    to write; (b) a new source type would have to be swept by `onOrderCompleted` or its
 *    money is held forever; (c) the vendor analytics and wi-admin statements read the
 *    vendor's net off that one row. The allocation is necessarily still `held` before pickup
 *    — escrow matures per ORDER at completion — and anything else refuses.
 */
export function planFeeApplication(input: ApplicationPlanInput): ApplicationPlan {
  if (input.isCod || input.snapshot === null) {
    return { ok: true, rewriteSnapshot: false, allocationDelta: 0, allocationAfter: null };
  }
  if (!input.orderSplit) {
    // A half-finished split: keep the snapshot truthful for the delivery split and the
    // quotes; there is no allocation to re-price yet, and the retried split reads the override.
    return { ok: true, rewriteSnapshot: true, allocationDelta: 0, allocationAfter: null };
  }
  const delta = input.snapshot - input.newFee;
  if (!input.vendorAllocation) {
    // Split marker present but no vendor row: `persist` skips a zero-value share. A fee
    // decrease would need a row created; an increase would drive it negative. Both refuse
    // rather than invent money — vendorNet ≤ 0 at payment means the cap was bypassed.
    return { ok: false, reason: 'vendor_net_not_positive' };
  }
  if (input.vendorAllocation.status !== 'held') return { ok: false, reason: 'allocation_not_held' };
  const after = input.vendorAllocation.amount + delta;
  if (after <= 0) return { ok: false, reason: 'vendor_net_not_positive' };
  return { ok: true, rewriteSnapshot: true, allocationDelta: delta, allocationAfter: after };
}

// ── Who may do what to an existing proposal ───────────────────────────────────

export type ProposalAction = 'approve' | 'reject' | 'withdraw' | 'edit';

export interface ProposalViewer {
  role: 'vendor' | 'agency' | 'agent';
  /** For an agent: their agent id. */
  agentId?: string | null;
  /**
   * For an agent: whether their agency's `agents_can_propose_delivery_fee` is still on.
   * `false` withholds `edit` (an agent may only edit while the preference holds). Unknown
   * (`undefined`) is treated as on — the service re-checks before writing.
   */
  agentsMayPropose?: boolean;
}

/**
 * The single authority table — read by the service to enforce and by the DTO to render
 * buttons, so a dashboard never offers a verb the API refuses.
 *
 *  - vendor              → approve / reject (the counterparty).
 *  - the agency          → withdraw / edit (any of its shipment's proposals, its agent's included).
 *  - the proposing agent → withdraw / edit their own — until the AGENCY edits it, after which
 *                          it is agency-owned; `edit` also needs the agency preference on.
 */
export function resolveAvailableActions(
  proposal: {
    status: DeliveryFeeProposalStatus;
    proposed_by_role: DeliveryFeeProposerRole;
    proposed_by_agent_id: string | null;
    agency_edited?: boolean;
  },
  viewer: ProposalViewer
): ProposalAction[] {
  if (proposal.status !== 'pending') return [];
  if (viewer.role === 'vendor') return ['approve', 'reject'];
  if (viewer.role === 'agency') return ['withdraw', 'edit'];
  if (
    viewer.role === 'agent' &&
    proposal.proposed_by_role === 'agent' &&
    !proposal.agency_edited &&
    !!viewer.agentId &&
    proposal.proposed_by_agent_id === viewer.agentId
  ) {
    return viewer.agentsMayPropose === false ? ['withdraw'] : ['withdraw', 'edit'];
  }
  return [];
}

// ── Editing a pending proposal ────────────────────────────────────────────────

export type EditRefusal =
  | { code: 'invalid_fee' }
  | { code: 'no_change' }
  | { code: 'same_as_current'; currentFee: number }
  | { code: 'version_mismatch'; currentVersion: number };

/**
 * The structural edit rules. `expectedVersion` (optional on an edit) must match when sent;
 * an edit that changes nothing is refused, and so is one setting the fee back to what the
 * shipment already carries (that is a withdrawal, not a proposal).
 */
export function checkEdit(input: {
  currentVersion: number;
  expectedVersion?: number;
  proposedFee: number;
  reason: string;
  newFee?: number;
  newReason?: string;
  shipmentCurrentFee: number;
}): EditRefusal | null {
  if (input.expectedVersion !== undefined && input.expectedVersion !== input.currentVersion) {
    return { code: 'version_mismatch', currentVersion: input.currentVersion };
  }
  const fee = input.newFee ?? input.proposedFee;
  const reason = input.newReason ?? input.reason;
  if (!Number.isInteger(fee) || fee < 0) return { code: 'invalid_fee' };
  if (fee === input.proposedFee && reason === input.reason) return { code: 'no_change' };
  if (fee === input.shipmentCurrentFee) return { code: 'same_as_current', currentFee: input.shipmentCurrentFee };
  return null;
}

/**
 * The vendor must answer the version they SAW. A mismatch means the proposal was edited
 * after the vendor loaded it — refuse, never apply a figure the vendor did not see.
 */
export function checkVendorVersion(seen: number, current: number): EditRefusal | null {
  return seen === current ? null : { code: 'version_mismatch', currentVersion: current };
}
