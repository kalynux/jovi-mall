import { Types } from 'mongoose';
import { ProviderContactConsentModel, IProviderContactConsent } from '../models/provider-contact-consent.model';
import { ListingModel } from '../models/listing.model';
import { ProviderConsentSource } from '../domain/listing.types';

/**
 * ProviderConsentRepository — `provider_contact_consents`, a customer's opt-in to messages from
 * ONE provider (SERVICE-LISTINGS-PLAN L-14, § C-2).
 *
 * Written only on the CUSTOMER's behalf — their tap, their settings page — and by the bot
 * stamping `asked_at` the one time it asks. The provider and an administrator never write it
 * (the customer-closure eraser in `role-closure.manifest.ts` revokes, as the customer's own
 * closure). The messaging builder only READS it.
 *
 * Granted = `granted_at != null && revoked_at == null`. The default is No: no row, or a row
 * with `granted_at: null`.
 */
export type ProviderConsentRow = IProviderContactConsent & { _id: Types.ObjectId };

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

export class ProviderConsentRepository {
  async find(customerId: string, vendorId: string): Promise<ProviderConsentRow | null> {
    if (!Types.ObjectId.isValid(customerId) || !Types.ObjectId.isValid(vendorId)) return null;
    return ProviderContactConsentModel.findOne({ customer_id: oid(customerId), vendor_id: oid(vendorId) }).lean<ProviderConsentRow>();
  }

  /** Many customers' consent toward ONE provider, keyed by customer id — the lead list. */
  async towardProvider(vendorId: string, customerIds: string[]): Promise<Map<string, ProviderConsentRow>> {
    const ids = [...new Set(customerIds)].filter((id) => Types.ObjectId.isValid(id)).map(oid);
    if (ids.length === 0 || !Types.ObjectId.isValid(vendorId)) return new Map();
    const rows = await ProviderContactConsentModel.find({ vendor_id: oid(vendorId), customer_id: { $in: ids } })
      .lean<ProviderConsentRow[]>();
    return new Map(rows.map((r) => [r.customer_id.toString(), r]));
  }

  /** Every consent row of a customer — newest change first. */
  async listForCustomer(customerId: string): Promise<ProviderConsentRow[]> {
    if (!Types.ObjectId.isValid(customerId)) return [];
    return ProviderContactConsentModel.find({ customer_id: oid(customerId) })
      .sort({ updated_at: -1, _id: -1 })
      .limit(200)
      .lean<ProviderConsentRow[]>();
  }

  /** Grant (or grant again): `granted_at` now, `revoked_at` cleared. */
  async grant(customerId: string, vendorId: string, source: ProviderConsentSource, now: Date): Promise<void> {
    await ProviderContactConsentModel.updateOne(
      { customer_id: oid(customerId), vendor_id: oid(vendorId) },
      { $set: { granted_at: now, revoked_at: null, source }, $setOnInsert: { asked_at: null } },
      { upsert: true },
    );
  }

  /**
   * Say No. A GRANTED consent is withdrawn (`revoked_at` stamped, the history kept); a consent
   * never granted stays at the default (a row with `granted_at: null`, created if missing so the
   * question is not asked again).
   */
  async refuse(customerId: string, vendorId: string, source: ProviderConsentSource, now: Date): Promise<void> {
    const withdrawn = await ProviderContactConsentModel.updateOne(
      { customer_id: oid(customerId), vendor_id: oid(vendorId), granted_at: { $ne: null }, revoked_at: null },
      { $set: { revoked_at: now, source } },
    );
    if (withdrawn.matchedCount > 0) return;
    await ProviderContactConsentModel.updateOne(
      { customer_id: oid(customerId), vendor_id: oid(vendorId) },
      { $setOnInsert: { granted_at: null, revoked_at: null, asked_at: null, source } },
      { upsert: true },
    );
  }

  /**
   * The bot is about to ASK. Creates the row with `asked_at: now` and returns `true` — or returns
   * `false` and writes nothing when any row already exists (asked before, or answered from the
   * website). One atomic upsert, so two reveals in a burst ask the question once.
   */
  async markAskedIfNew(customerId: string, vendorId: string, now: Date): Promise<boolean> {
    const res = await ProviderContactConsentModel.updateOne(
      { customer_id: oid(customerId), vendor_id: oid(vendorId) },
      { $setOnInsert: { asked_at: now, granted_at: null, revoked_at: null, source: 'bot' } },
      { upsert: true },
    );
    return (res.upsertedCount ?? 0) > 0;
  }

  /**
   * The name a customer knows each provider by: the company name of that provider's most
   * recently approved listing. A provider has no store, so this is the only public name it has.
   */
  async businessNamesFor(vendorIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(vendorIds)].filter((id) => Types.ObjectId.isValid(id)).map(oid);
    if (ids.length === 0) return new Map();
    const rows = await ListingModel.aggregate<{ _id: Types.ObjectId; name: string | null }>([
      { $match: { vendor_id: { $in: ids }, published: { $ne: null } } },
      { $sort: { published_at: -1, _id: -1 } },
      { $group: { _id: '$vendor_id', name: { $first: '$published.company_name' } } },
    ]);
    return new Map(rows.filter((r) => !!r.name).map((r) => [r._id.toString(), r.name as string]));
  }
}

export const providerConsentRepository = new ProviderConsentRepository();
