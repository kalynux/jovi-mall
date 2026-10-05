import { ClientSession, Types } from 'mongoose';
import {
  IRefundRequest,
  IRefundTransferLeg,
  RefundChannel,
  RefundRequestModel,
  RefundSourceKind,
} from '../models/refund-request.model';
import { PaymentGatewayName } from '../gateways/gateway.interface';
import { CLAIMABLE_STATUSES, OPEN_REFUND_STATUSES, RefundRequestStatus } from '../domain/refund-status';

/**
 * `refund_requests` persistence. Every status write is a COMPARE-AND-SET on the from-status —
 * the status machine (`domain/refund-status.ts`) is enforced here by query filter, so two
 * administrators (or a callback and the sweep) racing on one request produce one winner and a
 * `null` for the loser, never two writes.
 */
export class RefundRequestRepository {
  /**
   * Insert, inside the caller's session when given — ARRAY form, because Mongoose honours
   * `{ session }` only when the first argument is an array. A duplicate on
   * `refund_one_open_per_source` surfaces as the driver's 11000; the service maps it.
   */
  async create(doc: Record<string, unknown>, session?: ClientSession): Promise<IRefundRequest> {
    const [row] = await RefundRequestModel.create([doc], session ? { session } : {});
    return row;
  }

  async findById(id: string, session?: ClientSession): Promise<IRefundRequest | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return RefundRequestModel.findById(id).session(session ?? null).exec();
  }

  /** The request a transfer callback names — by ANY leg's `jm_rf_` reference. */
  async findByTransferReference(reference: string): Promise<IRefundRequest | null> {
    return RefundRequestModel.findOne({ 'transfer_legs.reference': reference }).exec();
  }

  async findOpenBySource(kind: RefundSourceKind, sourceId: string): Promise<IRefundRequest | null> {
    return RefundRequestModel.findOne({
      source_kind: kind,
      source_id: new Types.ObjectId(sourceId),
      status: { $in: [...OPEN_REFUND_STATUSES] },
    }).exec();
  }

  /** Σ gross of COMPLETED requests for one source — the billing ceiling's "already refunded". */
  async sumCompletedGross(kind: RefundSourceKind, sourceId: string): Promise<number> {
    const [tally] = await RefundRequestModel.aggregate<{ total: number }>([
      { $match: { source_kind: kind, source_id: new Types.ObjectId(sourceId), status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$gross_amount' } } },
    ]);
    return tally?.total ?? 0;
  }

  /** `waiting_for_cash` requests that need any of these collections covered. */
  async findWaitingForCollections(collectionIds: string[]): Promise<IRefundRequest[]> {
    const ids = collectionIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return [];
    return RefundRequestModel.find({ status: 'waiting_for_cash', cod_collection_ids: { $in: ids } }).exec();
  }

  async findWaitingForCash(limit: number): Promise<IRefundRequest[]> {
    return RefundRequestModel.find({ status: 'waiting_for_cash' }).sort({ updated_at: 1 }).limit(limit).exec();
  }

  /**
   * COMPLETED requests whose post-completion step never finished (review findings 2 and 6):
   * an order/booking recovery (`earnings_settled_at` null) or a billing reversal
   * (`billing_reversed_at` null), completed before `before` — younger ones are still in the
   * inline best-effort step. Oldest first.
   */
  async findUnsettledCompleted(before: Date, limit: number): Promise<IRefundRequest[]> {
    return RefundRequestModel.find({
      status: 'completed',
      completed_at: { $lt: before },
      $or: [
        { source_kind: { $in: ['order', 'booking'] }, earnings_impact: 'clawback', earnings_settled_at: null },
        { source_kind: { $in: ['plan_purchase', 'credit_topup'] }, billing_reversed_at: null },
      ],
    })
      .sort({ completed_at: 1 })
      .limit(limit)
      .exec();
  }

  /** Stamp a post-completion marker on a COMPLETED request (idempotent: only while still null). */
  async stampCompletedMarker(id: string, field: 'earnings_settled_at' | 'billing_reversed_at', at: Date): Promise<void> {
    await RefundRequestModel.updateOne({ _id: id, status: 'completed', [field]: null }, { $set: { [field]: at } }).exec();
  }

  /** `sending` payout requests quiet since `before` and younger than `after`, for the sweep. */
  async findStuckSending(before: Date, after: Date, limit: number): Promise<IRefundRequest[]> {
    return RefundRequestModel.find({
      status: 'sending',
      channel: 'payout',
      'transfer_legs.status': 'sending',
      updated_at: { $lt: before },
      created_at: { $gt: after },
    })
      .sort({ updated_at: 1 })
      .limit(limit)
      .exec();
  }

  /** Generic compare-and-set: `from → to` with extra fields. Null when the row was not in `from`. */
  async transition(
    id: string,
    from: readonly RefundRequestStatus[],
    to: RefundRequestStatus,
    set: Record<string, unknown> = {},
    session?: ClientSession
  ): Promise<IRefundRequest | null> {
    return RefundRequestModel.findOneAndUpdate(
      { _id: id, status: { $in: [...from] } },
      { $set: { ...set, status: to } },
      { new: true, session: session ?? null }
    ).exec();
  }

  /** Set fields WITHOUT changing status, only while the row is still in `from`. */
  async annotate(
    id: string,
    from: readonly RefundRequestStatus[],
    set: Record<string, unknown>
  ): Promise<IRefundRequest | null> {
    return RefundRequestModel.findOneAndUpdate(
      { _id: id, status: { $in: [...from] } },
      { $set: set },
      { new: true }
    ).exec();
  }

  /**
   * Claim the request for sending: `approved | failed → sending`, fixing the reference, the
   * gateway and the transfer legs in the SAME atomic update — the double-send guard, mirroring
   * `PayoutRequestRepository.beginTransfer`.
   *
   * - **The claim happens before any HTTP call**, so a double-click loses here, not at the gateway.
   * - **An existing reference is REUSED, never replaced** (`$ifNull`), and so are existing legs —
   *   a retry after a failure carries the SAME `jm_rf_` references, so a gateway that actually
   *   paid (and merely failed to say so) deduplicates the resend on its own idempotency.
   * - **The gateway is fixed the same way**: a reused reference only deduplicates at the gateway
   *   that first received it, so a retry after an administrator switched the payout aggregator
   *   goes back to the original one.
   * - The candidate legs are wrapped in `$literal` so nothing inside them is read as a field path.
   * - A pipeline update bypasses Mongoose's timestamps, so `updated_at` is set by hand.
   */
  async beginTransfer(
    id: string,
    candidate: {
      channel: RefundChannel;
      reference: string;
      gateway: PaymentGatewayName | null;
      legs: IRefundTransferLeg[];
    },
    session?: ClientSession
  ): Promise<IRefundRequest | null> {
    return RefundRequestModel.findOneAndUpdate(
      { _id: id, status: { $in: [...CLAIMABLE_STATUSES] } },
      [
        {
          $set: {
            status: 'sending',
            channel: { $ifNull: ['$channel', candidate.channel] },
            transfer_reference: { $ifNull: ['$transfer_reference', candidate.reference] },
            transfer_gateway: { $ifNull: ['$transfer_gateway', candidate.gateway] },
            transfer_legs: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ['$transfer_legs', []] } }, 0] },
                '$transfer_legs',
                { $literal: candidate.legs },
              ],
            },
            transfer_failure_reason: null,
            transfer_note: null,
            updated_at: '$$NOW',
          },
        },
      ],
      { new: true, session: session ?? null }
    ).exec();
  }

  /** One leg `pending | failed → sending` — immediately before its transfer is posted. */
  async markLegSending(id: string, reference: string): Promise<IRefundRequest | null> {
    return RefundRequestModel.findOneAndUpdate(
      {
        _id: id,
        status: 'sending',
        transfer_legs: { $elemMatch: { reference, status: { $in: ['pending', 'failed'] } } },
      },
      { $set: { 'transfer_legs.$.status': 'sending', 'transfer_legs.$.failure_reason': null } },
      { new: true }
    ).exec();
  }

  /** Stamp the gateway's transfer id on a leg (and on the request when it is leg 0). Never changes status. */
  async setLegGatewayRef(id: string, reference: string, gatewayRef: string | null): Promise<void> {
    if (!gatewayRef) return;
    await RefundRequestModel.updateOne(
      { _id: id, 'transfer_legs.reference': reference },
      { $set: { 'transfer_legs.$.gateway_ref': gatewayRef } }
    );
    await RefundRequestModel.updateOne(
      { _id: id, transfer_reference: reference },
      { $set: { transfer_gateway_ref: gatewayRef } }
    );
  }

  /**
   * A leg's terminal verdict: `sending → succeeded | failed`, compare-and-set on the LEG's
   * status, so a redelivered callback (or the sweep racing it) applies exactly once. Null for
   * the loser.
   */
  async settleLeg(
    id: string,
    reference: string,
    outcome: { succeeded: boolean; gatewayRef: string | null; reason: string | null }
  ): Promise<IRefundRequest | null> {
    return RefundRequestModel.findOneAndUpdate(
      { _id: id, transfer_legs: { $elemMatch: { reference, status: 'sending' } } },
      {
        $set: {
          'transfer_legs.$.status': outcome.succeeded ? 'succeeded' : 'failed',
          'transfer_legs.$.failure_reason': outcome.succeeded ? null : (outcome.reason ?? 'transfer failed').slice(0, 500),
          ...(outcome.gatewayRef ? { 'transfer_legs.$.gateway_ref': outcome.gatewayRef } : {}),
        },
      },
      { new: true }
    ).exec();
  }

  /** Card legs: record Stripe's answer on the payment leg (index-addressed). */
  async markPaymentLegRefunded(id: string, index: number, gatewayRefundRef: string | null): Promise<void> {
    await RefundRequestModel.updateOne(
      { _id: id },
      {
        $set: {
          [`payment_legs.${index}.refunded`]: true,
          [`payment_legs.${index}.gateway_refund_ref`]: gatewayRefundRef,
        },
      }
    );
  }

  /** "Outcome unknown" — kept OFF `transfer_failure_reason`; status untouched. */
  async noteOutcomeUnknown(id: string, note: string): Promise<void> {
    await RefundRequestModel.updateOne({ _id: id, status: 'sending' }, { $set: { transfer_note: note.slice(0, 1000) } });
  }
}

export const refundRequestRepository = new RefundRequestRepository();
