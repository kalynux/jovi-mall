import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { EarningsOwnerType } from './earnings-account.model';
import { PayoutMethodSchema, IPayoutMethod } from '../../../core/types/payout.types';
import { ActorSource, actorStampFields } from '../../../core/types/actor-source.types';
import { IReviewTriage, ReviewTriageSchema } from '../../../core/types/review-triage.types';

/**
 * PayoutRequest - a vendor/agency/agent's request to withdraw their ENTIRE
 * current `available_balance`. Created atomically alongside the EarningsAccount move
 * (available_balance -> requested_balance, see EarningsAccountService), then
 * routed through the ticketing module (one PAYOUT_REQUEST ticket per request,
 * assigned to the admin pool) for the human workflow.
 *
 * This document — not EarningsLedger — is the audit trail for payout money
 * movement: status/timestamps/resolved_by record who approved/rejected it and
 * when. `payout_method_snapshot` freezes the destination at request time so a
 * later profile edit never changes where an already-pending request is headed.
 *
 * Status is the operational source of truth for whether funds have actually
 * left the platform — deliberately separate from the linked ticket's own
 * status, which just tracks the support/communication thread.
 */

/**
 * ── The lifecycle ────────────────────────────────────────────────────────────
 *
 *   (none)     → pending      requestPayout      holds funds in requested_balance
 *   pending    → rejected     reject             releases the hold
 *   pending    → processing   sendPayout         transfer submitted, hold retained
 *   pending    → paid         markPaid           manual settlement, hold consumed
 *   processing → paid         transfer webhook   hold consumed
 *   processing → failed       transfer webhook   hold retained
 *   failed     → processing   sendPayout (retry) reuses transfer_reference
 *   failed     → rejected     reject             releases the hold
 *   failed     → paid         markPaid           reconcile an out-of-band settlement
 *
 * ⛔ `processing → rejected` is REFUSED. Releasing a hold on money that may
 * still be in flight at the gateway is how a payout gets sent twice — once by
 * the transfer that was never actually dead, and once by the owner re-requesting
 * a balance that came back. A transfer must reach a terminal verdict first.
 */
export type PayoutRequestStatus = 'pending' | 'processing' | 'paid' | 'rejected' | 'failed';

/**
 * The status list, at runtime.
 *
 * Exported so the schema `enum` and the admin queue's filter spread ONE list, the way
 * `PAYOUT_OWNER_TYPES` already does — that filter drifted from the model once before and
 * made an entire owner type unfilterable.
 */
export const PAYOUT_REQUEST_STATUSES = [
  'pending',
  'processing',
  'paid',
  'rejected',
  'failed',
] as const satisfies readonly PayoutRequestStatus[];

/**
 * The statuses in which the owner's money is still sitting in `requested_balance`.
 *
 * ⚠ This list IS the partial unique index below, and the two must not drift: it is
 * what stops an owner opening a SECOND payout request while the first one's funds are
 * still held. `failed` belongs here precisely because it is the status that looks
 * finished and is not — the hold survives a failed transfer by design (the money has
 * not come back, so it cannot be offered again).
 */
export const PAYOUT_HELD_STATUSES: readonly PayoutRequestStatus[] = [
  'pending',
  'processing',
  'failed',
] as const;

/**
 * Who can be owed a payout. NOT `EarningsOwnerType` — that includes `'platform'`, and
 * the marketplace does not pay itself out.
 *
 * Exported so the schema `enum` and every validator filtering on it spread ONE list.
 * They used to be typed out separately and drifted: the admin queue's filter stopped at
 * vendor and agency, so an agent's payout could not be filtered for at all.
 */
export const PAYOUT_OWNER_TYPES = ['vendor', 'agency', 'agent'] as const;

/**
 * `manual` - the vendor/agency called POST .../earnings/payout themselves.
 * `auto_threshold` - EarningsReleaseWorker opened it automatically because
 * available_balance reached EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD, so the
 * platform never owes an unbounded amount to one account. `requested_by_user_id`
 * is still populated (the configured support/system admin actor, same
 * convention as TicketService.createSystemTicket) even for auto_threshold.
 */
export type PayoutRequestOrigin = 'manual' | 'auto_threshold';

/**
 * A reviewer's verdict that this request looks legitimate.
 *
 * Re-exported from the shared definition rather than redeclared: the identical stamp is
 * carried by `agent_deposits` and `agency_remittances`, and three copies of one shape is
 * three places for it to drift. See `core/types/review-triage.types.ts` for why there is no
 * `rejected` verdict — rejection is terminal on all three records, so it is a status.
 */
export type PayoutTriageVerdict = IReviewTriage['verdict'];

/**
 * ⛔ **Endorsement is a FIELD, never a status**, and three separate things break if that
 * is ever "tidied up" into the status enum:
 *
 *  1. the partial unique index below — an `endorsed` status is not in
 *     `PAYOUT_HELD_STATUSES`, so an owner could open a second request while the first
 *     is still live and still holding their money;
 *  2. `assertPending` in wi-admin's dual-control handler
 *     (`admin/src/modules/money/domain/payout-dual-control.ts`), which refuses anything
 *     that is not `pending` — an endorsed payout would become unpayable;
 *  3. the admin queue's status filter and `sumPaidSince`'s allowance window.
 *
 * Keeping it beside the status means the entire existing state machine is untouched by
 * triage, which is what makes the pre-screen optional (a tier-1/2 administrator may pay
 * a `pending` payout that nobody has endorsed).
 */
export type IPayoutTriage = IReviewTriage;

export interface IPayoutRequest extends Document {
  owner_type: EarningsOwnerType;
  owner_id: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  status: PayoutRequestStatus;
  origin: PayoutRequestOrigin;
  payout_method_snapshot: IPayoutMethod;
  ticket_id: mongoose.Types.ObjectId | null;
  requested_by_user_id: mongoose.Types.ObjectId;
  /** Null until a tier-3 reviewer endorses it. See `IPayoutTriage`. */
  triage: IPayoutTriage | null;
  /**
   * The reference WE mint (`jm_po_<32 hex>`) and hand to the gateway.
   *
   * ⚠ **This is the double-send guard.** It is minted and stored in the SAME atomic
   * compare-and-set that moves the row into `processing`, before any HTTP call happens,
   * and a retry after a failure REUSES it rather than minting a new one — so a resend
   * whose first attempt actually succeeded is deduplicated by the gateway on its own
   * reference idempotency rather than paying the owner twice.
   */
  transfer_reference: string | null;
  /** The gateway's own id for the transfer, learned from its response or callback. */
  transfer_gateway_ref: string | null;
  /** Why the last transfer attempt failed, verbatim from the gateway where available. */
  transfer_failure_reason: string | null;
  resolved_at: Date | null;
  resolved_by: mongoose.Types.ObjectId | null;
  /**
   * Which identity space `resolved_by` belongs to, and a snapshot of who it was.
   *
   * An administrator marking a payout paid now arrives through `requireAdminCaller`
   * and holds no `users` row here, so `resolved_by` would otherwise be an id that
   * resolves in no collection with nothing saying so. See
   * `core/types/actor-source.types.ts`.
   *
   * Note the id field is `resolved_by`, not `resolved_by_user_id` as on
   * `agency_remittances` and `agent_deposits`. That predates the convention and is
   * left alone deliberately: renaming it is a data migration, and this fix is a
   * prerequisite for a write path that is about to go live. `actorStamp`'s third
   * parameter exists to bridge exactly that.
   */
  resolved_by_source: ActorSource;
  resolved_by_name: string | null;
  paid_reference: string | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const PayoutRequestSchema = new Schema<IPayoutRequest>(
  {
    // No 'platform': the platform account is the marketplace's own commission,
    // and it does not pay itself out.
    owner_type: { type: String, enum: [...PAYOUT_OWNER_TYPES], required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    status: {
      type: String,
      enum: [...PAYOUT_REQUEST_STATUSES],
      required: true,
      default: 'pending',
    },
    origin: { type: String, enum: ['manual', 'auto_threshold'], required: true, default: 'manual' },
    payout_method_snapshot: { type: PayoutMethodSchema, required: true },
    ticket_id: { type: Schema.Types.ObjectId, ref: MODELS.TICKET, default: null },
    requested_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    triage: { type: ReviewTriageSchema, default: null },
    transfer_reference: { type: String, default: null, trim: true },
    transfer_gateway_ref: { type: String, default: null, trim: true },
    transfer_failure_reason: { type: String, default: null, trim: true, maxlength: 500 },
    resolved_at: { type: Date, default: null },
    resolved_by: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    ...actorStampFields('resolved_by'),
    paid_reference: { type: String, default: null, trim: true },
    rejection_reason: { type: String, default: null, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Admin queue listing + per-owner history.
PayoutRequestSchema.index({ owner_type: 1, owner_id: 1, status: 1 });
PayoutRequestSchema.index({ status: 1, created_at: -1 });
PayoutRequestSchema.index({ ticket_id: 1 });

/**
 * The reference the gateway echoes back on a transfer callback. Sparse because only
 * payouts that reached the gateway have one, unique because two rows claiming the same
 * transfer is the shape of a double-send.
 */
PayoutRequestSchema.index(
  { transfer_reference: 1 },
  {
    name: 'payout_transfer_reference',
    unique: true,
    partialFilterExpression: { transfer_reference: { $type: 'string' } },
  }
);

/**
 * Belt-and-suspenders against a double-submit race: at most one request per owner whose
 * funds are still HELD, enforced by the database (the service also pre-checks, see
 * PayoutRequestService.requestPayout, but only this index is race-proof).
 *
 * ⚠ The filter spans `PAYOUT_HELD_STATUSES`, not `pending` alone. It used to be
 * `{ status: 'pending' }`, which was complete when `pending` was the only non-terminal
 * status; `processing` and `failed` are both non-terminal AND still holding the owner's
 * money, so a `pending`-only filter would let an owner open a fresh request for a balance
 * they have not got back. Changing this list means changing `PAYOUT_HELD_STATUSES`.
 *
 * ⚠ **Named explicitly, and the name is load-bearing.** Mongoose would auto-name this
 * `owner_type_1_owner_id_1`, which is exactly what the NARROWER legacy version of this index
 * is already called in every existing database. Two partial indexes on one key pattern that
 * differ only in their filter, sharing a name, is an `IndexOptionsConflict` at boot — and
 * with `autoIndex` on, that failure is silent. The explicit name lets
 * `migrate:payout-lifecycle-index` drop the old one and build this one as distinct,
 * identifiable objects.
 */
PayoutRequestSchema.index(
  { owner_type: 1, owner_id: 1 },
  {
    name: 'payout_one_held_per_owner',
    unique: true,
    partialFilterExpression: { status: { $in: [...PAYOUT_HELD_STATUSES] } },
  }
);

export const PayoutRequestModel = mongoose.model<IPayoutRequest>(
  MODELS.PAYOUT_REQUEST,
  PayoutRequestSchema,
  COLLECTIONS.PAYOUT_REQUEST
);
