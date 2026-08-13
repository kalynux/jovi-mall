import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { EarningsOwnerType } from './earnings-account.model';
import { PayoutMethodSchema, IPayoutMethod } from '../../../core/types/payout.types';
import { ActorSource, actorStampFields } from '../../../core/types/actor-source.types';

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

export type PayoutRequestStatus = 'pending' | 'paid' | 'rejected';

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
    status: { type: String, enum: ['pending', 'paid', 'rejected'], required: true, default: 'pending' },
    origin: { type: String, enum: ['manual', 'auto_threshold'], required: true, default: 'manual' },
    payout_method_snapshot: { type: PayoutMethodSchema, required: true },
    ticket_id: { type: Schema.Types.ObjectId, ref: MODELS.TICKET, default: null },
    requested_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
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

// Belt-and-suspenders against a double-submit race: at most one PENDING
// request per owner, enforced by the database (the service also pre-checks,
// see PayoutRequestService.requestPayout, but only this index is race-proof).
PayoutRequestSchema.index(
  { owner_type: 1, owner_id: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

export const PayoutRequestModel = mongoose.model<IPayoutRequest>(
  MODELS.PAYOUT_REQUEST,
  PayoutRequestSchema,
  COLLECTIONS.PAYOUT_REQUEST
);
