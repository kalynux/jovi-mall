import { ClientSession, Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { OrderModel } from '../../orders/order.model';
import { Booking } from '../../booking/models/booking.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { TicketNoteService } from '../../tickets/services/ticket-note.service';
import { EarningsAllocationRepository, SourceRef } from '../repositories/earnings-allocation.repository';
import { EarningsAccountRepository } from '../repositories/earnings-account.repository';
import { EarningsAdjustmentRepository } from '../repositories/earnings-adjustment.repository';
import { PayoutRequestModel, PAYOUT_HELD_STATUSES } from '../models/payout-request.model';
import { IEarningsAllocation } from '../models/earnings-allocation.model';
import { EarningsOwnerType } from '../models/earnings-account.model';
import { ClawPlanLine, ClawPlanRow, planClawback, planRemaining } from '../domain/clawback-plan';
import { TakenFrom } from '../domain/clawback-netting';
import { EarningsAccountService, earningsAccountService } from './earnings-account.service';
import { bookingSourcesOf, PauseTarget } from './earnings-pause.service';

/**
 * Earnings recovery ("clawback") — REFUND-FLOW-PLAN § 6, contract § 11.3.
 *
 * Earnings release 3 days after delivery while a return can be refunded for 14, so most return
 * refunds hit money that is ALREADY released. This service takes it back: from what is still
 * held, else from the share's own reserve slice, else from available, and owes the rest as
 * debt (`clawback_balance`) that every later inflow pays down first.
 *
 * ── Money is recovered when the refund ARRIVES, never when it is accepted (§ 6.5) ─────────
 * So there is nothing to undo when a transfer fails. The caller (refund-core's
 * `RefundEarningsPort.onRefundCompleted`, wave 2) calls `applyRefund`, then
 * `earningsPauseService.closeOnRefund`.
 *
 * ── Idempotent on `refundKey` ───────────────────────────────────────────────────────────────
 * The `refund_requests` id, or `dispute:<id>` for a lost card dispute. Every money move of one
 * refund runs in ONE transaction with its ledger and `earnings_adjustments` rows; the
 * adjustments' unique `(refund_key, allocation_id, kind)` index makes a second run abort, and
 * it then answers `alreadyApplied: true` having moved nothing.
 *
 * ── Scope (§ 6.2) ──────────────────────────────────────────────────────────────────────────
 *  - order: its `order` rows and, for COD, the rows of `codCollectionIds` (default: every goods
 *    collection of the order) — vendor, platform and platform_ai only. Agency and agent rows are
 *    NEVER touched (C-1), nor the agency's COD handling fee (C-3), nor a fee-only collection.
 *    Plus the VENDOR's own `shipment`-source rows (an RTO leftover handed back to them — C-8).
 *  - Whether the delivery money was SPENT (any `shipment` row, or an agency/agent row on the
 *    order or its collections) decides who bears the goods gap and the delivery part: spent →
 *    the vendor (C-1, C-8); never spent → the platform returns money it still holds (finding 1).
 *  - booking: its own rows AND the balance-payment rows (their own `source_id`).
 * `amount` on an allocation is never written here; only `clawed_amount` moves.
 */

export interface RefundAttribution {
  goods: number;
  delivery: number;
}

export interface ClawbackOutcome {
  refundKey: string;
  /** True when this refund was already applied; nothing moved this time. */
  alreadyApplied: boolean;
  fromPending: number;
  fromReserve: number;
  fromAvailable: number;
  /** Newly owed by the owner(s): nothing could cover it. */
  toDebt: number;
  allocationsTouched: number;
  /**
   * Money nobody gives back — never allocated to anyone (a delivery that was never spent: the
   * platform still holds it), or a platform share already gone. The platform bears it.
   * Additive to the § 11.3 shape.
   */
  unrecovered: number;
}

export interface ApplyRefundInput {
  refundKey: string;
  target: PauseTarget;
  attribution: RefundAttribution;
  codCollectionIds?: string[];
}

export interface WriteOffInput {
  ownerType: EarningsOwnerType;
  ownerId: string | null;
  amount: number;
  reason: string;
  actor: { id: string | null; name: string | null };
}

export interface WriteOffOutcome {
  writeOffKey: string;
  ownerType: EarningsOwnerType;
  ownerId: string | null;
  amount: number;
  currency: string;
  clawbackBefore: number;
  clawbackAfter: number;
  adjustmentId: string;
}

export interface DebtorRow {
  ownerType: EarningsOwnerType;
  ownerId: string | null;
  clawback: number;
  available: number;
  pending: number;
  reserve: number;
  requested: number;
  currency: string;
  /** A payout that was already waiting when the debt appeared — never cut (C-7). */
  heldPayout: { id: string; amount: number; status: string; ticketId: string | null } | null;
  updatedAt: string;
}

/** Shares a refund may take back. Agency and agent rows are never in scope (C-1, C-3). */
const CLAWABLE_BENEFICIARIES: readonly EarningsOwnerType[] = ['vendor', 'platform', 'platform_ai'];

interface Scope {
  /** Sources whose rows are in scope. */
  sources: SourceRef[];
  /** The order/booking sources (where a vendor-beyond row is filed). */
  homeSources: SourceRef[];
  homeSource: SourceRef;
  vendorId: string | null;
  currency: string;
  /**
   * Where the order's delivery money is divided when it is spent: its shipments, every COD
   * collection (fee-only ones included) and the order itself (legacy payment-time agency rows).
   * Any row there that `isDeliveryRow` accepts means the delivery was spent.
   * Empty for a booking (no delivery).
   */
  deliveryProbe: SourceRef[];
}

/**
 * Is this row evidence that the delivery money was DIVIDED? A row on a shipment source (the
 * courier's split, or an RTO leftover back to the vendor), or an agency/agent row anywhere.
 */
function isDeliveryRow(row: Pick<IEarningsAllocation, 'source_type' | 'beneficiary_type'>): boolean {
  return row.source_type === 'shipment' || row.beneficiary_type === 'agency' || row.beneficiary_type === 'agent';
}

const EMPTY = (refundKey: string, alreadyApplied: boolean): ClawbackOutcome => ({
  refundKey,
  alreadyApplied,
  fromPending: 0,
  fromReserve: 0,
  fromAvailable: 0,
  toDebt: 0,
  allocationsTouched: 0,
  unrecovered: 0,
});

function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: number; errorResponse?: { code?: number }; message?: string } | null;
  return e?.code === 11000 || e?.errorResponse?.code === 11000 || /E11000/.test(e?.message ?? '');
}

function assertAmount(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw createAppError(ERROR_CODES.EARNINGS_CLAWBACK_INVALID_AMOUNT, 422, `${name} must be a whole, non-negative amount`, { [name]: n });
  }
}

export class EarningsClawbackService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository(),
    private readonly accountRepo: EarningsAccountRepository = new EarningsAccountRepository(),
    private readonly adjustmentRepo: EarningsAdjustmentRepository = new EarningsAdjustmentRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    /** Optional: built on first use, so loading this module never constructs the ticket stack. */
    private ticketNotes?: TicketNoteService
  ) {}

  /** A refund's money ARRIVED: take back `attribution` by the rules of § 6.2. */
  async applyRefund(input: ApplyRefundInput): Promise<ClawbackOutcome> {
    const { refundKey, target, attribution } = input;
    assertAmount('goods', attribution.goods);
    assertAmount('delivery', attribution.delivery);
    if (attribution.goods + attribution.delivery === 0) return EMPTY(refundKey, false);

    const scope = await this.scopeOf(target, input.codCollectionIds);
    return this.run(refundKey, scope, async (rows, session) => {
      const prior = await this.priorAttribution(refundKey, rows, scope, session);
      const plan = planClawback({
        rows: rows.map(toPlanRow),
        goods: attribution.goods,
        delivery: attribution.delivery,
        priorGoods: prior.goods,
        priorDelivery: prior.delivery,
        deliverySpent: await this.deliverySpent(scope, session),
      });
      return { lines: plan.lines, vendorBeyond: plan.vendorBeyond, unrecovered: plan.unrecovered, attribution };
    });
  }

  /**
   * Dispute lost (or any "everything goes back"): every in-scope share gives back all it still
   * has, released ones included. Same scope and idempotency as `applyRefund`.
   */
  async reverseRemaining(target: PauseTarget, refundKey: string): Promise<ClawbackOutcome> {
    const scope = await this.scopeOf(target);
    return this.run(refundKey, scope, async (rows) => {
      const lines = planRemaining(rows.map(toPlanRow));
      const goods = lines.reduce((s, l) => s + l.total, 0);
      return {
        lines,
        vendorBeyond: { goods: 0, delivery: 0, total: 0 },
        unrecovered: 0,
        attribution: { goods, delivery: 0 },
      };
    });
  }

  /**
   * Forgive part or all of an owner's debt (C-6). The platform absorbs it. Four-eyes at
   * ≥ 2,000,000 is wi-admin's to enforce (`money.earnings.clawback.write_off`); this records who.
   */
  async writeOff(input: WriteOffInput): Promise<WriteOffOutcome> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw createAppError(ERROR_CODES.EARNINGS_CLAWBACK_INVALID_AMOUNT, 422, 'amount must be a positive whole amount');
    }
    const writeOffKey = `write_off:${new Types.ObjectId().toString()}`;
    return transactionManager.runInTransactionWithRetry(async (session) => {
      const before = await this.accountRepo.getOrCreate(input.ownerType, input.ownerId, session);
      const after = await this.accounts.writeOffInSession(input.ownerType, input.ownerId, input.amount, session);
      const row = await this.adjustmentRepo.create(
        {
          refund_key: writeOffKey,
          allocation_id: null,
          source_type: null,
          source_id: null,
          beneficiary_type: input.ownerType,
          beneficiary_id: input.ownerId,
          amount: input.amount,
          currency: after.currency,
          taken_from: { pending: 0, reserve: 0, available: 0, debt: input.amount },
          kind: 'write_off',
          actor: { id: input.actor.id, name: input.actor.name },
          reason: input.reason,
        },
        session
      );
      return {
        writeOffKey,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        amount: input.amount,
        currency: after.currency,
        clawbackBefore: before.clawback_balance ?? 0,
        clawbackAfter: after.clawback_balance,
        adjustmentId: (row._id as Types.ObjectId).toString(),
      };
    });
  }

  /** Owners who owe money back, largest first — the write-off queue (§ 6.4, § 6.6). */
  async listDebtors(
    ownerType: EarningsOwnerType | null,
    page: number,
    limit: number
  ): Promise<{ items: DebtorRow[]; total: number }> {
    const { data, total } = await this.accountRepo.listDebtors(ownerType, page, limit);
    const owned = data.filter((a) => a.owner_id);
    const payouts = owned.length
      ? await PayoutRequestModel.find({
          status: { $in: [...PAYOUT_HELD_STATUSES] },
          $or: owned.map((a) => ({ owner_type: a.owner_type, owner_id: a.owner_id })),
        }).lean()
      : [];
    const payoutByOwner = new Map(payouts.map((p: any) => [`${p.owner_type}:${p.owner_id.toString()}`, p]));
    return {
      total,
      items: data.map((a) => {
        const p: any = a.owner_id ? payoutByOwner.get(`${a.owner_type}:${a.owner_id.toString()}`) : undefined;
        return {
          ownerType: a.owner_type,
          ownerId: a.owner_id ? a.owner_id.toString() : null,
          clawback: a.clawback_balance ?? 0,
          available: a.available_balance,
          pending: a.pending_balance,
          reserve: a.reserve_balance,
          requested: a.requested_balance,
          currency: a.currency,
          heldPayout: p
            ? { id: p._id.toString(), amount: p.amount, status: p.status, ticketId: p.ticket_id ? p.ticket_id.toString() : null }
            : null,
          updatedAt: a.updated_at.toISOString(),
        };
      }),
    };
  }

  // ── The engine ────────────────────────────────────────────────────────────────────────

  private async run(
    refundKey: string,
    scope: Scope,
    plan: (
      rows: IEarningsAllocation[],
      session: ClientSession
    ) => Promise<{
      lines: ClawPlanLine[];
      vendorBeyond: { goods: number; delivery: number; total: number };
      unrecovered: number;
      attribution: RefundAttribution;
    }>
  ): Promise<ClawbackOutcome> {
    if (!refundKey || !refundKey.trim()) {
      throw createAppError(ERROR_CODES.EARNINGS_CLAWBACK_INVALID_AMOUNT, 422, 'refundKey is required');
    }
    if (await this.adjustmentRepo.existsForRefund(refundKey)) return EMPTY(refundKey, true);

    const debtors = new Map<string, { ownerType: EarningsOwnerType; ownerId: string }>();
    let outcome: ClawbackOutcome;
    try {
      outcome = await transactionManager.runInTransactionWithRetry(async (session) => {
        debtors.clear();
        const result = EMPTY(refundKey, false);
        if (await this.adjustmentRepo.existsForRefund(refundKey, session)) return EMPTY(refundKey, true);

        const rows = (await this.allocationRepo.findBySources(scope.sources, session)).filter((r) =>
          CLAWABLE_BENEFICIARIES.includes(r.beneficiary_type)
        );
        const planned = await plan(rows, session);
        const byId = new Map(rows.map((r) => [(r._id as Types.ObjectId).toString(), r]));
        const now = new Date();

        const add = (taken: TakenFrom, ownerType: EarningsOwnerType, ownerId: string | null): void => {
          result.fromPending += taken.pending;
          result.fromReserve += taken.reserve;
          result.fromAvailable += taken.available;
          result.toDebt += taken.debt;
          if (taken.debt > 0 && ownerId) debtors.set(`${ownerType}:${ownerId}`, { ownerType, ownerId });
        };

        for (const line of planned.lines) {
          const row = byId.get(line.id);
          if (!row || line.total <= 0) continue;
          const status = row.status;
          if (status === 'reversed') continue; // the plan gives a reversed row nothing; belt and braces
          const taken = await this.accounts.clawInSession(row, line.total, session, now);
          const claimed = await this.allocationRepo.addClawed(
            row._id as Types.ObjectId,
            status,
            row.clawed_amount ?? 0,
            line.total,
            row.amount,
            now,
            session
          );
          if (!claimed) {
            throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings clawback lost a race on an allocation', {
              allocationId: line.id,
              refundKey,
            });
          }
          await this.adjustmentRepo.create(
            {
              refund_key: refundKey,
              allocation_id: row._id as Types.ObjectId,
              source_type: row.source_type,
              source_id: row.source_id,
              beneficiary_type: row.beneficiary_type,
              beneficiary_id: row.beneficiary_id,
              amount: line.total,
              currency: row.currency,
              taken_from: taken,
              kind: 'refund_clawback',
              goods_amount: line.goods,
              delivery_amount: line.delivery,
              refund_attribution: planned.attribution,
            },
            session
          );
          add(taken, row.beneficiary_type, row.beneficiary_id ? row.beneficiary_id.toString() : null);
          result.allocationsTouched += 1;
        }

        if (planned.vendorBeyond.total > 0 && scope.vendorId) {
          const home = rows.find((r) => r.beneficiary_type === 'vendor') ?? null;
          const taken = await this.accounts.clawBeyondInSession(
            'vendor',
            scope.vendorId,
            planned.vendorBeyond.total,
            home,
            session
          );
          await this.adjustmentRepo.create(
            {
              refund_key: refundKey,
              allocation_id: null,
              source_type: scope.homeSource.sourceType,
              source_id: scope.homeSource.sourceId,
              beneficiary_type: 'vendor',
              beneficiary_id: scope.vendorId,
              amount: planned.vendorBeyond.total,
              currency: home?.currency ?? scope.currency,
              taken_from: taken,
              kind: 'refund_clawback',
              goods_amount: planned.vendorBeyond.goods,
              delivery_amount: planned.vendorBeyond.delivery,
              refund_attribution: planned.attribution,
            },
            session
          );
          add(taken, 'vendor', scope.vendorId);
        } else if (planned.vendorBeyond.total > 0) {
          result.unrecovered += planned.vendorBeyond.total;
        }
        result.unrecovered += planned.unrecovered;
        return result;
      });
    } catch (error) {
      // A concurrent run of the same refund won the unique index: nothing moved here.
      if (isDuplicateKey(error)) return EMPTY(refundKey, true);
      throw error;
    }

    if (!outcome.alreadyApplied && debtors.size > 0) await this.notePendingPayouts(refundKey, [...debtors.values()]);
    return outcome;
  }

  /**
   * C-7: a payout already waiting when the debt appears is NOT cut — its ticket gets a note, so
   * the administrator deciding it knows. If they reject it, the money pays the debt on its way
   * back (`revertPayoutToAvailableInSession` nets). Best-effort: the clawback stands either way.
   */
  private async notePendingPayouts(
    refundKey: string,
    owners: Array<{ ownerType: EarningsOwnerType; ownerId: string }>
  ): Promise<void> {
    for (const owner of owners) {
      try {
        const payout: any = await PayoutRequestModel.findOne({
          owner_type: owner.ownerType,
          owner_id: new Types.ObjectId(owner.ownerId),
          status: { $in: [...PAYOUT_HELD_STATUSES] },
        }).lean();
        if (!payout?.ticket_id) continue;
        const account = await this.accountRepo.find(owner.ownerType, owner.ownerId);
        const owed = account?.clawback_balance ?? 0;
        this.ticketNotes ??= new TicketNoteService();
        await this.ticketNotes.createSystemNote(
          payout.ticket_id.toString(),
          `A refund (${refundKey}) was recovered from this owner's earnings and left them owing ` +
            `${account?.currency ?? 'XAF'} ${owed.toLocaleString()} back to the platform. ` +
            `This payout is NOT reduced automatically. If you reject it, the returned money pays the debt first.`
        );
      } catch (error) {
        console.error(`[EarningsClawback] could not note the pending payout of ${owner.ownerType} ${owner.ownerId}:`, error);
      }
    }
  }

  /**
   * What earlier refunds of this scope were worth: the attribution each one recorded, once
   * per refund key (every row a refund wrote carries the whole refund's attribution).
   */
  private async priorAttribution(
    refundKey: string,
    rows: IEarningsAllocation[],
    scope: Scope,
    session: ClientSession
  ): Promise<RefundAttribution> {
    const prior = await this.adjustmentRepo.findPriorClawbacks(
      rows.map((r) => r._id as Types.ObjectId),
      scope.homeSources,
      session
    );
    const seen = new Map<string, RefundAttribution>();
    for (const row of prior) {
      if (row.refund_key === refundKey || !row.refund_attribution) continue;
      if (!seen.has(row.refund_key)) {
        seen.set(row.refund_key, {
          goods: row.refund_attribution.goods ?? 0,
          delivery: row.refund_attribution.delivery ?? 0,
        });
      }
    }
    let goods = 0;
    let delivery = 0;
    for (const a of seen.values()) {
      goods += a.goods;
      delivery += a.delivery;
    }
    return { goods, delivery };
  }

  /** Was the delivery money divided to anyone (finding 1 / C-8)? Read inside the claw's transaction. */
  private async deliverySpent(scope: Scope, session: ClientSession): Promise<boolean> {
    if (scope.deliveryProbe.length === 0) return false;
    const rows = await this.allocationRepo.findBySources(scope.deliveryProbe, session);
    return rows.some(isDeliveryRow);
  }

  /** The in-scope sources of an order or booking (§ 6.2). */
  private async scopeOf(target: PauseTarget, codCollectionIds?: string[]): Promise<Scope> {
    if (target.kind === 'booking') {
      const booking: any = await Booking.findById(target.id, { vendorId: 1, currency: 1 }).lean();
      if (!booking) throw createAppError(ERROR_CODES.EARNINGS_PAUSE_TARGET_NOT_FOUND, 404);
      const sources = await bookingSourcesOf(target.id);
      return {
        sources,
        homeSources: sources,
        homeSource: sources[0],
        vendorId: booking.vendorId ? booking.vendorId.toString() : null,
        currency: booking.currency ?? 'XAF',
        deliveryProbe: [],
      };
    }

    const order: any = await OrderModel.findById(target.id, { vendor_id: 1, currency: 1 }).lean();
    if (!order) throw createAppError(ERROR_CODES.EARNINGS_PAUSE_TARGET_NOT_FOUND, 404);
    const orderId = new Types.ObjectId(target.id);
    // A FEE-ONLY collection is delivery cash for the agency side (W-F, C-1/C-3): never in scope.
    const filter: Record<string, unknown> = { order_id: orderId, kind: { $ne: 'delivery_fee' } };
    if (codCollectionIds && codCollectionIds.length > 0) {
      filter._id = { $in: codCollectionIds.map((id) => new Types.ObjectId(id)) };
    }
    const [collections, allCollections, shipments] = await Promise.all([
      CashCollectionModel.find(filter, { _id: 1 }).lean(),
      CashCollectionModel.find({ order_id: orderId }, { _id: 1 }).lean(),
      ShipmentModel.find({ order_id: orderId }, { _id: 1 }).lean(),
    ]);
    const home: SourceRef = { sourceType: 'order', sourceId: target.id };
    const shipmentSources: SourceRef[] = shipments.map((s: any) => ({ sourceType: 'shipment' as const, sourceId: s._id.toString() }));
    return {
      sources: [
        home,
        ...collections.map((c: any) => ({ sourceType: 'cod_collection' as const, sourceId: c._id.toString() })),
        // C-8: the VENDOR's own shipment rows (an RTO leftover handed back to them) are in scope.
        // `CLAWABLE_BENEFICIARIES` still drops the agency and agent rows on them (C-1).
        ...shipmentSources,
      ],
      homeSources: [home],
      homeSource: home,
      vendorId: order.vendor_id ? order.vendor_id.toString() : null,
      currency: order.currency ?? 'XAF',
      deliveryProbe: [
        home,
        ...allCollections.map((c: any) => ({ sourceType: 'cod_collection' as const, sourceId: c._id.toString() })),
        ...shipmentSources,
      ],
    };
  }
}

/** An allocation as the plan sees it. A reversed row has nothing left, whatever it says. */
function toPlanRow(row: IEarningsAllocation): ClawPlanRow {
  const clawed = row.clawed_amount ?? 0;
  return {
    id: (row._id as Types.ObjectId).toString(),
    isVendor: row.beneficiary_type === 'vendor',
    amount: row.amount,
    remaining: row.status === 'reversed' ? 0 : Math.max(0, row.amount - clawed),
  };
}

export const earningsClawbackService = new EarningsClawbackService();
