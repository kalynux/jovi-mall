import { Types } from 'mongoose';
import { PlanPurchaseModel, IPlanPurchase } from '../../billing/models/plan-purchase.model';
import { CreditTopupModel, ICreditTopup } from '../../billing/models/credit-topup.model';
import {
  CreditTransactionModel,
  ICreditTransaction,
  CreditReasonCode,
} from '../../billing/models/credit-transaction.model';
import { EarningsLedgerModel, IEarningsLedger } from '../../earnings/models/earnings-ledger.model';
import { earningsAccountService } from '../../earnings/services/earnings-account.service';
import { VendorTransaction, TransactionCategory } from '../transaction.types';

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
 * VendorTransactionService — merges the vendor's billing + earnings history into
 * one normalized, paginated feed. Sources are queried independently and merged
 * in memory (sorted by `created_at` desc). Top-ups are represented once (by their
 * CreditTopup row); the matching credit-ledger rows are filtered out to dedup.
 */
export class VendorTransactionService {
  async list(
    vendorId: string,
    opts: { page: number; limit: number; category?: TransactionCategory }
  ): Promise<{ data: VendorTransaction[]; total: number; page: number; limit: number }> {
    const { page, limit, category } = opts;
    const ownerId = new Types.ObjectId(vendorId);
    const fetchN = page * limit; // enough from each source to satisfy this offset page

    const wantPlan = !category || category === 'plan';
    const wantCredit = !category || category === 'credit';
    const wantEarning = !category || category === 'earning';
    // `payout` has no data yet → all flags false → empty feed.

    const planFilter = { vendor_id: ownerId };
    const topupFilter = { vendor_id: ownerId };
    const creditFilter = {
      owner_type: 'vendor',
      owner_id: ownerId,
      reason_code: { $nin: TOPUP_REASON_CODES },
    };
    const earningFilter = { owner_type: 'vendor', owner_id: ownerId };

    // Earnings rows don't store their own currency — read it from the account once.
    const earningsCurrency = wantEarning
      ? (await earningsAccountService.getBalances('vendor', vendorId)).currency
      : 'XAF';

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
      ...earningDocs.map((d) => this.mapEarning(d, earningsCurrency)),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = planCount + topupCount + creditCount + earningCount;
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

  private mapEarning(e: IEarningsLedger, currency: string): VendorTransaction {
    const description =
      e.entry_type === 'hold'
        ? `Earning held from ${e.source_type} sale`
        : e.entry_type === 'release'
          ? 'Earning released to available balance'
          : 'Earning reversed (refund)';

    return {
      id: e._id.toString(),
      category: 'earning',
      type: `earning_${e.entry_type}`,
      status: e.entry_type,
      unit: 'money',
      direction: e.entry_type === 'reversal' ? 'out' : 'in',
      amount: e.amount,
      currency,
      description,
      source: { type: e.source_type, id: e.source_id.toString() },
      createdAt: e.created_at,
    };
  }
}

export const vendorTransactionService = new VendorTransactionService();
