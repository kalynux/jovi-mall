import { ClientSession, Types } from 'mongoose';
import {
  PayoutRequestModel,
  IPayoutRequest,
  IPayoutTriage,
  PayoutRequestOrigin,
  PayoutRequestStatus,
  PAYOUT_HELD_STATUSES,
} from '../models/payout-request.model';
import { EarningsOwnerType } from '../models/earnings-account.model';
import { IPayoutMethod } from '../../../core/types/payout.types';
import { ActorRef, actorStamp } from '../../../core/types/actor-source.types';

export interface CreatePayoutRequestInput {
  owner_type: EarningsOwnerType;
  owner_id: string;
  amount: number;
  currency: string;
  origin: PayoutRequestOrigin;
  payout_method_snapshot: IPayoutMethod;
  requested_by_user_id: string;
}

export interface ListPayoutRequestsFilters {
  status?: string;
  ownerType?: string;
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

/**
 * The statuses a MANUAL settlement may be recorded from.
 *
 * ⚠ `processing` is deliberately absent. A payout whose transfer is in flight is settled
 * by the gateway callback (`settleTransferPaid`), not by an administrator typing a
 * reference — allowing both would let a human record a payment that the gateway is about
 * to record again.
 */
const MANUALLY_SETTLEABLE: readonly PayoutRequestStatus[] = ['pending', 'failed'] as const;

/**
 * The statuses a payout may be REJECTED from — i.e. the ones where the hold can safely be
 * released back to `available_balance`.
 *
 * ⛔ `processing` is absent and that is the single most important omission in this file.
 * Releasing a hold while a transfer may still be in flight is how an owner is paid twice:
 * once by the transfer that was never actually dead, and once from the balance that came
 * back. See `EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT`.
 */
const REJECTABLE: readonly PayoutRequestStatus[] = ['pending', 'failed'] as const;

/** Persistence for PayoutRequest documents. See the model for domain rules. */
export class PayoutRequestRepository {
  async create(input: CreatePayoutRequestInput, session?: ClientSession): Promise<IPayoutRequest> {
    const [doc] = await PayoutRequestModel.create(
      [
        {
          owner_type: input.owner_type,
          owner_id: new Types.ObjectId(input.owner_id),
          amount: input.amount,
          currency: input.currency,
          status: 'pending',
          origin: input.origin,
          payout_method_snapshot: input.payout_method_snapshot,
          ticket_id: null,
          requested_by_user_id: new Types.ObjectId(input.requested_by_user_id),
          triage: null,
          transfer_reference: null,
          transfer_gateway_ref: null,
          transfer_failure_reason: null,
          resolved_at: null,
          resolved_by: null,
          paid_reference: null,
          rejection_reason: null,
        },
      ],
      { session: session ?? null }
    );
    return doc;
  }

  /**
   * The owner's in-flight request, if any — the pre-check behind
   * `EARNINGS_PAYOUT_ALREADY_PENDING`.
   *
   * ⚠ Spans every HELD status, not `pending` alone. A `processing` or `failed` request is
   * still sitting on the owner's money, so treating either as "no request outstanding"
   * would offer them a balance they have not got back — and the partial unique index would
   * then refuse the insert with a duplicate-key error instead of this readable 409.
   */
  async findHeldForOwner(ownerType: EarningsOwnerType, ownerId: string): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOne({
      owner_type: ownerType,
      owner_id: new Types.ObjectId(ownerId),
      status: { $in: [...PAYOUT_HELD_STATUSES] },
    });
  }

  /**
   * How much has actually been PAID to this owner inside a trailing window, and when the
   * oldest of those payments was resolved.
   *
   * ⚠ **`status: 'paid'` only.** A rejected request put the money back into
   * `available_balance` (`revertPayoutToAvailableInSession`), so counting it would charge the
   * owner for an administrator's decision — and could leave them at zero allowance having
   * received nothing at all. A `failed` one has paid nothing either, and its money is still
   * held rather than spent.
   *
   * ⚠ **Windowed on `resolved_at`, not `created_at`**, because the question is when money left
   * the platform. A request opened 31 days ago and paid yesterday is recent spending; a
   * `created_at` window would drop it while the cash was still warm.
   *
   * Served by the existing `{owner_type, owner_id, status}` index — the date is a residual
   * filter over one owner's few resolved payouts, so no new index is needed.
   */
  async sumPaidSince(
    ownerType: EarningsOwnerType,
    ownerId: string,
    since: Date,
  ): Promise<{ total: number; oldestResolvedAt: Date | null }> {
    const rows = await PayoutRequestModel.find(
      {
        owner_type: ownerType,
        owner_id: new Types.ObjectId(ownerId),
        status: 'paid',
        resolved_at: { $gte: since },
      },
      { amount: 1, resolved_at: 1 },
    )
      .sort({ resolved_at: 1 })
      .lean();

    if (rows.length === 0) return { total: 0, oldestResolvedAt: null };

    const total = rows.reduce((sum, r: { amount?: number }) => sum + (r.amount ?? 0), 0);
    const oldest = (rows[0] as { resolved_at?: Date | null }).resolved_at ?? null;
    return { total, oldestResolvedAt: oldest ? new Date(oldest) : null };
  }

  async findLatestForOwner(ownerType: EarningsOwnerType, ownerId: string): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOne({ owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) }).sort({
      created_at: -1,
    });
  }

  async findById(id: string): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findById(id);
  }

  /** Resolve the payout a gateway callback names. See `transfer_reference` on the model. */
  async findByTransferReference(reference: string): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOne({ transfer_reference: reference });
  }

  async setTicketId(id: string, ticketId: string): Promise<void> {
    await PayoutRequestModel.updateOne({ _id: id }, { $set: { ticket_id: new Types.ObjectId(ticketId) } });
  }

  /**
   * Record a tier-3 endorsement.
   *
   * Guarded on `status: 'pending'` AND `triage: null` — a payout already endorsed, already
   * being sent or already resolved is not re-reviewable, and a second endorsement would
   * overwrite the first reviewer's name on a record whose whole purpose is to say who
   * vouched for it.
   *
   * ⚠ Endorsement does NOT change `status`. See the model's note on why it is a field.
   */
  async setTriage(id: string, triage: IPayoutTriage, session?: ClientSession): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending', triage: null },
      { $set: { triage } },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Claim the payout for a gateway transfer: `pending | failed → processing`, minting the
   * merchant reference in the SAME atomic update.
   *
   * ── This method is the double-send guard, and the details are load-bearing ────
   *
   * **The claim happens before any HTTP call.** A caller that sent first and recorded
   * afterwards would, on a double-click, issue two transfers and only then discover the
   * race. Because the CAS narrows on `status`, the loser of a race gets `null` back and
   * sends nothing.
   *
   * **An existing reference is REUSED, never replaced** — that is what `$ifNull` is doing,
   * and it is why this is an aggregation-pipeline update rather than a plain `$set`. A
   * retry after a failure must carry the same reference as the attempt that failed, so that
   * a gateway which actually succeeded (and merely failed to tell us) deduplicates the
   * resend on its own idempotency instead of paying the owner a second time. Minting a
   * fresh reference per attempt would defeat that completely.
   *
   * ⚠ A pipeline update bypasses Mongoose's timestamp plugin, so `updated_at` is set by
   * hand. Without it a retried payout would keep the timestamp of its first attempt.
   */
  async beginTransfer(
    id: string,
    candidateReference: string,
    session?: ClientSession
  ): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: { $in: [...MANUALLY_SETTLEABLE] } },
      [
        {
          $set: {
            status: 'processing',
            transfer_reference: { $ifNull: ['$transfer_reference', candidateReference] },
            transfer_failure_reason: null,
            updated_at: '$$NOW',
          },
        },
      ],
      { new: true, session: session ?? null }
    );
  }

  /** Stamp the gateway's own transfer id once it answers. Never changes status. */
  async setTransferGatewayRef(id: string, gatewayRef: string | null): Promise<void> {
    if (!gatewayRef) return;
    await PayoutRequestModel.updateOne({ _id: id }, { $set: { transfer_gateway_ref: gatewayRef } });
  }

  /**
   * `processing → failed`. The hold is deliberately NOT released here — see D-5: a transfer
   * that failed has not returned the money, so offering it back would let the owner spend a
   * balance the gateway may yet settle. An administrator retries or rejects.
   */
  async markTransferFailed(
    id: string,
    reason: string,
    gatewayRef: string | null,
    session?: ClientSession
  ): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: 'processing' },
      {
        $set: {
          status: 'failed',
          transfer_failure_reason: reason.slice(0, 500),
          ...(gatewayRef ? { transfer_gateway_ref: gatewayRef } : {}),
        },
      },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Settle a payout the GATEWAY paid: `processing → paid`.
   *
   * Separate from `markPaid` because the permitted source status differs, and collapsing
   * the two would let an administrator record a manual payment for a payout whose transfer
   * is mid-flight. The actor is the platform, not a person — nobody pressed anything.
   */
  async settleTransferPaid(
    id: string,
    resolvedBy: ActorRef,
    reference: string | null,
    gatewayRef: string | null,
    session?: ClientSession
  ): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: 'processing' },
      {
        $set: {
          status: 'paid',
          resolved_at: new Date(),
          ...actorStamp('resolved_by', resolvedBy, 'resolved_by'),
          paid_reference: reference,
          transfer_failure_reason: null,
          ...(gatewayRef ? { transfer_gateway_ref: gatewayRef } : {}),
        },
      },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Record a MANUAL settlement — money sent out of band, an external reference typed in.
   *
   * Guarded on `MANUALLY_SETTLEABLE` — returns null if the payout has moved on (race lost),
   * which includes the deliberate refusal of `processing`.
   *
   * The resolver is an `ActorRef`, not a bare id, because it may be a wi-admin
   * administrator whose id resolves in no collection here. `actorStamp` writes the id,
   * its source and a name snapshot together; the third argument names the id column,
   * which on this model is `resolved_by` rather than `resolved_by_user_id`.
   */
  async markPaid(
    id: string,
    resolvedBy: ActorRef,
    reference: string | null,
    session?: ClientSession
  ): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: { $in: [...MANUALLY_SETTLEABLE] } },
      {
        $set: {
          status: 'paid',
          resolved_at: new Date(),
          ...actorStamp('resolved_by', resolvedBy, 'resolved_by'),
          paid_reference: reference,
        },
      },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Guarded on `REJECTABLE` — returns null if already resolved (race lost) or if a transfer
   * is in flight, which the service distinguishes so the caller learns which it was.
   */
  async markRejected(
    id: string,
    resolvedBy: ActorRef,
    reason: string,
    session?: ClientSession
  ): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: { $in: [...REJECTABLE] } },
      {
        $set: {
          status: 'rejected',
          resolved_at: new Date(),
          ...actorStamp('resolved_by', resolvedBy, 'resolved_by'),
          rejection_reason: reason,
        },
      },
      { new: true, session: session ?? null }
    );
  }

  /** Only used to compensate a request whose ticket failed to create. */
  async hardDeleteById(id: string): Promise<void> {
    await PayoutRequestModel.deleteOne({ _id: id });
  }

  async listForAdmin(
    filters: ListPayoutRequestsFilters,
    pagination: PaginationOptions
  ): Promise<{ data: IPayoutRequest[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filters.status) query.status = filters.status;
    if (filters.ownerType) query.owner_type = filters.ownerType;

    const skip = (pagination.page - 1) * pagination.limit;
    const [data, total] = await Promise.all([
      PayoutRequestModel.find(query).sort({ created_at: -1 }).skip(skip).limit(pagination.limit),
      PayoutRequestModel.countDocuments(query),
    ]);
    return { data, total };
  }
}
