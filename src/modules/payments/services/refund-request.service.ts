import { Types } from 'mongoose';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus, EventBus } from '../../../core/events/event-bus';
import { transactionManager } from '../../../core/database/transaction.manager';
import type { PauseTarget } from '../../earnings/services/earnings-pause.service';
import { EARNINGS_CONFIG } from '../../earnings/config/earnings.config';
import { OrderModel } from '../../orders/order.model';
import { Booking } from '../../booking/models/booking.model';
import { VendorModel } from '../../vendors/vendor.model';
import { PlanPurchaseModel } from '../../billing/models/plan-purchase.model';
import { CreditTopupModel } from '../../billing/models/credit-topup.model';
import { VendorCustomerSyncService } from '../../vendors/services/vendor-customer-sync.service';
import { PaymentTransactionModel } from '../models/payment-transaction.model';
import { RefundTransactionModel } from '../models/refund-transaction.model';
import {
  IRefundRequest,
  IRefundTransferLeg,
  RefundChannel,
  RefundRequestModel,
  RefundEarningsImpact,
  RefundRequesterRole,
  RefundSourceKind,
  ExternalSettlementMethod,
} from '../models/refund-request.model';
import { RefundRequestRepository, refundRequestRepository } from '../repositories/refund-request.repository';
import { PaymentGatewayName } from '../gateways/gateway.interface';
import { getPaymentGateway, gatewaySupportsPayout } from '../gateways/registry';
import { resolvePayoutAggregator } from './payment-routing.service';
import { getPaymentSettingsSync } from './payment-settings.service';
import { PaymentOrchestratorService } from './payment-orchestrator.service';
import {
  applyRefundToPaymentInSession,
  markSourceRefundedInSession,
  sumCompletedRefundsForOrder,
  writeRefundTransactionInSession,
} from './refund-ledger';
import { mintMerchantRef } from '../domain/merchant-reference';
import { computeRefundFee, RefundPaymentChannel } from '../domain/refund-fee';
import { attributeRefund, maxAttributable, RefundReasonKind, ReturnShippingPayer } from '../domain/refund-attribution';
import { maskRefundPhone, resolveRefundDestination } from '../domain/refund-destination';
import {
  largestRemainderSplit,
  planPaymentLegShares,
  planSettleRemainder,
  planTransfers,
  PaymentLegShare,
} from '../domain/refund-transfer-plan';
import {
  aggregateLegStatus,
  canClaim,
  canReject,
  canSettleExternally,
  CLAIMABLE_STATUSES,
  EXTERNALLY_SETTLEABLE_STATUSES,
  externalSettlementMissingProof,
  mayApproveAtCreation,
  REJECTABLE_STATUSES,
  RefundRequestStatus,
  secondApproverRequired,
  typedDestinationMissingProof,
} from '../domain/refund-status';
import {
  CodCollectionCoverage,
  collectionFullyCovered,
  getCodCoveragePort,
  getRefundEarningsPort,
  RefundEarningsPort,
} from '../domain/refund-ports';

/**
 * RefundRequestService — every refund's money-out lifecycle (REFUND-FLOW-PLAN § 3, R2).
 *
 * One service for every source (order, booking, plan purchase, credit top-up) and every way
 * money leaves:
 *
 * | Payment       | Channel       | How                                                         |
 * |---------------|---------------|-------------------------------------------------------------|
 * | card (Stripe) | `card_refund` | `PaymentOrchestratorService.refundCardLeg`, fee 0           |
 * | mobile money  | `payout`      | `createPayout` on the ACTIVE payout gateway, to the payer   |
 * | COD           | `payout`      | only once every collection's cash reached the platform     |
 * | billing       | `payout`      | typed number only — or `external`                           |
 * | any           | `external`    | paid outside the platform, picture proof required          |
 *
 * ── The double-send guard (mirrors `PayoutRequestService.sendPayout`) ──────────
 * Every refusal the platform can PREDICT (no destination, payouts switched off, a short float)
 * happens BEFORE the claim and leaves the request exactly as it was. Then the claim
 * (`approved | failed → sending`, reference + gateway + legs fixed atomically). Only then the
 * gateway call. ⛔ A THROW after the claim leaves the request `sending` with an "outcome
 * unknown" note: the transfer may have gone through, and rolling back would release it for a
 * second send. The callback, the reconciliation sweep or `resolveUnknown` decides it.
 *
 * ── create / approve never throw for a SEND problem ─────────────────────────────
 * Once the request is committed, `create` and `approve` return it whatever the send did — the
 * row's `status` / `transfer_failure_reason` / `transfer_note` say what happened, and the queue
 * shows it. `claimAndSend` / `retry` are the verbs that throw, like `sendPayout`.
 *
 * ── Completion (§ 3.4) ───────────────────────────────────────────────────────
 * ONE transaction: the `refund_transactions` rows (GROSS per payment leg, with fee and net),
 * the payment totals, the source's `payment_status: 'refunded'` on a full refund, and the
 * request's `completed`. Afterwards, best-effort: the earnings recovery port, `payment.refunded`,
 * and the vendor-customer lifetime-spend rollback on a full order refund.
 */

export interface RefundActor {
  id: string | null;
  name: string | null;
}

export interface CreateRefundRequestInput {
  source: { kind: RefundSourceKind; id: string };
  /** GROSS. Default: the most the attribution and the money ceiling allow. */
  amount?: number;
  reasonKind: RefundReasonKind;
  reason?: string | null;
  itemDefective?: boolean | null;
  overridePolicy?: boolean;
  /** A TYPED number (R-7). Requires `destinationProofFileId`. */
  destination?: { phone: string; name?: string | null } | null;
  destinationProofFileId?: string | null;
  requestedBy: { id: string | null; role: RefundRequesterRole; name: string | null };
  /** Ask for an immediate approval + send. Honoured per `mayApproveAtCreation` (R-2). */
  approveNow?: boolean;
  ticketId?: string | null;
  /** ORDER sources only: which payment returns money first (see `refund-legs.ts`). */
  prefer?: 'primary_first' | 'topup_first';
  /**
   * `none` for money that was never allocated (a delivery-fee decrease, an unspent customer-paid
   * return fee — § 6.2): no earnings pause, no clawback, and the amount is bounded by the money
   * ceiling alone (it is delivery money, so the goods-first attribution rule does not apply).
   * Default `clawback`. See `IRefundRequest.earnings_impact`.
   */
  earningsImpact?: RefundEarningsImpact;
}

export type TransferOutcomeSource =
  | { kind: 'gateway' }
  | { kind: 'administrator'; actor: RefundActor; note: string };

export interface SourceFacts {
  kind: RefundSourceKind;
  id: string;
  orderNumber: string | null;
  vendorId: string | null;
  customerId: string | null;
  currency: string;
  paymentChannel: RefundPaymentChannel;
  /** Online legs with their payer, for the payment-leg plan. */
  legs: Array<{
    id: string;
    purpose: 'primary' | 'order_delivery_topup' | 'booking_balance';
    remaining: number;
    gateway: PaymentGatewayName;
    payerPhone: string | null;
    payerName: string | null;
  }>;
  remaining: number;
  goodsAmount: number;
  deliveryAmountPaid: number;
  delivered: boolean;
  returnShippingPayer: ReturnShippingPayer | null;
  codCollections: CodCollectionCoverage[];
}

const conflict = (message: string, details?: Record<string, unknown>) =>
  createAppError(ERROR_CODES.REFUND_REQUEST_STATUS_CONFLICT, 409, message, details);

function pauseTargetOf(row: Pick<IRefundRequest, 'source_kind' | 'source_id' | 'earnings_impact'>): PauseTarget | null {
  // Money nobody was allocated (a delivery-fee refund) has no earnings to pause or recover.
  if (row.earnings_impact === 'none') return null;
  if (row.source_kind === 'order') return { kind: 'order', id: row.source_id.toString() };
  if (row.source_kind === 'booking') return { kind: 'booking', id: row.source_id.toString() };
  return null;
}

/** What a by-hand settlement of `row` covers, and how each payment leg's money left (finding 4). */
function settleRemainderOf(row: IRefundRequest) {
  return planSettleRemainder({
    grossAmount: row.gross_amount,
    netAmount: row.net_amount,
    feeAmount: row.fee_amount,
    destinationSource: row.destination?.source ?? null,
    paymentLegs: row.payment_legs.map((l) => ({ amount: l.amount, payerPhone: l.payer_phone ?? null, refunded: l.refunded === true })),
    transferLegs: row.transfer_legs.map((l) => ({ phone: l.phone, gross: l.gross, amount: l.amount, status: l.status })),
  });
}

function stamp(actor: RefundActor, now = new Date()) {
  return { id: actor.id, name: actor.name, at: now };
}

export class RefundRequestService {
  constructor(
    private readonly repo: RefundRequestRepository = refundRequestRepository,
    private readonly orchestrator: PaymentOrchestratorService = new PaymentOrchestratorService(),
    private readonly vendorCustomerSync: VendorCustomerSyncService = new VendorCustomerSyncService()
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<IRefundRequest | null> {
    return this.repo.findById(id);
  }

  async getByIdOrThrow(id: string): Promise<IRefundRequest> {
    const row = await this.repo.findById(id);
    if (!row) throw createAppError(ERROR_CODES.REFUND_REQUEST_NOT_FOUND, 404, 'Refund request not found');
    return row;
  }

  /** The request a transfer callback names, by any leg's `jm_rf_` reference. */
  async getByTransferReference(reference: string): Promise<IRefundRequest | null> {
    return this.repo.findByTransferReference(reference);
  }

  async findOpenForSource(kind: RefundSourceKind, sourceId: string): Promise<IRefundRequest | null> {
    return this.repo.findOpenBySource(kind, sourceId);
  }

  /**
   * The request that must keep an order's/booking's earnings paused (item 11 of the review): one
   * still OPEN, or a COMPLETED one whose earnings recovery has not run yet (`earnings_settled_at`
   * null — the nightly sweep will run it and close the pause). Null when nothing holds it; an
   * administrator's manual resume is refused otherwise.
   */
  async findHoldingEarningsPause(kind: 'order' | 'booking', sourceId: string): Promise<IRefundRequest | null> {
    const open = await this.repo.findOpenBySource(kind, sourceId);
    if (open) return open;
    return RefundRequestModel.findOne({
      source_kind: kind,
      source_id: new Types.ObjectId(sourceId),
      status: 'completed',
      earnings_impact: 'clawback',
      earnings_settled_at: null,
    }).exec();
  }

  /**
   * READ-ONLY: the facts `create` would build a request from (the money ceiling, the payment
   * legs and their payers, the COD coverage). Exposed for the admin eligibility preview
   * (`refund-eligibility.service.ts`, § 11.7) so the preview and the create can never disagree
   * about what is refundable. Writes nothing.
   */
  async describeSource(kind: RefundSourceKind, id: string): Promise<SourceFacts> {
    if (!Types.ObjectId.isValid(id)) {
      throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_FOUND, 404, 'The order or booking to refund was not found');
    }
    return this.loadSource(kind, id);
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  /**
   * Open a refund request. Validates the amount against the SAME money ceiling the orchestrator
   * enforces (`refundableFor`) and against the attribution rule (C-1, D-5); fixes fee, net,
   * destination and the per-payment plan; pauses the source's earnings (C-4); and, when R-2
   * allows, approves and sends in the same call.
   *
   * Policy eligibility (the vendor's return window, a booking's cancellation policy) is the
   * CALLER's — this service enforces money, not commercial promises.
   */
  async create(input: CreateRefundRequestInput): Promise<IRefundRequest> {
    if (!Types.ObjectId.isValid(input.source.id)) {
      throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_FOUND, 404, 'The order or booking to refund was not found');
    }
    // An open request already stands: refuse BEFORE anything is paused (review finding 7). The
    // unique index below stays the race guard for two creates arriving together.
    if (await this.repo.findOpenBySource(input.source.kind, input.source.id)) {
      throw createAppError(ERROR_CODES.REFUND_ALREADY_OPEN, 409, 'A refund request is already open for this order or booking', {
        sourceKind: input.source.kind,
        sourceId: input.source.id,
      });
    }
    const facts = await this.loadSource(input.source.kind, input.source.id);

    // Amount: within the attribution rule AND the money still refundable.
    const attributionInput = {
      reasonKind: input.reasonKind,
      returnShippingPayer: facts.returnShippingPayer,
      itemDefective: input.itemDefective ?? null,
      goodsAmount: facts.goodsAmount,
      deliveryAmountPaid: facts.deliveryAmountPaid,
      delivered: facts.delivered,
    };
    // Unallocated delivery money (`earningsImpact: 'none'`) is bounded by the money alone: it is
    // not goods, and nobody's earnings carry it, so the goods-first attribution does not apply.
    const unallocated = input.earningsImpact === 'none';
    const ceiling = unallocated ? facts.remaining : Math.min(maxAttributable(attributionInput), facts.remaining);
    if (facts.remaining <= 0) {
      throw createAppError(ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED, 409, 'Everything paid for this has already been refunded');
    }
    const gross = input.amount ?? ceiling;
    const attribution = unallocated
      ? (Number.isInteger(gross) && gross > 0 ? { goods: 0, delivery: gross } : null)
      : attributeRefund(attributionInput, gross);
    if (!Number.isInteger(gross) || gross <= 0 || gross > ceiling || !attribution) {
      throw createAppError(ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX, 400, `The refund amount must be between 1 and ${ceiling}`, {
        requested: input.amount ?? null,
        maxRefundable: ceiling,
      });
    }
    // Billing (review finding 2): completing the refund REVERSES what was bought — the plan is
    // downgraded, the credit pack debited back. Neither can be reversed in part, so a partial
    // billing refund would leave the owner keeping the whole benefit: refused.
    if (facts.paymentChannel === 'billing' && gross !== facts.remaining) {
      throw createAppError(
        ERROR_CODES.REFUND_NOT_ELIGIBLE,
        422,
        `A plan purchase or credit top-up is refunded in full (${facts.remaining}) — refunding it takes the plan or the credits back`,
        { reason: 'billing_full_refund_only', requested: gross, required: facts.remaining }
      );
    }

    // Which payments return the money (online sources).
    let paymentShares: PaymentLegShare[] = [];
    if (facts.legs.length > 0) {
      const planned = planPaymentLegShares(
        facts.legs.map((l) => ({ id: l.id, purpose: l.purpose, remaining: l.remaining, payerPhone: l.payerPhone })),
        gross,
        input.prefer ?? 'primary_first'
      );
      if (!planned) {
        throw createAppError(ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX, 400, `The refund amount must be between 1 and ${ceiling}`, {
          requested: gross,
          maxRefundable: ceiling,
        });
      }
      paymentShares = planned;
    }

    // Fee (R-3, D-1..D-3), from the PAYMENT channel.
    const settings = getPaymentSettingsSync();
    const fee = computeRefundFee(gross, settings.refund_fee_percent, facts.paymentChannel);

    // Destination (R-7, D-6).
    const usedLegs = paymentShares.map((s) => facts.legs.find((l) => l.id === s.paymentTransactionId)!);
    const verdict = resolveRefundDestination({
      paymentChannel: facts.paymentChannel,
      payerLegs: usedLegs.map((l) => ({ phone: l.payerPhone, name: l.payerName })),
      typed: input.destination ?? null,
      proofFileId: input.destinationProofFileId ?? null,
    });
    if (verdict.kind === 'refused' && verdict.reason === 'proof_required') {
      throw createAppError(
        ERROR_CODES.REFUND_DESTINATION_PROOF_REQUIRED,
        422,
        'A typed refund number needs a picture of the customer\'s message giving it'
      );
    }
    if (verdict.kind === 'refused' && verdict.reason === 'typed_phone_invalid') {
      throw createAppError(ERROR_CODES.REFUND_NO_DESTINATION, 422, 'The typed number is not a valid phone number (use +237…)', {
        reason: 'typed_phone_invalid',
      });
    }
    const destination = verdict.kind === 'resolved' ? verdict.destination : null;
    const canSendSomewhere = destination !== null || facts.paymentChannel === 'card';

    const approveNow = mayApproveAtCreation({
      requestedByRole: input.requestedBy.role,
      approveNow: input.approveNow === true,
      destinationSource: destination?.source ?? null,
      overridePolicy: input.overridePolicy === true,
      paymentChannel: facts.paymentChannel,
    });
    if (approveNow && !canSendSomewhere && input.requestedBy.role === 'admin') {
      throw createAppError(
        ERROR_CODES.REFUND_NO_DESTINATION,
        422,
        'There is no number to send this refund to — type one with proof, or settle it externally',
        { reason: 'no_destination' }
      );
    }
    const status: RefundRequestStatus = approveNow && canSendSomewhere ? 'approved' : 'awaiting_approval';

    // Resolve the earnings port BEFORE anything is written: a missing port must fail here, not
    // after a request exists that nothing paused.
    const target: PauseTarget | null = !unallocated && (input.source.kind === 'order' || input.source.kind === 'booking')
      ? { kind: input.source.kind, id: input.source.id }
      : null;
    const earnings: RefundEarningsPort | null = target ? getRefundEarningsPort() : null;

    const id = new Types.ObjectId();
    // Pause FIRST (C-4). `pause()` is a no-op over an existing pause; `raisedPause` says whether
    // THIS call raised it, which is the only pause a failed create may lift (review finding 7).
    const raisedPause = earnings && target ? (await earnings.onRequestOpened(target, id.toString())) === true : false;

    const now = new Date();
    let row: IRefundRequest;
    try {
      row = await this.repo.create({
        _id: id,
        source_kind: input.source.kind,
        source_id: new Types.ObjectId(input.source.id),
        order_number: facts.orderNumber,
        vendor_id: facts.vendorId ? new Types.ObjectId(facts.vendorId) : null,
        customer_id: facts.customerId ? new Types.ObjectId(facts.customerId) : null,
        reason_kind: input.reasonKind,
        reason: input.reason?.trim() || null,
        item_defective: input.itemDefective ?? null,
        override_policy: input.overridePolicy === true,
        attribution,
        gross_amount: gross,
        fee_rate: fee.feeRate,
        fee_amount: fee.feeAmount,
        net_amount: fee.netAmount,
        currency: facts.currency,
        payment_channel: facts.paymentChannel,
        channel: null,
        destination,
        destination_proof_file_id:
          destination?.source === 'typed' && input.destinationProofFileId
            ? new Types.ObjectId(input.destinationProofFileId)
            : null,
        cod_collection_ids: facts.codCollections
          .filter((c) => c.status === 'collected')
          .map((c) => new Types.ObjectId(c.collectionId)),
        status,
        requested_by: input.requestedBy,
        approved_by: status === 'approved' ? stamp({ id: input.requestedBy.id, name: input.requestedBy.name ?? input.requestedBy.role }, now) : null,
        payment_legs: paymentShares.map((s) => {
          const leg = facts.legs.find((l) => l.id === s.paymentTransactionId)!;
          return {
            payment_transaction_id: new Types.ObjectId(leg.id),
            purpose: leg.purpose,
            gateway: leg.gateway,
            amount: s.amount,
            payer_phone: leg.payerPhone,
            gateway_refund_ref: null,
            refunded: false,
          };
        }),
        ticket_id: input.ticketId && Types.ObjectId.isValid(input.ticketId) ? new Types.ObjectId(input.ticketId) : null,
        earnings_impact: unallocated ? 'none' : 'clawback',
      });
    } catch (error: any) {
      // Compensate ONLY a pause this call raised, and only while no other request is open on
      // the source: a concurrent create that won the unique index is covered by that same pause
      // (its own `pause()` was the no-op), so lifting it would unpause a live refund.
      if (earnings && target && raisedPause) {
        // Unreadable → assume a winner exists: a pause left standing is visible, a lifted one is not.
        const winner = await this.repo.findOpenBySource(input.source.kind, input.source.id).catch(() => true as const);
        if (!winner) {
          await earnings.onRequestClosedWithoutRefund(target, id.toString()).catch((e) =>
            console.error('[RefundRequestService] could not resume earnings after a failed create:', e)
          );
        }
      }
      if (error?.code === 11000) {
        throw createAppError(ERROR_CODES.REFUND_ALREADY_OPEN, 409, 'A refund request is already open for this order or booking', {
          sourceKind: input.source.kind,
          sourceId: input.source.id,
        });
      }
      throw error;
    }

    if (row.status === 'approved') {
      await this.dispatchQuietly(row.id);
      return this.getByIdOrThrow(row.id);
    }
    this.announceStatus(row);
    return row;
  }

  // ── Approve / reject ─────────────────────────────────────────────────────────

  /**
   * `awaiting_approval → approved`, then send (or, for COD, wait for cash). A TYPED number needs
   * a second administrator (R-7): the approver must not be the one who typed it.
   */
  async approve(id: string, actor: RefundActor): Promise<IRefundRequest> {
    const row = await this.getByIdOrThrow(id);
    if (row.status !== 'awaiting_approval') {
      throw conflict('Only a refund awaiting approval can be approved', { status: row.status });
    }
    if (
      secondApproverRequired({
        destinationSource: row.destination?.source ?? null,
        requestedById: row.requested_by?.id ?? null,
        approverId: actor.id,
      })
    ) {
      throw createAppError(
        ERROR_CODES.REFUND_SECOND_APPROVER_REQUIRED,
        409,
        'A refund to a typed number must be approved by a different administrator from the one who typed it'
      );
    }
    if (typedDestinationMissingProof(row.destination?.source ?? null, row.destination_proof_file_id?.toString())) {
      throw createAppError(
        ERROR_CODES.REFUND_DESTINATION_PROOF_REQUIRED,
        422,
        'A typed refund number needs a picture of the customer\'s message giving it'
      );
    }
    if (!row.destination && row.payment_channel !== 'card') {
      throw createAppError(
        ERROR_CODES.REFUND_NO_DESTINATION,
        422,
        'There is no number to send this refund to — type one with proof, or settle it externally',
        { reason: 'no_destination' }
      );
    }

    const approved = await this.repo.transition(id, ['awaiting_approval'], 'approved', { approved_by: stamp(actor) });
    if (!approved) throw conflict('This refund request changed while you were approving it — reload it');

    await this.dispatchQuietly(id);
    return this.getByIdOrThrow(id);
  }

  /**
   * `awaiting_approval | failed → rejected`, and resume the earnings pause if it is still the
   * refund's own (C-4). ⛔ Never from `sending` (a transfer may be in flight), and never from a
   * `failed` request part of whose money already left.
   */
  async reject(id: string, actor: RefundActor, reason: string): Promise<IRefundRequest> {
    const row = await this.getByIdOrThrow(id);
    if (!canReject(row.status)) {
      throw conflict(
        row.status === 'sending'
          ? 'This refund is being sent — it cannot be rejected until its transfer has an outcome'
          : 'Only a refund awaiting approval, or one that failed, can be rejected',
        { status: row.status }
      );
    }
    if (row.transfer_legs.some((l) => l.status === 'succeeded') || row.payment_legs.some((l) => l.refunded)) {
      throw conflict('Part of this refund was already paid — settle the rest externally instead of rejecting it', {
        status: row.status,
      });
    }
    const target = pauseTargetOf(row);
    const earnings = target ? getRefundEarningsPort() : null;

    const rejected = await this.repo.transition(id, REJECTABLE_STATUSES, 'rejected', {
      rejected_by: stamp(actor),
      rejection_reason: reason.trim() || null,
    });
    if (!rejected) throw conflict('This refund request changed while you were rejecting it — reload it');

    if (earnings && target) {
      await earnings.onRequestClosedWithoutRefund(target, id).catch((e) =>
        console.error('[RefundRequestService] could not resume earnings after a rejection:', e)
      );
    }
    this.announceStatus(rejected);
    return rejected;
  }

  // ── Sending ──────────────────────────────────────────────────────────────────

  /** `retry`: claim again (`failed`, or an `approved` row whose send was refused before its claim). */
  async retry(id: string): Promise<IRefundRequest> {
    const out = await this.claimAndSend(id);
    this.announceStatus(out);
    return out;
  }

  /**
   * Claim and send. Throws for a refusal it can predict (payouts off, short float, no number)
   * with the request left as it was, and rethrows a gateway throw AFTER the claim with the
   * request left `sending` and an outcome-unknown note.
   */
  async claimAndSend(id: string): Promise<IRefundRequest> {
    const row = await this.getByIdOrThrow(id);
    if (row.status === 'sending') {
      throw conflict('This refund is already being sent', { status: row.status });
    }
    if (!canClaim(row.status)) {
      throw conflict('Only an approved or failed refund can be sent', { status: row.status });
    }

    // COD (R-4, R-5, R-6): never sends until EVERY collection's cash reached the platform.
    if (row.payment_channel === 'cod' && row.status === 'approved' && !(await this.codCovered(row))) {
      const waiting = await this.repo.transition(id, ['approved'], 'waiting_for_cash', { transfer_failure_reason: null });
      if (!waiting) return this.getByIdOrThrow(id);
      // Review finding 9: the `cod.collections.settled` event may have fired BETWEEN the coverage
      // read above and this write — it found no `waiting_for_cash` row then, and will not fire
      // again. Re-check once now; if covered, release it here instead of waiting for the night.
      if (await this.codCovered(waiting).catch(() => false)) {
        const released = await this.repo.transition(id, ['waiting_for_cash'], 'approved', {});
        if (released) return this.claimAndSend(id);
      }
      return waiting;
    }

    // Review finding 5: money may have left this source by another road since the request was
    // created (a delivery-fee refund paid by hand). Never send more than still remains.
    await this.assertStillRefundable(row);

    if (!row.destination && row.payment_channel === 'card') return this.sendCard(row);
    if (!row.destination) {
      throw createAppError(
        ERROR_CODES.REFUND_NO_DESTINATION,
        422,
        'There is no number to send this refund to — type one with proof, or settle it externally',
        { reason: 'no_destination' }
      );
    }
    return this.sendPayout(row);
  }

  private async sendCard(row: IRefundRequest): Promise<IRefundRequest> {
    if (row.payment_legs.some((l) => l.gateway !== 'STRIPE')) {
      throw createAppError(
        ERROR_CODES.REFUND_NO_DESTINATION,
        422,
        'Part of this payment was not made by card — type a number with proof, or settle it externally',
        { reason: 'mixed_payment' }
      );
    }
    const claimed = await this.repo.beginTransfer(row.id, {
      channel: 'card_refund',
      reference: mintMerchantRef('rf'),
      gateway: 'STRIPE',
      legs: [],
    });
    if (!claimed) throw conflict('Another action claimed this refund first — reload it');

    for (let i = 0; i < claimed.payment_legs.length; i += 1) {
      const leg = claimed.payment_legs[i];
      if (leg.refunded) continue;
      let result: Awaited<ReturnType<PaymentOrchestratorService['refundCardLeg']>>;
      try {
        result = await this.orchestrator.refundCardLeg({
          paymentTransactionId: leg.payment_transaction_id.toString(),
          amount: leg.amount,
          reason: claimed.reason ?? undefined,
          // Reference + leg: a retry of an attempt whose answer was lost is deduplicated by Stripe.
          idempotencyKey: `${claimed.transfer_reference}:${i}`,
          metadata: {
            refundRequestId: claimed.id,
            [claimed.source_kind === 'booking' ? 'bookingId' : 'orderId']: claimed.source_id.toString(),
          },
        });
      } catch (error) {
        if (error instanceof AppError && error.statusCode < 500) {
          // A knowable refusal raised before Stripe was called — nothing left, so it is a failure.
          return (await this.repo.transition(claimed.id, ['sending'], 'failed', { transfer_failure_reason: error.message }))
            ?? this.getByIdOrThrow(claimed.id);
        }
        await this.repo
          .noteOutcomeUnknown(claimed.id, `Outcome unknown: Stripe gave no answer we could read for ${claimed.transfer_reference}:${i}. `
            + 'Check the Stripe dashboard before doing anything.')
          .catch(() => undefined);
        throw error;
      }
      if (!result.success) {
        return (await this.repo.transition(claimed.id, ['sending'], 'failed', {
          transfer_failure_reason: (result.error ?? 'Stripe refused the refund').slice(0, 500),
        })) ?? this.getByIdOrThrow(claimed.id);
      }
      await this.repo.markPaymentLegRefunded(claimed.id, i, result.refundRef);
    }

    return (await this.complete(claimed.id, { channel: 'card_refund', fromStatuses: ['sending'] })) ?? this.getByIdOrThrow(claimed.id);
  }

  private async sendPayout(row: IRefundRequest): Promise<IRefundRequest> {
    const destination = row.destination!;
    // A request already sent keeps the gateway it was sent through (its references only
    // deduplicate there); a never-sent one takes the active payout aggregator.
    const chosen = (row.transfer_gateway as PaymentGatewayName | null) ?? resolvePayoutAggregator();
    if (!chosen || !gatewaySupportsPayout(chosen)) {
      await this.repo.annotate(row.id, CLAIMABLE_STATUSES, { transfer_failure_reason: 'payout_unavailable' });
      throw createAppError(
        ERROR_CODES.REFUND_PAYOUT_UNAVAILABLE,
        422,
        'Automatic refunds cannot be sent on this deployment right now — settle this refund externally',
        { gateway: chosen }
      );
    }
    let gateway = getPaymentGateway(chosen);

    const legs = row.transfer_legs.length > 0 ? row.transfer_legs : this.candidateLegs(row);
    const toSend = legs.filter((l) => l.status !== 'succeeded');
    const required = toSend.reduce((s, l) => s + l.amount, 0);

    // The float pre-check — a knowable no, before the claim (§ 3.2).
    const balance = await gateway.payoutBalance?.(row.currency, toSend[0]?.phone).catch(() => null);
    if (balance && balance.available < required) {
      await this.repo.annotate(row.id, CLAIMABLE_STATUSES, { transfer_failure_reason: 'insufficient_gateway_balance' });
      throw createAppError(
        ERROR_CODES.REFUND_INSUFFICIENT_GATEWAY_BALANCE,
        409,
        'The payout account does not hold enough money to send this refund yet',
        { reason: 'insufficient_gateway_balance', required, available: balance.available, currency: balance.currency }
      );
    }

    // The claim. Everything above could be retried freely; nothing below can.
    const claimed = await this.repo.beginTransfer(row.id, {
      channel: 'payout',
      reference: legs[0].reference,
      gateway: chosen,
      legs,
    });
    if (!claimed) throw conflict('Another action claimed this refund first — reload it');
    if (claimed.transfer_gateway && claimed.transfer_gateway !== chosen) {
      gateway = getPaymentGateway(claimed.transfer_gateway);
    }

    for (const leg of claimed.transfer_legs) {
      if (leg.status !== 'pending' && leg.status !== 'failed') continue;
      const marked = await this.repo.markLegSending(claimed.id, leg.reference);
      if (!marked) continue;

      let result: Awaited<ReturnType<NonNullable<typeof gateway.createPayout>>>;
      try {
        result = await gateway.createPayout!({
          reference: leg.reference,
          amount: leg.amount,
          currency: claimed.currency,
          phone: leg.phone,
          name: destination.name,
          description: `Refund ${claimed.currency} ${leg.amount}${claimed.order_number ? ` for ${claimed.order_number}` : ''}`,
        });
      } catch (error) {
        const note =
          `Outcome unknown: ${claimed.transfer_gateway ?? 'the gateway'} gave no answer we could read. `
          + `Check its dashboard for reference ${leg.reference} before doing anything; `
          + 'do not retry or settle this refund until you know whether the money left.';
        await this.repo.noteOutcomeUnknown(claimed.id, note).catch(() => undefined);
        throw error;
      }

      if (!result.success) {
        await this.repo.settleLeg(claimed.id, leg.reference, {
          succeeded: false,
          gatewayRef: result.gatewayRef,
          reason: result.message ?? 'The payment gateway refused the transfer',
        });
        continue;
      }
      await this.repo.setLegGatewayRef(claimed.id, leg.reference, result.gatewayRef);
    }

    return (await this.settleAggregate(claimed.id)) ?? this.getByIdOrThrow(claimed.id);
  }

  /** The transfers for a never-sent payout refund, each with its own `jm_rf_` reference. */
  private candidateLegs(row: IRefundRequest): IRefundTransferLeg[] {
    const shares: PaymentLegShare[] = row.payment_legs.length > 0
      ? row.payment_legs.map((l) => ({
          paymentTransactionId: l.payment_transaction_id.toString(),
          purpose: (l.purpose as PaymentLegShare['purpose']) ?? null,
          amount: l.amount,
          payerPhone: l.payer_phone,
        }))
      : [{ paymentTransactionId: null, purpose: null, amount: row.gross_amount, payerPhone: null }];
    // A typed number (or a leg-less source) is one transfer; a payer refund groups by number.
    const single = row.destination!.source === 'typed' || row.payment_legs.length === 0 ? row.destination!.phone : null;
    const planned = planTransfers(shares, row.fee_amount, single);
    if (!planned || planned.length === 0) {
      throw createAppError(
        ERROR_CODES.REFUND_NO_DESTINATION,
        422,
        'A payment behind this refund has no readable number — type one with proof, or settle it externally',
        { reason: 'no_destination' }
      );
    }
    return planned.map((t) => ({
      phone: t.phone,
      amount: t.amount,
      gross: t.gross,
      reference: mintMerchantRef('rf'),
      gateway_ref: null,
      status: 'pending',
      failure_reason: null,
    }));
  }

  /**
   * Apply a gateway verdict to the transfer leg OUR reference names (webhook settle, the
   * reconciliation sweep). Idempotent: the leg write is a compare-and-set on `sending`, so a
   * redelivered callback applies once and answers null.
   */
  async applyTransferOutcome(
    reference: string,
    outcome: { settled: boolean; gatewayRef: string | null; reason: string | null },
    source: TransferOutcomeSource = { kind: 'gateway' }
  ): Promise<IRefundRequest | null> {
    const row = await this.repo.findByTransferReference(reference);
    if (!row) return null;
    const reason = outcome.settled
      ? null
      : source.kind === 'administrator'
        ? `${outcome.reason ?? 'failed'} (confirmed by administrator ${source.actor.name ?? '(unnamed)'}: ${source.note})`
        : outcome.reason;
    const settled = await this.repo.settleLeg(row.id, reference, {
      succeeded: outcome.settled,
      gatewayRef: outcome.gatewayRef,
      reason,
    });
    if (!settled) return null;
    return this.settleAggregate(row.id);
  }

  /** Once no leg is `sending`: all succeeded → complete; otherwise → `failed` (retry sends the rest). */
  private async settleAggregate(id: string): Promise<IRefundRequest | null> {
    const row = await this.getByIdOrThrow(id);
    if (row.status !== 'sending' || row.channel !== 'payout') return row;
    const verdict = aggregateLegStatus(row.transfer_legs.map((l) => l.status));
    if (verdict === 'sending') return row;
    if (verdict === 'failed') {
      const reason = row.transfer_legs.find((l) => l.status === 'failed')?.failure_reason ?? 'A transfer was not sent';
      return this.repo.transition(id, ['sending'], 'failed', { transfer_failure_reason: reason });
    }
    return this.complete(id, { channel: 'payout', fromStatuses: ['sending'] });
  }

  // ── External settlement & the manual exit ────────────────────────────────────

  /**
   * Record a refund paid OUTSIDE the platform (R-7b): picture proof required, never from
   * `sending`. Completes the request exactly like a transfer would — the ledger, the payment
   * totals and the earnings recovery all follow. The fee still applies (D-1).
   */
  async settleExternal(
    id: string,
    input: { method: ExternalSettlementMethod; reference?: string | null; proofFileId: string | null | undefined },
    actor: RefundActor
  ): Promise<IRefundRequest> {
    if (externalSettlementMissingProof(input.proofFileId) || !Types.ObjectId.isValid(String(input.proofFileId))) {
      throw createAppError(ERROR_CODES.REFUND_EXTERNAL_PROOF_REQUIRED, 422, 'A refund paid outside the platform needs a picture proof');
    }
    const row = await this.getByIdOrThrow(id);
    if (!canSettleExternally(row.status)) {
      throw conflict(
        row.status === 'sending'
          ? 'This refund is being sent — it cannot be settled by hand until its transfer has an outcome'
          : 'This refund can no longer be settled',
        { status: row.status }
      );
    }
    // Review finding 4: after a multi-transfer refund part of which already left (a succeeded
    // transfer leg, or a card leg Stripe refunded), the administrator pays ONLY the remainder.
    // The succeeded parts are recorded as what they were (`payout` / `card_refund`) by `complete`.
    const split = settleRemainderOf(row);
    if (split.remainderGross <= 0) {
      throw conflict('Everything in this refund was already sent through the platform — there is nothing left to pay by hand', {
        status: row.status,
      });
    }
    const completed = await this.complete(id, {
      channel: 'external',
      fromStatuses: EXTERNALLY_SETTLEABLE_STATUSES,
      externalSettlement: {
        method: input.method,
        reference: input.reference?.trim() || null,
        proof_file_id: new Types.ObjectId(String(input.proofFileId)),
        settled_by: { id: actor.id, name: actor.name },
        settled_at: new Date(),
        gross_amount: split.remainderGross,
        net_amount: split.remainderNet,
      },
    });
    if (!completed) throw conflict('This refund request changed while you were settling it — reload it');
    return completed;
  }

  /**
   * An administrator resolves a request stuck in `sending` — "arrived" or "failed" — after the
   * same minimum age the reconciliation sweep waits (ADR-024's resolve-unknown verb).
   */
  async resolveUnknown(
    id: string,
    input: { outcome: 'arrived' | 'failed'; note: string },
    actor: RefundActor,
    now: Date = new Date()
  ): Promise<IRefundRequest> {
    const row = await this.getByIdOrThrow(id);
    if (row.status !== 'sending') throw conflict('Only a refund being sent can be resolved by hand', { status: row.status });
    const settleAfter = new Date(row.updated_at.getTime() + EARNINGS_CONFIG.PAYOUT_RECONCILE_MIN_AGE_MINUTES * 60_000);
    if (now < settleAfter) {
      throw conflict('This transfer is too recent to resolve by hand — its callback may still arrive', {
        settleAfter: settleAfter.toISOString(),
      });
    }
    const source: TransferOutcomeSource = { kind: 'administrator', actor, note: input.note };
    await this.repo.annotate(id, ['sending'], {
      transfer_note: `Resolved as ${input.outcome} by ${actor.name ?? 'an administrator'}: ${input.note}`.slice(0, 1000),
    });

    if (row.channel === 'card_refund') {
      if (input.outcome === 'failed') {
        return (await this.repo.transition(id, ['sending'], 'failed', {
          transfer_failure_reason: `Resolved as failed by ${actor.name ?? 'an administrator'}: ${input.note}`.slice(0, 500),
        })) ?? this.getByIdOrThrow(id);
      }
      for (let i = 0; i < row.payment_legs.length; i += 1) {
        if (!row.payment_legs[i].refunded) await this.repo.markPaymentLegRefunded(id, i, null);
      }
      return (await this.complete(id, { channel: 'card_refund', fromStatuses: ['sending'] })) ?? this.getByIdOrThrow(id);
    }

    for (const leg of row.transfer_legs) {
      if (leg.status !== 'sending') continue;
      await this.applyTransferOutcome(
        leg.reference,
        { settled: input.outcome === 'arrived', gatewayRef: leg.gateway_ref, reason: 'resolved as failed' },
        source
      );
    }
    return (await this.settleAggregate(id)) ?? this.getByIdOrThrow(id);
  }

  // ── COD ──────────────────────────────────────────────────────────────────────

  private async codCovered(row: IRefundRequest): Promise<boolean> {
    const needed = row.cod_collection_ids.map((c) => c.toString());
    if (needed.length === 0) return false;
    const coverage = await getCodCoveragePort().coverageForOrder(row.source_id.toString());
    return needed.every((id) => {
      const c = coverage.find((x) => x.collectionId === id);
      return c !== undefined && collectionFullyCovered(c);
    });
  }

  /**
   * Collections became fully covered (`cod.collections.settled`, § 11.4): move every
   * `waiting_for_cash` request that needed them to `approved`, and send it. Returns how many
   * moved. A request still missing another collection's cash keeps waiting.
   */
  async onCollectionsSettled(collectionIds: string[]): Promise<number> {
    const rows = await this.repo.findWaitingForCollections(collectionIds);
    return this.releaseCovered(rows);
  }

  /** The backstop sweep for a lost event (wave 2 schedules it nightly). */
  async recheckWaitingForCash(limit = 100): Promise<number> {
    return this.releaseCovered(await this.repo.findWaitingForCash(limit));
  }

  private async releaseCovered(rows: IRefundRequest[]): Promise<number> {
    let moved = 0;
    for (const row of rows) {
      try {
        if (!(await this.codCovered(row))) continue;
        const approved = await this.repo.transition(row.id, ['waiting_for_cash'], 'approved', {});
        if (!approved) continue;
        moved += 1;
        await this.dispatchQuietly(row.id);
      } catch (error) {
        console.error(`[RefundRequestService] could not release COD refund ${row.id}:`, error);
      }
    }
    return moved;
  }

  // ── Completion (§ 3.4) ───────────────────────────────────────────────────────

  /**
   * Complete in ONE transaction, then the best-effort steps. Returns null when the request was
   * no longer in `fromStatuses` (somebody else completed it — idempotent).
   */
  async complete(
    id: string,
    opts: {
      channel: RefundChannel;
      fromStatuses: readonly RefundRequestStatus[];
      externalSettlement?: IRefundRequest['external_settlement'];
    }
  ): Promise<IRefundRequest | null> {
    const row = await this.getByIdOrThrow(id);
    if (!opts.fromStatuses.includes(row.status)) return null;

    // Resolve the port BEFORE writing: a missing port fails here, with nothing committed.
    if (pauseTargetOf(row)) getRefundEarningsPort();
    // Review finding 5, at completion: a hand payment has not happened yet, so it is refused when
    // the source no longer holds this much. A transfer or card refund that already ARRIVED is
    // recorded whatever the ceiling says now — the ledger must state what left — but loudly.
    if (opts.channel === 'external') {
      await this.assertStillRefundable(row);
    } else {
      await this.assertStillRefundable(row).catch((error) =>
        console.error(`[RefundRequestService] refund ${row.id} arrived above what the source still held — recording it anyway:`, error)
      );
    }
    const full = await this.fullRefundVerdict(row);

    const now = new Date();
    // WITH RETRY: the gateway callback, the reconciliation sweep and resolve-unknown can race to
    // complete the same request. Without a retry the loser surfaces a TransientTransactionError
    // (WriteConflict) instead of re-reading and returning the idempotent `null`. The callback is
    // retry-safe: it re-reads `fresh` inside the session and holds no state across attempts.
    // (Found by verify:refund-flow-live on a fresh replica set, 2026-10-05.)
    const completed = await transactionManager.runInTransactionWithRetry(async (session) => {
      const fresh = await RefundRequestModel.findOne({ _id: row._id, status: { $in: [...opts.fromStatuses] } }).session(session);
      if (!fresh) return null;

      const transactionIds: Types.ObjectId[] = [];
      if (fresh.source_kind === 'order' || fresh.source_kind === 'booking') {
        const sourceField = fresh.source_kind === 'order' ? { orderId: fresh.source_id } : { bookingId: fresh.source_id };
        const initiatedBy = fresh.requested_by?.id && Types.ObjectId.isValid(fresh.requested_by.id)
          ? new Types.ObjectId(fresh.requested_by.id)
          : fresh.source_id;
        const common = {
          ...sourceField,
          vendorId: fresh.vendor_id,
          userId: fresh.customer_id,
          currency: fresh.currency,
          reason: fresh.reason ?? undefined,
          status: 'completed' as const,
          refundRequestId: fresh._id,
          channel: opts.channel,
          initiatedBy,
          initiatedByRole: fresh.requested_by?.role ?? 'system',
          completedAt: now,
        };

        if (fresh.payment_legs.length > 0) {
          // Settled by hand: each payment leg is recorded as the channel ITS money actually left
          // through — a succeeded transfer stays `payout`, a refunded card leg `card_refund`, and
          // only the remainder is `external` (review finding 4).
          const byHand = opts.channel === 'external' ? settleRemainderOf(fresh) : null;
          const fees = byHand
            ? byHand.legs.map((l) => l.fee)
            : largestRemainderSplit(fresh.fee_amount, fresh.payment_legs.map((l) => l.amount));
          for (let i = 0; i < fresh.payment_legs.length; i += 1) {
            const leg = fresh.payment_legs[i];
            const ledger = await writeRefundTransactionInSession(
              {
                ...common,
                channel: byHand ? byHand.legs[i].channel : opts.channel,
                paymentTransactionId: leg.payment_transaction_id,
                gateway: leg.gateway,
                gatewayRefundRef: leg.gateway_refund_ref ?? fresh.transfer_reference ?? undefined,
                refundAmount: leg.amount,
                feeAmount: fees[i],
                netAmount: leg.amount - fees[i],
              },
              session
            );
            transactionIds.push(ledger._id as Types.ObjectId);
            await applyRefundToPaymentInSession(leg.payment_transaction_id, leg.amount, session);
          }
        } else {
          // COD (or a leg-less source): one row, no payment behind it.
          const ledger = await writeRefundTransactionInSession(
            {
              ...common,
              paymentTransactionId: null,
              gateway: null,
              gatewayRefundRef: fresh.transfer_reference ?? undefined,
              refundAmount: fresh.gross_amount,
              feeAmount: fresh.fee_amount,
              netAmount: fresh.net_amount,
            },
            session
          );
          transactionIds.push(ledger._id as Types.ObjectId);
        }

        if (full.fullyRefunded) {
          await markSourceRefundedInSession({ kind: fresh.source_kind, id: fresh.source_id.toString() }, session);
        }
      }

      return RefundRequestModel.findOneAndUpdate(
        { _id: fresh._id, status: { $in: [...opts.fromStatuses] } },
        {
          $set: {
            status: 'completed',
            completed_at: now,
            channel: opts.channel,
            refund_transaction_ids: transactionIds,
            transfer_failure_reason: null,
            ...(opts.externalSettlement ? { external_settlement: opts.externalSettlement } : {}),
          },
        },
        { new: true, session }
      );
    });
    if (!completed) return null;

    // ── Best-effort, after commit ────────────────────────────────────────────
    // The earnings recovery (order/booking) or the billing reversal (plan/credits). A failure is
    // logged and left for the nightly sweep (`settleUnsettledCompleted`): the step's marker
    // stays null until it succeeds (review findings 2 and 6).
    try {
      await this.settleAftermath(completed);
    } catch (error) {
      console.error(`[RefundRequestService] post-completion step failed for refund ${completed.id} (the nightly sweep retries):`, error);
    }

    if (completed.source_kind === 'order' || completed.source_kind === 'booking') {
      const isBooking = completed.source_kind === 'booking';
      const es = completed.channel === 'external' ? completed.external_settlement : null;
      const handPaid = es && typeof es.gross_amount === 'number' && typeof es.net_amount === 'number'
        ? { gross: es.gross_amount, net: es.net_amount }
        : null;
      eventBus.publish('payment.refunded', {
        eventType: 'payment.refunded',
        aggregateId: completed.source_id.toString(),
        payload: {
          ...(isBooking ? { bookingId: completed.source_id.toString() } : { orderId: completed.source_id.toString() }),
          sourceKind: completed.source_kind,
          vendorId: completed.vendor_id?.toString() ?? null,
          refundId: completed.refund_transaction_ids[completed.refund_transaction_ids.length - 1]?.toString() ?? null,
          refundRequestId: completed.id,
          // `amount` is what the CUSTOMER receives through THIS channel — the notification's figure.
          // Settled by hand after part of it was already sent: only the remainder paid by hand
          // (review finding 4); `totalNetAmount` is the whole refund.
          amount: handPaid ? handPaid.net : completed.net_amount,
          grossAmount: handPaid ? handPaid.gross : completed.gross_amount,
          feeAmount: handPaid ? handPaid.gross - handPaid.net : completed.fee_amount,
          feeRate: completed.fee_rate,
          netAmount: handPaid ? handPaid.net : completed.net_amount,
          totalNetAmount: completed.net_amount,
          currency: completed.currency,
          channel: completed.channel,
          destinationMasked: maskRefundPhone(completed.destination?.phone ?? null),
          fullyRefunded: full.fullyRefunded,
        },
        occurredAt: new Date(),
      }).catch(() => { /* non-blocking */ });

      if (!isBooking && full.fullyRefunded && completed.vendor_id && completed.customer_id) {
        try {
          await this.vendorCustomerSync.recordFullRefund(completed.vendor_id, completed.customer_id, full.sourceTotal);
        } catch (error) {
          console.error('[RefundRequestService] Failed to sync vendor customer on refund:', error);
        }
      }
    }

    return completed;
  }

  /** Is the source square after this refund? Read before the transaction, like the orchestrator. */
  private async fullRefundVerdict(row: IRefundRequest): Promise<{ fullyRefunded: boolean; sourceTotal: number }> {
    if (row.source_kind === 'order') {
      const order = await OrderModel.findById(row.source_id).select('total_amount').lean<{ total_amount: number } | null>();
      const total = order?.total_amount ?? 0;
      const already = await sumCompletedRefundsForOrder(row.source_id.toString());
      return { fullyRefunded: total > 0 && already + row.gross_amount >= total, sourceTotal: total };
    }
    if (row.source_kind === 'booking') {
      // The primary charge AND a settled balance payment (decision 9, fixed by the entry-points
      // workstream): a booking whose balance was paid holds money in both, and "fully refunded"
      // means both came back.
      const paid = await PaymentTransactionModel.find({
        bookingId: row.source_id,
        status: { $in: ['SUCCEEDED', 'REFUNDED'] },
        purpose: { $in: ['primary', 'booking_balance', null] },
      }).select('amountSnapshot').lean<Array<{ amountSnapshot: number }>>();
      const [tally] = await RefundTransactionModel.aggregate<{ total: number }>([
        { $match: { bookingId: row.source_id, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$refundAmount' } } },
      ]);
      const total = paid.reduce((s, t) => s + (Number(t.amountSnapshot) || 0), 0);
      return { fullyRefunded: total > 0 && (tally?.total ?? 0) + row.gross_amount >= total, sourceTotal: total };
    }
    return { fullyRefunded: false, sourceTotal: 0 };
  }

  // ── After completion: the step that must not be lost (review findings 2 and 6) ───

  /**
   * The post-commit consequence of a COMPLETED request, stamped on the request once it succeeded:
   *  - order/booking with `earnings_impact: 'clawback'` → the port's `onRefundCompleted` (claw back
   *    by attribution, then close the pause), then `earnings_settled_at`. `applyRefund` is
   *    idempotent on the refund key, so a re-run moves nothing twice;
   *  - plan purchase / credit top-up → reverse what was bought (the plan downgraded, the credits
   *    debited back — the same reversals a lost card dispute uses), then `billing_reversed_at`.
   *    Both reversals are no-ops once the purchase is no longer `paid`.
   * Throws on failure with the marker still null — the nightly sweep retries.
   */
  async settleAftermath(row: IRefundRequest): Promise<void> {
    if (row.status !== 'completed') return;
    if (row.source_kind === 'plan_purchase' || row.source_kind === 'credit_topup') {
      if (row.billing_reversed_at) return;
      await this.reverseBillingBenefit(row);
      await this.repo.stampCompletedMarker(row.id, 'billing_reversed_at', new Date());
      return;
    }
    const target = pauseTargetOf(row);
    if (!target || row.earnings_settled_at) return;
    await getRefundEarningsPort().onRefundCompleted({
      refundKey: row.id,
      target,
      attribution: { goods: row.attribution.goods, delivery: row.attribution.delivery },
      codCollectionIds: row.cod_collection_ids.map((c) => c.toString()),
    });
    await this.repo.stampCompletedMarker(row.id, 'earnings_settled_at', new Date());
  }

  /**
   * The nightly backstop for `settleAftermath` (run by `RefundCashRecheckWorker`): completed
   * requests older than `minAgeMinutes` whose marker is still null. Returns how many settled.
   */
  async settleUnsettledCompleted(limit = 100, minAgeMinutes = 15, now: Date = new Date()): Promise<number> {
    const rows = await this.repo.findUnsettledCompleted(new Date(now.getTime() - minAgeMinutes * 60_000), limit);
    let settled = 0;
    for (const row of rows) {
      try {
        await this.settleAftermath(row);
        settled += 1;
      } catch (error) {
        console.error(`[RefundRequestService] sweep could not settle completed refund ${row.id}:`, error);
      }
    }
    return settled;
  }

  /**
   * R-9 + review finding 2: a refunded plan or credit pack must not stay in the owner's hands.
   * Loaded lazily — `billing` imports `payments` (gateways, references), and a static import back
   * would close the require cycle the refund ports exist to avoid.
   */
  private async reverseBillingBenefit(row: IRefundRequest): Promise<void> {
    if (row.source_kind === 'plan_purchase') {
      const { planPurchaseService } = await import('../../billing/services/plan-purchase.service');
      const purchase = await planPurchaseService.reverseById(row.source_id.toString());
      if (purchase && purchase.status === 'paid') {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'The refunded plan purchase could not be reversed', {
          refundRequestId: row.id,
        });
      }
      return;
    }
    const { creditTopupService } = await import('../../billing/services/credit-topup.service');
    // null = no longer `paid` (already reversed) — the idempotent outcome.
    await creditTopupService.reverseTopup(row.source_id.toString(), 'refund');
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Review finding 5: the source must still hold at least this request's gross — the same
   * ceiling `create` validated against (`loadSource().remaining`: completed refunds AND delivery
   * money paid by hand are subtracted). A source that can no longer be loaded as refundable
   * (the purchase reversed, the payment gone) counts as 0. Throws `409
   * REFUND_REQUEST_STATUS_CONFLICT` with `reason: 'exceeds_refundable'` and notes the request.
   */
  private async assertStillRefundable(row: IRefundRequest): Promise<void> {
    let remaining: number;
    try {
      remaining = (await this.loadSource(row.source_kind, row.source_id.toString())).remaining;
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode >= 500) throw error;
      remaining = 0;
    }
    if (remaining >= row.gross_amount) return;
    // An approved request moves to `failed` so it can be rejected (only `awaiting_approval |
    // failed` reject); any other non-sending status is only annotated. `sending` is never touched.
    const set = { transfer_failure_reason: 'exceeds_refundable' };
    if (row.status === 'approved') {
      await this.repo.transition(row.id, ['approved'], 'failed', set).catch(() => undefined);
    } else if (row.status !== 'sending') {
      await this.repo.annotate(row.id, [row.status], set).catch(() => undefined);
    }
    throw conflict(
      `Only ${row.currency} ${remaining} of this payment can still be refunded — this refund of ${row.gross_amount} would return more. ` +
        'Reject it and raise a smaller one.',
      { reason: 'exceeds_refundable', remaining, grossAmount: row.gross_amount }
    );
  }

  /** Send after an approval WITHOUT throwing — the row records what happened. */
  private async dispatchQuietly(id: string): Promise<void> {
    try {
      await this.claimAndSend(id);
    } catch (error) {
      console.warn(`[RefundRequestService] refund ${id} approved but not sent:`, error instanceof Error ? error.message : error);
    }
    // Whatever the send did (sending · waiting_for_cash · approved-but-refused · completed), say so.
    const after = await this.repo.findById(id).catch(() => null);
    if (after) this.announceStatus(after);
  }

  /**
   * `refund.status_changed` — published AFTER the write, fire-and-forget (R9: the customer
   * notifications subscribe to it). Carries the status the request is IN now, not an edge:
   * subscribers key their own idempotency per (request, situation), so announcing the same
   * status twice (a retry back to `sending`) is harmless. `completed` is announced too, but the
   * customer is told about the money through `payment.refunded`, which carries the ledger ids.
   */
  private announceStatus(row: IRefundRequest): void {
    eventBus.publish('refund.status_changed', {
      eventType: 'refund.status_changed',
      aggregateId: row.source_id.toString(),
      payload: {
        refundRequestId: row.id,
        sourceKind: row.source_kind,
        ...(row.source_kind === 'order' ? { orderId: row.source_id.toString() } : {}),
        ...(row.source_kind === 'booking' ? { bookingId: row.source_id.toString() } : {}),
        orderNumber: row.order_number ?? null,
        vendorId: row.vendor_id?.toString() ?? null,
        customerId: row.customer_id?.toString() ?? null,
        status: row.status,
        requestedByRole: row.requested_by?.role ?? null,
        paymentChannel: row.payment_channel,
        channel: row.channel ?? null,
        grossAmount: row.gross_amount,
        feeAmount: row.fee_amount,
        feeRate: row.fee_rate,
        netAmount: row.net_amount,
        currency: row.currency,
        destinationMasked: maskRefundPhone(row.destination?.phone ?? null),
      },
      occurredAt: new Date(),
    }).catch(() => { /* non-blocking */ });
  }

  private async loadSource(kind: RefundSourceKind, id: string): Promise<SourceFacts> {
    if (kind === 'order') return this.loadOrder(id);
    if (kind === 'booking') return this.loadBooking(id);
    return this.loadBilling(kind, id);
  }

  private async loadOrder(id: string): Promise<SourceFacts> {
    const order = await OrderModel.findById(id)
      .select('order_number vendor_id customer_id currency payment_method total_amount price_breakdown delivered_at')
      .lean<any>();
    if (!order) throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_FOUND, 404, 'The order to refund was not found', { orderId: id });

    const vendor = await VendorModel.findById(order.vendor_id).select('policies.return_policy.return_shipping_payer').lean<any>();
    const total = Number(order.total_amount) || 0;
    const delivery = Math.min(Math.max(0, Number(order.price_breakdown?.delivery) || 0), total);
    const base = {
      kind: 'order' as const,
      id,
      orderNumber: order.order_number ?? null,
      vendorId: order.vendor_id?.toString() ?? null,
      customerId: order.customer_id?.toString() ?? null,
      currency: order.currency,
      goodsAmount: total - delivery,
      deliveryAmountPaid: delivery,
      delivered: Boolean(order.delivered_at),
      returnShippingPayer: (vendor?.policies?.return_policy?.return_shipping_payer ?? null) as ReturnShippingPayer | null,
    };

    if (order.payment_method === 'cash_on_delivery') {
      const coverage = await getCodCoveragePort().coverageForOrder(id);
      const collected = coverage.filter((c) => c.status === 'collected');
      if (collected.length === 0) {
        throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_PAID, 409, 'No cash has been collected for this order yet — there is nothing to refund');
      }
      const paid = collected.reduce((s, c) => s + c.expected, 0);
      const already = await sumCompletedRefundsForOrder(id);
      return { ...base, paymentChannel: 'cod', legs: [], remaining: Math.max(0, paid - already), codCollections: coverage };
    }

    const r = await this.orchestrator.refundableFor({ kind: 'order', orderId: id });
    if (r.legs.length === 0) {
      throw createAppError(ERROR_CODES.REFUND_PAYMENT_NOT_FOUND, 404, 'No settled payment was found for this order');
    }
    return {
      ...base,
      paymentChannel: r.legs.every((l) => l.tx.gateway === 'STRIPE') ? 'card' : 'mobile_money',
      legs: r.legs.map((l) => ({
        id: l.tx._id.toString(),
        purpose: l.purpose,
        remaining: l.remaining,
        gateway: l.tx.gateway as PaymentGatewayName,
        payerPhone: l.tx.payer?.phone ?? null,
        payerName: l.tx.payer?.name ?? null,
      })),
      remaining: r.remaining,
      codCollections: [],
    };
  }

  private async loadBooking(id: string): Promise<SourceFacts> {
    const booking = await Booking.findById(id).select('bookingNumber vendorId userId currency').lean<any>();
    if (!booking) throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_FOUND, 404, 'The booking to refund was not found', { bookingId: id });
    const r = await this.orchestrator.refundableFor({ kind: 'booking', bookingId: id });
    if (r.legs.length === 0) {
      throw createAppError(ERROR_CODES.REFUND_PAYMENT_NOT_FOUND, 404, 'No settled payment was found for this booking');
    }
    return {
      kind: 'booking',
      id,
      orderNumber: booking.bookingNumber ?? null,
      vendorId: booking.vendorId?.toString() ?? null,
      customerId: booking.userId?.toString() ?? null,
      currency: booking.currency ?? r.legs[0].tx.currencySnapshot,
      paymentChannel: r.legs.every((l) => l.tx.gateway === 'STRIPE') ? 'card' : 'mobile_money',
      legs: r.legs.map((l) => ({
        id: l.tx._id.toString(),
        purpose: l.purpose,
        remaining: l.remaining,
        gateway: l.tx.gateway as PaymentGatewayName,
        payerPhone: l.tx.payer?.phone ?? null,
        payerName: l.tx.payer?.name ?? null,
      })),
      remaining: r.remaining,
      goodsAmount: r.sourceTotal,
      deliveryAmountPaid: 0,
      delivered: false,
      returnShippingPayer: null,
      codCollections: [],
    };
  }

  /** Plan purchases and credit top-ups store no paying number (R-9): typed or external only. */
  private async loadBilling(kind: 'plan_purchase' | 'credit_topup', id: string): Promise<SourceFacts> {
    const doc: any = kind === 'plan_purchase'
      ? await PlanPurchaseModel.findById(id).select('price currency status').lean()
      : await CreditTopupModel.findById(id).select('price currency status').lean();
    if (!doc) throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_FOUND, 404, 'The purchase to refund was not found', { sourceId: id });
    if (doc.status !== 'paid') {
      throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_PAID, 409, 'This purchase was never paid — there is nothing to refund');
    }
    const already = await this.repo.sumCompletedGross(kind, id);
    const price = Number(doc.price) || 0;
    return {
      kind,
      id,
      orderNumber: null,
      vendorId: null,
      customerId: null,
      currency: doc.currency,
      paymentChannel: 'billing',
      legs: [],
      remaining: Math.max(0, price - already),
      goodsAmount: price,
      deliveryAmountPaid: 0,
      delivered: false,
      returnShippingPayer: null,
      codCollections: [],
    };
  }
}

export const refundRequestService = new RefundRequestService();

/**
 * Subscribe the COD release to `cod.collections.settled` (§ 11.4). Exported for wave 2 to call
 * from boot; NOT called here. Returns nothing — the bus swallows handler errors, which is why
 * `recheckWaitingForCash` exists as the nightly backstop.
 */
export function registerRefundCodSubscriber(bus: EventBus = eventBus): void {
  bus.subscribe(
    'cod.collections.settled',
    async (event) => {
      const ids: unknown = event?.payload?.collectionIds;
      if (!Array.isArray(ids) || ids.length === 0) return;
      await refundRequestService.onCollectionsSettled(ids.map(String));
    },
    'refund-request.cod-collections-settled'
  );
}
