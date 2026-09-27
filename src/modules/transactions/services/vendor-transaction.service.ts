import { Types } from 'mongoose';
import { PlanPurchaseModel, IPlanPurchase } from '../../billing/models/plan-purchase.model';
import { CreditTopupModel, ICreditTopup } from '../../billing/models/credit-topup.model';
import {
  CreditTransactionModel,
  ICreditTransaction,
  CreditReasonCode,
} from '../../billing/models/credit-transaction.model';
import { EarningsLedgerModel, IEarningsLedger } from '../../earnings/models/earnings-ledger.model';
import { PayoutRequestModel, IPayoutRequest } from '../../earnings/models/payout-request.model';
import { earningsAccountService } from '../../earnings/services/earnings-account.service';
import { VendorTransaction, TransactionCategory } from '../transaction.types';
import { BillingOwnerType } from '../../billing/billing.types';

/** Credit ledger rows tied to a top-up — represented by the CreditTopup row instead. */
const TOPUP_REASON_CODES: CreditReasonCode[] = ['topup_purchase', 'topup_reversal'];

const CREDIT_TYPE_BY_REASON: Partial<Record<CreditReasonCode, string>> = {
  plan_allowance: 'credit_allowance',
  vectorisation: 'credit_usage',
  whatsapp_template: 'credit_usage',
  admin_adjustment: 'credit_adjustment',
};

const CREDIT_DESC_BY_REASON: Partial<Record<CreditReasonCode, string>> = {
  plan_allowance: 'Plan credit allowance',
  vectorisation: 'Product vectorisation',
  whatsapp_template: 'WhatsApp template message',
  admin_adjustment: 'Admin credit adjustment',
};

/**
 * SubscriberTransactionService — merges an owner's (vendor/agency/agent) billing +
 * earnings history into one normalized, paginated feed. Sources are queried
 * independently and merged in memory (sorted by `created_at` desc). Top-ups are
 * represented once (by their CreditTopup row); the matching credit-ledger rows are
 * filtered out to dedup.
 */
export class VendorTransactionService {
  async list(
    ownerType: BillingOwnerType,
    ownerIdStr: string,
    opts: { page: number; limit: number; category?: TransactionCategory }
  ): Promise<{ data: VendorTransaction[]; total: number; page: number; limit: number }> {
    const { page, limit, category } = opts;
    const ownerId = new Types.ObjectId(ownerIdStr);
    const fetchN = page * limit; // enough from each source to satisfy this offset page

    const wantPlan = !category || category === 'plan';
    const wantCredit = !category || category === 'credit';
    const wantEarning = !category || category === 'earning';
    // Served since 2026-09-27. Payout movements write no earnings-ledger rows
    // (`earnings-account.service.ts`), so without these the feed could never reconcile.
    const wantPayout = !category || category === 'payout';

    const planFilter = { owner_type: ownerType, owner_id: ownerId };
    const topupFilter = { owner_type: ownerType, owner_id: ownerId };
    const creditFilter = {
      owner_type: ownerType,
      owner_id: ownerId,
      reason_code: { $nin: TOPUP_REASON_CODES },
    };
    const earningFilter = { owner_type: ownerType, owner_id: ownerId };
    const payoutFilter = { owner_type: ownerType, owner_id: ownerId };

    // Earnings rows don't store their own currency — read it from the account once.
    const earningsCurrency = wantEarning
      ? (await earningsAccountService.getBalances(ownerType, ownerIdStr)).currency
      : 'XAF';

    const [payoutDocs, payoutCount] = await Promise.all([
      wantPayout
        ? PayoutRequestModel.find(payoutFilter).sort({ created_at: -1 }).limit(fetchN).exec()
        : Promise.resolve([] as IPayoutRequest[]),
      wantPayout ? PayoutRequestModel.countDocuments(payoutFilter) : Promise.resolve(0),
    ]);

    const [planDocs, topupDocs, creditDocs, earningDocs, planCount, topupCount, creditCount, earningCount] =
      await Promise.all([
        wantPlan
          ? PlanPurchaseModel.find(planFilter).sort({ created_at: -1 }).limit(fetchN).exec()
          : Promise.resolve([] as IPlanPurchase[]),
        wantCredit
          ? CreditTopupModel.find(topupFilter).sort({ created_at: -1 }).limit(fetchN).exec()
          : Promise.resolve([] as ICreditTopup[]),
        wantCredit
          ? CreditTransactionModel.find(creditFilter).sort({ created_at: -1 }).limit(fetchN).exec()
          : Promise.resolve([] as ICreditTransaction[]),
        wantEarning
          ? EarningsLedgerModel.find(earningFilter).sort({ created_at: -1 }).limit(fetchN).exec()
          : Promise.resolve([] as IEarningsLedger[]),
        wantPlan ? PlanPurchaseModel.countDocuments(planFilter) : Promise.resolve(0),
        wantCredit ? CreditTopupModel.countDocuments(topupFilter) : Promise.resolve(0),
        wantCredit ? CreditTransactionModel.countDocuments(creditFilter) : Promise.resolve(0),
        wantEarning ? EarningsLedgerModel.countDocuments(earningFilter) : Promise.resolve(0),
      ]);

    const merged: VendorTransaction[] = [
      ...planDocs.map(this.mapPlanPurchase),
      ...topupDocs.map(this.mapTopup),
      ...creditDocs.map(this.mapCreditTransaction),
      ...earningDocs.map((d) => mapEarning(d, earningsCurrency, ownerType)),
      ...payoutDocs.map(mapPayout),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = planCount + topupCount + creditCount + earningCount + payoutCount;
    const start = (page - 1) * limit;
    return { data: merged.slice(start, start + limit), total, page, limit };
  }

  // ─── Mappers ────────────────────────────────────────────────────────────────

  private mapPlanPurchase(p: IPlanPurchase): VendorTransaction {
    return {
      id: p._id.toString(),
      category: 'plan',
      type: 'plan_purchase',
      status: p.status,
      unit: 'money',
      direction: 'out',
      amount: p.price,
      currency: p.currency,
      description: `Plan purchase — ${p.plan_code}`,
      gateway: p.gateway ?? undefined,
      source: { type: 'plan', id: p.plan_code },
      createdAt: p.created_at,
    };
  }

  private mapTopup(t: ICreditTopup): VendorTransaction {
    return {
      id: t._id.toString(),
      category: 'credit',
      type: 'credit_topup',
      status: t.status,
      unit: 'money',
      direction: 'out',
      amount: t.price,
      currency: t.currency,
      credits: t.credits,
      description: `Credit top-up — ${t.credits} credits (${t.pack_code})`,
      gateway: t.gateway ?? undefined,
      source: { type: 'pack', id: t.pack_code },
      createdAt: t.created_at,
    };
  }

  private mapCreditTransaction(c: ICreditTransaction): VendorTransaction {
    return {
      id: c._id.toString(),
      category: 'credit',
      type: CREDIT_TYPE_BY_REASON[c.reason_code] ?? 'credit_movement',
      status: 'completed',
      unit: 'credit',
      direction: c.amount >= 0 ? 'in' : 'out',
      amount: Math.abs(c.amount),
      credits: Math.abs(c.amount),
      description: CREDIT_DESC_BY_REASON[c.reason_code] ?? 'Credit movement',
      source: c.ref ? { type: 'credit', id: c.ref } : undefined,
      createdAt: c.created_at,
    };
  }

}

const SOURCE_LABEL: Record<string, string> = {
  order: 'an online order',
  cod_collection: 'a cash-on-delivery collection',
  shipment: 'a delivery',
  booking: 'a booking',
};

/**
 * One earnings-ledger row as a feed row. Exported for `test:transactions-feed`.
 *
 * ── Directions (2026-09-27) ───────────────────────────────────────────────────
 *  - `hold` → **in**: money credited to the owner (held in escrow).
 *  - `release` → **internal**: the SAME money moving escrow → available. It used to be `in`,
 *    which counted every earning twice.
 *  - `reversal` → **out**: held money taken back (a full refund).
 *  - `reserve_hold` / `reserve_release` → **internal**: available ↔ the agency's COD reserve.
 *    They were labelled "Earning reversed (refund)" and marked `in`.
 */
export function mapEarning(e: IEarningsLedger, currency: string, ownerType: string): VendorTransaction {
  const from = SOURCE_LABEL[e.source_type] ?? e.source_type;
  const what = ownerType === 'vendor' ? 'Sale' : 'Delivery earning';
  const byType: Record<string, { direction: VendorTransaction['direction']; description: string }> = {
    hold: { direction: 'in', description: `${what} credited from ${from} — held in escrow` },
    release: { direction: 'internal', description: 'Earning released from escrow to your available balance' },
    reversal: { direction: 'out', description: `Earning reversed — ${from} was refunded` },
    reserve_hold: { direction: 'internal', description: 'Moved to your COD reserve (security against cash shortfalls)' },
    reserve_release: { direction: 'internal', description: 'Returned from your COD reserve to your available balance' },
  };
  const mapped = byType[e.entry_type] ?? { direction: 'internal' as const, description: 'Earnings movement' };

  return {
    id: e._id.toString(),
    category: 'earning',
    type: `earning_${e.entry_type}`,
    status: e.entry_type,
    unit: 'money',
    direction: mapped.direction,
    amount: e.amount,
    currency,
    description: mapped.description,
    source: { type: e.source_type, id: e.source_id.toString() },
    createdAt: e.created_at,
  };
}

/**
 * One payout request as a feed row. Exported for `test:transactions-feed`.
 *
 * Only a PAID payout leaves the owner's money (`out`). Pending/processing money is reserved
 * inside the owner's balances (available → requested), and a rejected or failed one went back to
 * available — both `internal`. The destination is never printed: the method kind only.
 */
export function mapPayout(p: IPayoutRequest): VendorTransaction {
  const method = (p as unknown as { payout_method_snapshot?: { method?: string } | null }).payout_method_snapshot?.method;
  const label: Record<string, string> = {
    paid: 'Payout sent',
    pending: 'Payout requested — awaiting review',
    processing: 'Payout being sent',
    rejected: 'Payout rejected — amount returned to your available balance',
    failed: 'Payout failed — amount returned to your available balance',
  };
  return {
    id: p._id.toString(),
    category: 'payout',
    type: 'payout',
    status: p.status,
    unit: 'money',
    direction: p.status === 'paid' ? 'out' : 'internal',
    amount: p.amount,
    currency: p.currency,
    description: `${label[p.status] ?? 'Payout'}${method ? ` (${method})` : ''}`,
    source: { type: 'payout', id: p._id.toString() },
    createdAt: p.created_at,
  };
}

export const vendorTransactionService = new VendorTransactionService();
