import { ClientSession, Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { EarningsAllocationModel, IEarningsAllocation } from '../../earnings/models/earnings-allocation.model';
import { EarningsAccountRepository } from '../../earnings/repositories/earnings-account.repository';
import { EarningsLedgerRepository } from '../../earnings/repositories/earnings-ledger.repository';
import { AdjustmentTakenFrom } from '../../earnings/models/earnings-adjustment.model';
import { OrderModel } from '../../orders/order.model';
import { orderItemsGrossOf } from '../../orders/domain/delivery-payer';
import { ShipmentModel } from '../../shipments/shipment.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { Booking } from '../../booking/models/booking.model';
import { VendorModel } from '../../vendors/vendor.model';
import { CustomerModel } from '../../customers/customer.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { commissionEarnedAt, rewardAmount, WHOLE_SHARE } from '../domain/referral-rules';
import {
  agencySharesByParcelValue,
  CommissionParticipant,
  planCommissionRewards,
  PlannedReward,
} from '../domain/referral-reward-plan';
import { ReferralPartnerModel } from '../models/referral-partner.model';
import { ReferralRelationshipModel } from '../models/referral-relationship.model';
import { IReferralReward, ReferralRewardModel } from '../models/referral-reward.model';
import { ReferralSettingsService, referralSettingsService, ReferralSettingsView } from './referral-settings.service';

/** The sources a vendor's commission comes from. A damage claim's investigation fee is not one (R-2). */
const COMMISSION_SOURCES: readonly string[] = ['order', 'cod_collection', 'booking'];
const PARTNER_OWNER = 'referral_partner' as const;
const MAX_PAGES = 25;
const DAY_MS = 86_400_000;

interface CommissionEvent {
  vendorId: Types.ObjectId;
  orderId: Types.ObjectId | null;
  bookingId: Types.ObjectId | null;
  participants: CommissionParticipant[];
}

function partnerOwnerId(partnerId: Types.ObjectId | string): string {
  return partnerId.toString();
}

/**
 * Earns, matures and adjusts rewards (REFERRAL-PROGRAM-PLAN §§ 5.4–5.6). Three stages of the nightly
 * earnings sweep, each row in its own transaction.
 *
 * ⛔ **None of this runs inside the release or refund transactions.** A reward fault there would
 * stop money that belongs to other people: a commission row failing every night inside the release
 * would crowd vendors' rows out of its limited batch, and a fault inside a refund's clawback would
 * stop the refund. So the money paths only leave a mark, in their own transaction, and these stages
 * work from the marks. A reward can be late; it cannot delay anybody else.
 *
 * The rewards themselves and the commission's mark are written together, in one transaction, which
 * is the guarantee that a commission is judged exactly once.
 */
export class ReferralRewardService {
  constructor(
    private readonly settings: ReferralSettingsService = referralSettingsService,
    private readonly accounts: EarningsAccountRepository = new EarningsAccountRepository(),
    private readonly ledger: EarningsLedgerRepository = new EarningsLedgerRepository()
  ) {}

  async runNightlyStages(now: Date, batchSize: number): Promise<void> {
    await this.evaluateReleasedCommissions(now, batchSize);
    await this.syncPendingCommissions(batchSize);
    await this.releaseMaturedRewards(now, batchSize);
  }

  // ── Earning ───────────────────────────────────────────────────────────────────────────

  async evaluateReleasedCommissions(now: Date, batchSize: number): Promise<number> {
    const settings = await this.settings.get();
    let created = 0;
    let after: Types.ObjectId | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const filter: Record<string, unknown> = {
        beneficiary_type: 'platform',
        status: 'released',
        referral_evaluated_at: null,
      };
      if (after) filter._id = { $gt: after };
      const rows: IEarningsAllocation[] = await EarningsAllocationModel.find(filter).sort({ _id: 1 }).limit(batchSize);
      if (rows.length === 0) break;
      after = rows[rows.length - 1]._id as Types.ObjectId;

      for (const row of rows) {
        try {
          created += await this.evaluateRow(row, settings, now);
        } catch (error) {
          console.error(`[ReferralReward] Could not evaluate commission ${String(row._id)}:`, error);
        }
      }
      if (rows.length < batchSize) break;
    }
    return created;
  }

  private async evaluateRow(row: IEarningsAllocation, settings: ReferralSettingsView, now: Date): Promise<number> {
    const event = settings.enabled && COMMISSION_SOURCES.includes(row.source_type)
      ? await this.loadCommissionEvent(row)
      : null;
    const retained = row.amount - (row.clawed_amount ?? 0);
    const earnedAt = commissionEarnedAt(row);
    const planned = event ? await this.planRewards(event.participants, settings, retained, earnedAt) : [];

    const maturesAt = new Date((row.completed_at ?? earnedAt).getTime() + settings.rewardWaitDays * DAY_MS);

    await transactionManager.runInTransactionWithRetry(async (session) => {
      // With the amount in the filter: a refund landing since the row was read must be counted.
      const claimed = await EarningsAllocationModel.findOneAndUpdate(
        {
          _id: row._id,
          status: 'released',
          referral_evaluated_at: null,
          // Rows older than the field carry none, and read as 0.
          clawed_amount: (row.clawed_amount ?? 0) === 0 ? { $in: [0, null] } : row.clawed_amount,
        },
        { $set: { referral_evaluated_at: now } },
        { session }
      );
      if (!claimed) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Referral evaluation lost a race on a commission', {
          allocationId: String(row._id),
        });
      }
      for (const reward of planned) {
        await this.createReward(reward, row, event as CommissionEvent, retained, earnedAt, maturesAt, session);
      }
    });
    return planned.length;
  }

  private async planRewards(
    participants: CommissionParticipant[],
    settings: ReferralSettingsView,
    retained: number,
    earnedAt: Date
  ): Promise<PlannedReward[]> {
    const relationships = await ReferralRelationshipModel.find({
      referred_user_id: { $in: participants.map((p) => new Types.ObjectId(p.userId)) },
    }).lean();
    if (relationships.length === 0) return [];
    const partners = await ReferralPartnerModel.find({
      _id: { $in: relationships.map((r) => r.partner_id) },
    }).select('status_history custom_terms').lean();

    return planCommissionRewards({
      participants,
      relationships: relationships.map((r) => ({
        id: r._id.toString(),
        partnerId: r.partner_id.toString(),
        partnerUserId: r.partner_user_id.toString(),
        referredUserId: r.referred_user_id.toString(),
        category: r.category,
        expiresAt: r.expires_at,
      })),
      partners: partners.map((p) => ({
        id: p._id.toString(),
        statusHistory: p.status_history,
        customTerms: p.custom_terms ?? null,
      })),
      globalTerms: settings.terms,
      retainedCommission: retained,
      earnedAt,
    });
  }

  private async createReward(
    planned: PlannedReward,
    row: IEarningsAllocation,
    event: CommissionEvent,
    retained: number,
    earnedAt: Date,
    maturesAt: Date,
    session: ClientSession
  ): Promise<void> {
    // ⚠ ARRAY form: Mongoose reads `{ session }` only when the first argument is an array.
    await ReferralRewardModel.create(
      [
        {
          partner_id: planned.partnerId,
          relationship_id: planned.relationshipId,
          referred_user_id: planned.referredUserId,
          category: planned.category,
          commission_allocation_id: row._id,
          source_type: row.source_type,
          source_id: row.source_id,
          order_id: event.orderId,
          booking_id: event.bookingId,
          vendor_id: event.vendorId,
          commission_earned: retained,
          share: planned.share,
          rate_percent: planned.ratePercent,
          rate_source: planned.rateSource,
          amount: planned.amount,
          currency: row.currency,
          earned_at: earnedAt,
          matures_at: maturesAt,
        },
      ],
      { session }
    );
    const account = await this.accounts.getOrCreate(PARTNER_OWNER, planned.partnerId, session);
    const updated = await this.accounts.hold(account._id as Types.ObjectId, planned.amount, session);
    await this.ledger.create(
      {
        account_id: account._id as Types.ObjectId,
        owner_type: PARTNER_OWNER,
        owner_id: new Types.ObjectId(planned.partnerId),
        entry_type: 'hold',
        amount: planned.amount,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        source_type: row.source_type,
        source_id: row.source_id.toString(),
        allocation_id: row._id as Types.ObjectId,
        reason_code: 'referral_reward',
      },
      session
    );
  }

  /** Who took part in this commission, as users. Null when its source has gone: logged, never retried. */
  private async loadCommissionEvent(row: IEarningsAllocation): Promise<CommissionEvent | null> {
    if (row.source_type === 'booking') return this.bookingEvent(row);
    if (row.source_type === 'cod_collection') return this.collectionEvent(row);
    return this.prepaidOrderEvent(row);
  }

  private async bookingEvent(row: IEarningsAllocation): Promise<CommissionEvent | null> {
    // A balance payment's row carries the payment's id as its source, not the booking's.
    const booking: any = await Booking.findOne(
      { $or: [{ _id: row.source_id }, { 'settlement.balanceTransactionId': row.source_id }, { topupTransactionIds: row.source_id }] },
      { vendorId: 1, userId: 1 }
    ).lean();
    if (!booking) return this.missingSource(row);
    const participants = await this.vendorAndCustomer(booking.vendorId, null);
    if (booking.userId) participants.push({ userId: booking.userId.toString(), category: 'customer', share: WHOLE_SHARE });
    return { vendorId: booking.vendorId, orderId: null, bookingId: booking._id, participants };
  }

  private async collectionEvent(row: IEarningsAllocation): Promise<CommissionEvent | null> {
    const collection: any = await CashCollectionModel.findById(row.source_id, { order_id: 1, agency_id: 1 }).lean();
    const order: any = collection
      ? await OrderModel.findById(collection.order_id, { vendor_id: 1, customer_id: 1 }).lean()
      : null;
    if (!order) return this.missingSource(row);
    const participants = await this.vendorAndCustomer(order.vendor_id, order.customer_id);
    // This commission is that parcel's own, and collecting its cash means the agency delivered it.
    const agencyUser = await this.agencyUserId(collection.agency_id);
    if (agencyUser) participants.push({ userId: agencyUser, category: 'agency', share: WHOLE_SHARE });
    return { vendorId: order.vendor_id, orderId: order._id, bookingId: null, participants };
  }

  private async prepaidOrderEvent(row: IEarningsAllocation): Promise<CommissionEvent | null> {
    const order: any = await OrderModel.findById(row.source_id).lean();
    if (!order) return this.missingSource(row);
    const participants = await this.vendorAndCustomer(order.vendor_id, order.customer_id);

    const shipments: any[] = order.order_type === 'physical'
      ? await ShipmentModel.find({ order_id: order._id }, { agency_id: 1, status: 1, items: 1 }).lean()
      : [];
    const shares = agencySharesByParcelValue(
      shipments.map((s) => ({
        agencyId: s.agency_id.toString(),
        status: s.status,
        items: (s.items ?? []).map((i: any) => ({ orderItemId: i.order_item_id.toString(), quantity: i.quantity })),
      })),
      new Map((order.items ?? []).map((i: any) => [i._id.toString(), i.price])),
      orderItemsGrossOf(order)
    );
    for (const [agencyId, share] of shares) {
      const agencyUser = await this.agencyUserId(agencyId);
      if (agencyUser) participants.push({ userId: agencyUser, category: 'agency', share });
    }
    return { vendorId: order.vendor_id, orderId: order._id, bookingId: null, participants };
  }

  private missingSource(row: IEarningsAllocation): null {
    console.error(`[ReferralReward] Commission ${String(row._id)} references a missing ${row.source_type} ${String(row.source_id)}`);
    return null;
  }

  private async vendorAndCustomer(
    vendorId: Types.ObjectId,
    customerId: Types.ObjectId | null
  ): Promise<CommissionParticipant[]> {
    const participants: CommissionParticipant[] = [];
    const vendor = await VendorModel.findById(vendorId).select('user_id').lean();
    if (vendor?.user_id) participants.push({ userId: vendor.user_id.toString(), category: 'vendor', share: WHOLE_SHARE });
    if (customerId) {
      const customer = await CustomerModel.findById(customerId).select('user_id').lean();
      if (customer?.user_id) participants.push({ userId: customer.user_id.toString(), category: 'customer', share: WHOLE_SHARE });
    }
    return participants;
  }

  private async agencyUserId(agencyId: Types.ObjectId | string): Promise<string | null> {
    const agency = await DeliveryAgencyModel.findById(agencyId).select('user_id').lean();
    return agency?.user_id ? agency.user_id.toString() : null;
  }

  // ── Maturing ──────────────────────────────────────────────────────────────────────────

  /**
   * Rewards past their wait move to available, netting any debt first (owner R-5). A frozen
   * partner's rewards mature too: the freeze is on withdrawing, not on the record (document § 15).
   */
  async releaseMaturedRewards(now: Date, batchSize: number): Promise<number> {
    const rows = await ReferralRewardModel.find({ status: 'held', matures_at: { $lte: now } })
      .sort({ matures_at: 1 })
      .limit(batchSize);
    let released = 0;
    for (const reward of rows) {
      try {
        await transactionManager.runInTransactionWithRetry(async (session) => {
          const claimed = await ReferralRewardModel.findOneAndUpdate(
            { _id: reward._id, status: 'held' },
            { $set: { status: 'released', released_at: now } },
            { new: true, session }
          );
          if (!claimed) return;
          await this.moveToAvailable(claimed, session);
        });
        released += 1;
      } catch (error) {
        console.error(`[ReferralReward] Could not release reward ${String(reward._id)}:`, error);
      }
    }
    return released;
  }

  private async moveToAvailable(reward: IReferralReward, session: ClientSession): Promise<void> {
    const amount = reward.amount - reward.clawed_amount;
    if (amount <= 0) return;
    const account = await this.accounts.getOrCreate(PARTNER_OWNER, partnerOwnerId(reward.partner_id), session);
    const netted = await this.accounts.release(account._id as Types.ObjectId, amount, session);
    if (!netted) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Referral reward release underflow', {
        rewardId: String(reward._id),
      });
    }
    const base = {
      account_id: account._id as Types.ObjectId,
      owner_type: PARTNER_OWNER,
      owner_id: reward.partner_id,
      pending_after: netted.account.pending_balance,
      available_after: netted.account.available_balance,
      source_type: reward.source_type,
      source_id: reward.source_id.toString(),
      allocation_id: reward.commission_allocation_id,
    };
    if (amount - netted.recovered > 0) {
      await this.ledger.create(
        { ...base, entry_type: 'release', amount: amount - netted.recovered, reason_code: 'referral_reward_matured' },
        session
      );
    }
    if (netted.recovered > 0) {
      await this.ledger.create(
        { ...base, entry_type: 'clawback_recovery', amount: netted.recovered, reason_code: 'clawback_recovery' },
        session
      );
    }
  }

  // ── Following a refund ────────────────────────────────────────────────────────────────

  /** Called by the refund engine after it commits. Best-effort: the nightly stage is the backstop. */
  async syncAfterRefund(allocationIds: string[]): Promise<void> {
    for (const id of allocationIds) {
      try {
        await this.syncCommission(new Types.ObjectId(id));
      } catch (error) {
        console.error(`[ReferralReward] Could not follow the refund on commission ${id}; the nightly stage retries:`, error);
      }
    }
  }

  async syncPendingCommissions(batchSize: number): Promise<number> {
    const rows = await EarningsAllocationModel.find({ 'referral_resync.at': { $type: 'date' } })
      .select('_id')
      .limit(batchSize)
      .lean();
    let synced = 0;
    for (const row of rows) {
      try {
        synced += await this.syncCommission(row._id as Types.ObjectId);
      } catch (error) {
        console.error(`[ReferralReward] Could not sync commission ${String(row._id)}:`, error);
      }
    }
    return synced;
  }

  /**
   * Bring every reward on one commission down to what the commission retained now pays.
   *
   * State-based, so running it twice changes nothing: the target is computed from the commission
   * and the rate saved on the reward, never from an amount a refund reported (document § 14).
   */
  async syncCommission(allocationId: Types.ObjectId): Promise<number> {
    return transactionManager.runInTransactionWithRetry(async (session) => {
      const row = await EarningsAllocationModel.findById(allocationId, null, { session });
      if (!row) return 0;
      const retained = Math.max(0, row.amount - (row.clawed_amount ?? 0));
      const refundKey = row.referral_resync?.refund_key ?? null;
      const rewards = await ReferralRewardModel.find(
        { commission_allocation_id: allocationId, status: { $ne: 'reversed' } },
        null,
        { session }
      );
      const now = new Date();
      let changed = 0;
      for (const reward of rewards) {
        const before = reward.amount - reward.clawed_amount;
        const after = Math.min(before, rewardAmount(retained, reward.rate_percent, reward.share));
        if (after === before) continue;
        await this.clawReward(reward, before, after, retained, refundKey, now, row, session);
        changed += 1;
      }
      await EarningsAllocationModel.updateOne(
        { _id: allocationId },
        { $set: { referral_resync: null } },
        { session }
      );
      return changed;
    });
  }

  private async clawReward(
    reward: IReferralReward,
    before: number,
    after: number,
    retained: number,
    refundKey: string | null,
    now: Date,
    row: IEarningsAllocation,
    session: ClientSession
  ): Promise<void> {
    const claw = before - after;
    const account = await this.accounts.getOrCreate(PARTNER_OWNER, partnerOwnerId(reward.partner_id), session);
    let takenFrom: AdjustmentTakenFrom;
    let pendingAfter: number;
    let availableAfter: number;

    if (reward.status === 'held') {
      const updated = await this.accounts.reverseFromPending(account._id as Types.ObjectId, claw, session);
      if (!updated) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Referral reward clawback underflow', {
          rewardId: String(reward._id),
        });
      }
      takenFrom = { pending: claw, reserve: 0, available: 0, debt: 0 };
      pendingAfter = updated.pending_balance;
      availableAfter = updated.available_balance;
    } else {
      // Available first; what that cannot cover is debt that later rewards pay down first.
      const clawed = await this.accounts.clawFromAvailable(account._id as Types.ObjectId, claw, session);
      if (!clawed) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Referral wallet vanished mid-clawback', {
          rewardId: String(reward._id),
        });
      }
      takenFrom = { pending: 0, reserve: 0, available: clawed.fromAvailable, debt: clawed.toDebt };
      pendingAfter = clawed.account.pending_balance;
      availableAfter = clawed.account.available_balance;
    }

    const updated = await ReferralRewardModel.findOneAndUpdate(
      { _id: reward._id, clawed_amount: reward.clawed_amount },
      {
        $set: {
          clawed_amount: reward.amount - after,
          ...(after === 0 ? { status: 'reversed', reversed_at: now } : {}),
        },
        $push: {
          adjustments: {
            at: now,
            refund_key: refundKey,
            commission_retained: retained,
            amount_before: before,
            amount_after: after,
            taken_from: takenFrom,
          },
        },
      },
      { session }
    );
    if (!updated) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Referral clawback lost a race on a reward', {
        rewardId: String(reward._id),
      });
    }
    await this.ledger.create(
      {
        account_id: account._id as Types.ObjectId,
        owner_type: PARTNER_OWNER,
        owner_id: reward.partner_id,
        entry_type: 'clawback',
        amount: claw,
        pending_after: pendingAfter,
        available_after: availableAfter,
        source_type: reward.source_type,
        source_id: row.source_id.toString(),
        allocation_id: row._id as Types.ObjectId,
        reason_code: 'referral_reward_clawback',
      },
      session
    );
  }
}

export const referralRewardService = new ReferralRewardService();
