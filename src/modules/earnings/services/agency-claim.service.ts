import { ClientSession, Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { RefundRequestModel } from '../../payments/models/refund-request.model';
import { AgencyClaimModel, IAgencyClaim } from '../models/agency-claim.model';
import { IEarningsAllocation } from '../models/earnings-allocation.model';
import { EarningsAllocationRepository } from '../repositories/earnings-allocation.repository';
import { EarningsAdjustmentRepository } from '../repositories/earnings-adjustment.repository';
import { EarningsAccountService, earningsAccountService } from './earnings-account.service';
import { CourierLiabilityService, courierLiabilityService, ParcelLiabilityFacts } from './courier-liability.service';
import { cumulativeShares } from '../domain/clawback-plan';
import { TakenFrom } from '../domain/clawback-netting';
import {
  agencyWindowEndsAt,
  damageClaimCap,
  insideAgencyWindow,
  problemRaisedAt,
} from '../domain/courier-liability';
import { explainDamageClaim } from '../domain/adjustment-explanations';

export interface AgencyClaimActor {
  id: string | null;
  name: string | null;
}

export interface CreateAgencyClaimInput {
  shipmentId: string;
  itemCount: number;
  /** What the administrator claims for the damage (whole currency units). */
  amount: number;
  note: string;
  refundRequestId?: string | null;
  actor: AgencyClaimActor;
}

/** What an administrator sees before making a claim: whether one is possible, and its limits. */
export interface AgencyClaimEligibility {
  shipmentId: string;
  orderId: string;
  orderNumber: string | null;
  trackingNumber: string | null;
  agencyId: string | null;
  vendorId: string | null;
  currency: string;
  deliveredAt: Date | null;
  /** The earliest problem the order's customer reported about it, or null. */
  firstProblemAt: Date | null;
  /** The moment a claim made now would count as raised. */
  raisedAt: Date;
  windowDays: number;
  windowEndsAt: Date | null;
  insideWindow: boolean;
  maxPerItem: number;
  investigationFee: number;
  existingClaimId: string | null;
  eligible: boolean;
  /** Why not, when not: `not_delivered`, `no_agency`, `no_per_item_limit`, `outside_window`, `already_claimed`. */
  reason: string | null;
}

const NOTHING: TakenFrom = { pending: 0, reserve: 0, available: 0, debt: 0 };
const add = (a: TakenFrom, b: TakenFrom): TakenFrom => ({
  pending: a.pending + b.pending,
  reserve: a.reserve + b.reserve,
  available: a.available + b.available,
  debt: a.debt + b.debt,
});

/**
 * Damage claims on an agency (owner F-8, 2026-10-22) — see `models/agency-claim.model.ts` for
 * what one is and what applying it moves. Every rule is `domain/courier-liability.ts`; the
 * window and the terms are `CourierLiabilityService.parcelFacts`, the same read a refund's
 * delivery fault is judged by.
 */
export class AgencyClaimService {
  constructor(
    private readonly liability: CourierLiabilityService = courierLiabilityService,
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly adjustmentRepo: EarningsAdjustmentRepository = new EarningsAdjustmentRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService
  ) {}

  async eligibility(shipmentId: string, refundRequestId: string | null = null, now: Date = new Date()): Promise<AgencyClaimEligibility> {
    const facts = await this.liability.parcelFacts(shipmentId, now);
    if (!facts) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, { shipmentId });
    const existing = await AgencyClaimModel.findOne({ shipment_id: new Types.ObjectId(shipmentId) }, { _id: 1 }).lean();
    const raisedAt = problemRaisedAt([facts.firstProblemAt, await this.refundOpenedAt(refundRequestId)], now);
    const inside = insideAgencyWindow(facts.deliveredAt, raisedAt, facts.windowDays);
    const maxPerItem = facts.maxRefundPerItem ?? 0;

    let reason: string | null = null;
    if (!facts.agencyId) reason = 'no_agency';
    else if (!facts.deliveredAt) reason = 'not_delivered';
    else if (maxPerItem <= 0) reason = 'no_per_item_limit';
    else if (!inside) reason = 'outside_window';
    else if (existing) reason = 'already_claimed';

    return {
      shipmentId,
      orderId: facts.orderId,
      orderNumber: facts.orderNumber,
      trackingNumber: facts.trackingNumber,
      agencyId: facts.agencyId,
      vendorId: facts.vendorId,
      currency: facts.currency,
      deliveredAt: facts.deliveredAt,
      firstProblemAt: facts.firstProblemAt,
      raisedAt,
      windowDays: facts.windowDays,
      windowEndsAt: agencyWindowEndsAt(facts.deliveredAt, facts.windowDays),
      insideWindow: inside,
      maxPerItem,
      investigationFee: facts.investigationFee,
      existingClaimId: existing ? (existing._id as Types.ObjectId).toString() : null,
      eligible: reason === null,
      reason,
    };
  }

  async create(input: CreateAgencyClaimInput, now: Date = new Date()): Promise<IAgencyClaim> {
    const itemCount = Math.floor(input.itemCount);
    const claimed = Math.round(input.amount);
    if (!Number.isInteger(itemCount) || itemCount < 1 || !Number.isInteger(claimed) || claimed < 1) {
      throw createAppError(ERROR_CODES.AGENCY_CLAIM_NOT_ELIGIBLE, 422, 'itemCount and amount must be positive whole numbers', {
        reason: 'invalid_amount',
      });
    }
    const facts = await this.liability.parcelFacts(input.shipmentId, now);
    if (!facts) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, { shipmentId: input.shipmentId });
    const check = await this.eligibility(input.shipmentId, input.refundRequestId ?? null, now);
    if (check.reason === 'already_claimed') {
      throw createAppError(ERROR_CODES.AGENCY_CLAIM_EXISTS, 409, undefined, { claimId: check.existingClaimId });
    }
    if (check.reason === 'outside_window') {
      throw createAppError(ERROR_CODES.AGENCY_CLAIM_OUTSIDE_WINDOW, 422, undefined, {
        deliveredAt: check.deliveredAt,
        raisedAt: check.raisedAt,
        windowDays: check.windowDays,
        windowEndsAt: check.windowEndsAt,
      });
    }
    if (!check.eligible) {
      throw createAppError(ERROR_CODES.AGENCY_CLAIM_NOT_ELIGIBLE, 422, undefined, { reason: check.reason });
    }
    const cap = damageClaimCap(check.maxPerItem, itemCount);
    if (claimed > cap) {
      throw createAppError(ERROR_CODES.AGENCY_CLAIM_EXCEEDS_CAP, 422, undefined, {
        claimed,
        cap,
        maxPerItem: check.maxPerItem,
        itemCount,
      });
    }

    const explanation = explainDamageClaim({
      orderNumber: facts.orderNumber,
      trackingNumber: facts.trackingNumber,
      itemCount,
      maxPerItem: check.maxPerItem,
      amount: claimed,
      investigationFee: facts.investigationFee,
      currency: facts.currency,
      raisedAt: check.raisedAt,
      windowDays: facts.windowDays,
    });

    try {
      return await transactionManager.runInTransactionWithRetry(async (session) => {
        const claimId = new Types.ObjectId();
        const charge = claimed + facts.investigationFee;
        const taken = await this.chargeAgency(claimId, facts, charge, explanation, session, now);

        const [claim] = await AgencyClaimModel.create(
          [
            {
              _id: claimId,
              kind: 'damage',
              shipment_id: new Types.ObjectId(facts.shipmentId),
              order_id: new Types.ObjectId(facts.orderId),
              order_number: facts.orderNumber,
              tracking_number: facts.trackingNumber,
              agency_id: new Types.ObjectId(facts.agencyId!),
              vendor_id: facts.vendorId ? new Types.ObjectId(facts.vendorId) : null,
              refund_request_id:
                input.refundRequestId && Types.ObjectId.isValid(input.refundRequestId)
                  ? new Types.ObjectId(input.refundRequestId)
                  : null,
              item_count: itemCount,
              claimed_amount: claimed,
              max_per_item: check.maxPerItem,
              cap,
              amount: claimed,
              investigation_fee: facts.investigationFee,
              currency: facts.currency,
              delivered_at: facts.deliveredAt!,
              raised_at: check.raisedAt,
              window_days: facts.windowDays,
              note: input.note.trim(),
              created_by: { id: input.actor.id, name: input.actor.name },
              ...explanation,
              taken_from: taken,
            },
          ],
          { session }
        );

        // The vendor carried the broken goods: credited, released by the nightly sweep (netting debt).
        if (facts.vendorId) {
          await this.credit('vendor', facts.vendorId, claimId, claimed, facts.currency, session, now);
        }
        // The investigation fee is the platform's.
        if (facts.investigationFee > 0) {
          await this.credit('platform', null, claimId, facts.investigationFee, facts.currency, session, now);
        }
        return claim;
      });
    } catch (error: any) {
      if (error?.code === 11000 || /E11000/.test(String(error?.message ?? ''))) {
        throw createAppError(ERROR_CODES.AGENCY_CLAIM_EXISTS, 409);
      }
      throw error;
    }
  }

  async getById(id: string): Promise<IAgencyClaim | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return AgencyClaimModel.findById(id).lean<IAgencyClaim>();
  }

  /** Newest first. `agencyId` / `vendorId` scope it to one party (their own lists). */
  async list(filter: { agencyId?: string; vendorId?: string; shipmentId?: string }, page: number, limit: number): Promise<{ items: IAgencyClaim[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filter.agencyId) query.agency_id = new Types.ObjectId(filter.agencyId);
    if (filter.vendorId) query.vendor_id = new Types.ObjectId(filter.vendorId);
    if (filter.shipmentId) query.shipment_id = new Types.ObjectId(filter.shipmentId);
    const [items, total] = await Promise.all([
      AgencyClaimModel.find(query).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit).lean<IAgencyClaim[]>(),
      AgencyClaimModel.countDocuments(query),
    ]);
    return { items, total };
  }

  /**
   * Take `charge` from the agency: its rows of this parcel first (held money, then each row's own
   * reserve slice and available), the rest from its available balance, then debt. One
   * `earnings_adjustments` row per row touched and one for the rest, all carrying the explanation.
   */
  private async chargeAgency(
    claimId: Types.ObjectId,
    facts: ParcelLiabilityFacts,
    charge: number,
    explanation: ReturnType<typeof explainDamageClaim>,
    session: ClientSession,
    now: Date
  ): Promise<TakenFrom> {
    const key = `claim:${claimId.toString()}`;
    const rows = (await this.allocationRepo.findBySources(await this.sourcesOf(facts), session)).filter(
      (r) => r.beneficiary_type === 'agency' && r.status !== 'reversed'
    );
    const remaining = rows.map((r) => Math.max(0, r.amount - (r.clawed_amount ?? 0)));
    const shares = cumulativeShares(charge, remaining);
    let total: TakenFrom = { ...NOTHING };
    let fromRows = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const take = shares[i];
      if (take <= 0) continue;
      const taken = await this.accounts.clawInSession(row, take, session, now);
      const claimedOk = await this.allocationRepo.addClawed(
        row._id as Types.ObjectId,
        row.status as 'held' | 'released', // reversed rows were filtered out above
        row.clawed_amount ?? 0,
        take,
        row.amount,
        now,
        session
      );
      if (!claimedOk) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Damage claim lost a race on an allocation', {
          allocationId: (row._id as Types.ObjectId).toString(),
        });
      }
      await this.adjustment(key, claimId, row, take, taken, explanation, session);
      total = add(total, taken);
      fromRows += take;
    }

    const rest = charge - fromRows;
    if (rest > 0) {
      const home = rows[0] ?? null;
      const taken = await this.accounts.clawBeyondInSession('agency', facts.agencyId!, rest, home, session);
      await this.adjustmentRepo.create(
        {
          refund_key: key,
          allocation_id: null,
          source_type: home ? home.source_type : 'shipment',
          source_id: home ? home.source_id : facts.shipmentId,
          beneficiary_type: 'agency',
          beneficiary_id: facts.agencyId!,
          amount: rest,
          currency: facts.currency,
          taken_from: taken,
          kind: 'refund_clawback',
          agency_claim_id: claimId,
          ...explanation,
        },
        session
      );
      total = add(total, taken);
    }
    return total;
  }

  private async adjustment(
    key: string,
    claimId: Types.ObjectId,
    row: IEarningsAllocation,
    amount: number,
    taken: TakenFrom,
    explanation: ReturnType<typeof explainDamageClaim>,
    session: ClientSession
  ): Promise<void> {
    await this.adjustmentRepo.create(
      {
        refund_key: key,
        allocation_id: row._id as Types.ObjectId,
        source_type: row.source_type,
        source_id: row.source_id,
        beneficiary_type: row.beneficiary_type,
        beneficiary_id: row.beneficiary_id,
        amount,
        currency: row.currency,
        taken_from: taken,
        kind: 'refund_clawback',
        agency_claim_id: claimId,
        ...explanation,
      },
      session
    );
  }

  /** An earnings share for the vendor's compensation or the platform's fee, released tonight. */
  private async credit(
    beneficiary: 'vendor' | 'platform',
    beneficiaryId: string | null,
    claimId: Types.ObjectId,
    amount: number,
    currency: string,
    session: ClientSession,
    now: Date
  ): Promise<void> {
    const allocation = await this.allocationRepo.create(
      {
        source_type: 'agency_claim',
        source_id: claimId.toString(),
        beneficiary_type: beneficiary,
        beneficiary_id: beneficiaryId,
        gross_snapshot: amount,
        commission_percent_snapshot: 0,
        amount,
        currency,
        requires_cash_settlement: false,
        // Nothing to wait for: the agency's money is already taken. Due at the next sweep.
        completed_at: now,
        hold_release_at: now,
      },
      session
    );
    await this.accounts.holdInSession(allocation, session);
  }

  private async sourcesOf(facts: ParcelLiabilityFacts) {
    const { earningsCompletionService } = await import('./earnings-completion.service');
    return earningsCompletionService.sourcesOfShipment(facts.shipmentId);
  }

  private async refundOpenedAt(refundRequestId: string | null): Promise<Date | null> {
    if (!refundRequestId || !Types.ObjectId.isValid(refundRequestId)) return null;
    const row: any = await RefundRequestModel.findById(refundRequestId, { created_at: 1 }).lean();
    return row?.created_at ?? null;
  }
}

export const agencyClaimService = new AgencyClaimService();
