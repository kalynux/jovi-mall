/**
 * The refund request's status machine (REFUND-FLOW-PLAN § 3.1) and the pure guards every verb
 * asks before writing. Pinned by `test:refund-flow`.
 *
 * ```
 * awaiting_approval ──approve──▶ approved ──(COD, not covered)──▶ waiting_for_cash ──covered──▶ approved
 *       │                           │
 *       └──reject──▶ rejected       └─claim──▶ sending ──callback/verify──▶ completed
 *                                                  │
 *                                                  └──▶ failed ──retry──▶ sending
 *                                                           └──settle externally──▶ completed
 * ```
 *
 * Load-bearing:
 * - **`sending → rejected` is REFUSED**, for the reason payouts refuse it: a transfer may be in
 *   flight, and rejecting would release the source while the money may still arrive. Only
 *   `awaiting_approval` and `failed` may be rejected.
 * - **Settle externally is never from `sending`** — same reason: paying by hand while a
 *   transfer is in flight is how a customer is paid twice.
 * - `approved → approved` via `waiting_for_cash → approved` is the COD loop; a non-COD request
 *   never visits `waiting_for_cash`.
 * - The repository enforces every edge by compare-and-set on the FROM status; these guards are
 *   what turns a doomed write into a clear `409 REFUND_REQUEST_STATUS_CONFLICT` before it is tried.
 */

export type RefundRequestStatus =
  | 'awaiting_approval'
  | 'approved'
  | 'waiting_for_cash'
  | 'sending'
  | 'completed'
  | 'failed'
  | 'rejected';

export const REFUND_REQUEST_STATUSES: readonly RefundRequestStatus[] = Object.freeze([
  'awaiting_approval',
  'approved',
  'waiting_for_cash',
  'sending',
  'completed',
  'failed',
  'rejected',
] as RefundRequestStatus[]);

/** The statuses the partial unique index `refund_one_open_per_source` covers. */
export const OPEN_REFUND_STATUSES: readonly RefundRequestStatus[] = Object.freeze([
  'awaiting_approval',
  'approved',
  'waiting_for_cash',
  'sending',
  'failed',
] as RefundRequestStatus[]);

export const TERMINAL_REFUND_STATUSES: readonly RefundRequestStatus[] = Object.freeze([
  'completed',
  'rejected',
] as RefundRequestStatus[]);

/** Every permitted edge. Anything not listed is refused. */
export const REFUND_TRANSITIONS: Readonly<Record<RefundRequestStatus, readonly RefundRequestStatus[]>> = Object.freeze({
  awaiting_approval: ['approved', 'rejected', 'completed'], // completed = settled externally
  approved: ['sending', 'waiting_for_cash', 'completed'], // completed = settled externally
  waiting_for_cash: ['approved', 'completed'], // completed = settled externally
  sending: ['completed', 'failed'],
  failed: ['sending', 'rejected', 'completed'], // completed = settled externally
  completed: [],
  rejected: [],
});

export function canTransition(from: RefundRequestStatus, to: RefundRequestStatus): boolean {
  return REFUND_TRANSITIONS[from]?.includes(to) ?? false;
}

export const REJECTABLE_STATUSES: readonly RefundRequestStatus[] = Object.freeze(['awaiting_approval', 'failed'] as RefundRequestStatus[]);
export const EXTERNALLY_SETTLEABLE_STATUSES: readonly RefundRequestStatus[] = Object.freeze([
  'awaiting_approval',
  'approved',
  'waiting_for_cash',
  'failed',
] as RefundRequestStatus[]);
/**
 * Statuses a claim may start from. `approved` is the first send; `failed` is a retry (reusing
 * the reference). An `approved` row that was refused BEFORE its claim (a short float, payouts
 * switched off) is re-sent from `approved` — the reference was never minted, so nothing reuses.
 */
export const CLAIMABLE_STATUSES: readonly RefundRequestStatus[] = Object.freeze(['approved', 'failed'] as RefundRequestStatus[]);

export function canReject(status: RefundRequestStatus): boolean {
  return REJECTABLE_STATUSES.includes(status);
}

export function canSettleExternally(status: RefundRequestStatus): boolean {
  return EXTERNALLY_SETTLEABLE_STATUSES.includes(status);
}

export function canClaim(status: RefundRequestStatus): boolean {
  return CLAIMABLE_STATUSES.includes(status);
}

export function isOpenRefundStatus(status: RefundRequestStatus): boolean {
  return OPEN_REFUND_STATUSES.includes(status);
}

// ── Approval rules ─────────────────────────────────────────────────────────────

export interface ApprovalFacts {
  destinationSource: 'payer' | 'typed' | null;
  /** Who raised (and so typed) the request. */
  requestedById: string | null;
  /** Who is approving now. */
  approverId: string | null;
}

/**
 * R-7: a TYPED number must be approved by a different administrator from the one who typed it.
 * True means "refuse with `REFUND_SECOND_APPROVER_REQUIRED`". An approver with no id is never
 * accepted as the second one — an unknown actor cannot prove they are someone else.
 */
export function secondApproverRequired(facts: ApprovalFacts): boolean {
  if (facts.destinationSource !== 'typed') return false;
  if (!facts.approverId) return true;
  return facts.requestedById !== null && facts.requestedById === facts.approverId;
}

/**
 * Whether a request may be created ALREADY approved (and claimed in the same call), R-2.
 *
 * Automatic: a refund to the number that paid, within policy, or one the system starts.
 * Needs approval: a typed number, a policy override, ANY COD refund, and anything Support raises.
 * An administrator creating with `approveNow` IS the approver — unless the number is typed,
 * which needs a second person.
 */
export function mayApproveAtCreation(input: {
  requestedByRole: 'vendor' | 'admin' | 'support' | 'system' | 'customer';
  approveNow: boolean;
  destinationSource: 'payer' | 'typed' | null;
  overridePolicy: boolean;
  paymentChannel: 'card' | 'mobile_money' | 'cod' | 'billing';
}): boolean {
  if (input.destinationSource === 'typed') return false;
  if (input.requestedByRole === 'support' || input.requestedByRole === 'customer') return false;
  if (input.requestedByRole === 'admin') return input.approveNow;
  // vendor / system: automatic only within policy, to the paying number (or the card), never COD.
  if (input.overridePolicy) return false;
  if (input.paymentChannel === 'cod' || input.paymentChannel === 'billing') return false;
  return input.approveNow;
}

/** Proof rules (R-7, R-7b): a typed number needs its proof; an external settlement needs one too. */
export function typedDestinationMissingProof(destinationSource: 'payer' | 'typed' | null, proofFileId: string | null | undefined): boolean {
  return destinationSource === 'typed' && !proofFileId;
}

export function externalSettlementMissingProof(proofFileId: string | null | undefined): boolean {
  return !proofFileId;
}

/** Leg-level aggregate: what a request's status is once its transfers report. */
export type TransferLegStatus = 'pending' | 'sending' | 'succeeded' | 'failed';

/**
 * The request's status from its legs' statuses: any `sending` → still `sending`; all
 * `succeeded` → `completed`; otherwise (a failure, or a leg never sent) → `failed`, from which a
 * retry sends only the legs not yet `succeeded`.
 */
export function aggregateLegStatus(legs: readonly TransferLegStatus[]): 'sending' | 'completed' | 'failed' {
  if (legs.length === 0) return 'failed';
  if (legs.some((s) => s === 'sending')) return 'sending';
  if (legs.every((s) => s === 'succeeded')) return 'completed';
  return 'failed';
}
