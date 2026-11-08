import { Types } from 'mongoose';
import { ProviderCustomerMessageModel, IProviderCustomerMessage } from '../models/provider-customer-message.model';
import { ProviderMessageChannel, ProviderMessageKind } from '../domain/listing.types';
import { MessageCounts } from '../domain/lead-rules';

/**
 * ProviderMessageRepository — `provider_customer_messages`, every message a provider sent a
 * customer through Wi-Mall (SERVICE-LISTINGS-PLAN L-15, L-24, § C-2). It is the caps' source:
 * 3 per (provider, customer) per 30 days, at most 1 of them call-me — counting `sent` rows
 * only, so a send Meta or Telegram refused is never spent.
 *
 * Written ONLY by `ProviderMessagingService`: the row is CLAIMED as `sent` before the send (so
 * a second tap in the same instant sees it), and turned `failed` if the send does not go.
 */
export type ProviderMessageRow = IProviderCustomerMessage & { _id: Types.ObjectId };

const oid = (id: string | Types.ObjectId): Types.ObjectId => (typeof id === 'string' ? new Types.ObjectId(id) : id);

export interface NewProviderMessage {
  vendorId: string;
  customerId: string;
  leadId: string;
  listingId: string;
  kind: ProviderMessageKind;
  channel: ProviderMessageChannel;
  body: string;
  credits: number;
  at: Date;
}

export class ProviderMessageRepository {
  /** `sent` messages from one provider to one customer since `since`, by kind. */
  async countsSince(vendorId: string, customerId: string, since: Date): Promise<MessageCounts> {
    const rows = await ProviderCustomerMessageModel.aggregate<{ _id: ProviderMessageKind; n: number }>([
      { $match: { vendor_id: oid(vendorId), customer_id: oid(customerId), status: 'sent', at: { $gte: since } } },
      { $group: { _id: '$kind', n: { $sum: 1 } } },
    ]);
    const callMe = rows.find((r) => r._id === 'call_me')?.n ?? 0;
    const freeText = rows.find((r) => r._id === 'free_text')?.n ?? 0;
    return { total: callMe + freeText, callMe };
  }

  /** The counts for many customers of ONE provider at once — the lead list. */
  async countsSinceForCustomers(vendorId: string, customerIds: string[], since: Date): Promise<Map<string, MessageCounts>> {
    const ids = [...new Set(customerIds)].filter((id) => Types.ObjectId.isValid(id)).map(oid);
    if (ids.length === 0) return new Map();
    const rows = await ProviderCustomerMessageModel.aggregate<{ _id: { c: Types.ObjectId; k: ProviderMessageKind }; n: number }>([
      { $match: { vendor_id: oid(vendorId), customer_id: { $in: ids }, status: 'sent', at: { $gte: since } } },
      { $group: { _id: { c: '$customer_id', k: '$kind' }, n: { $sum: 1 } } },
    ]);
    const out = new Map<string, MessageCounts>();
    for (const r of rows) {
      const key = r._id.c.toString();
      const cur = out.get(key) ?? { total: 0, callMe: 0 };
      cur.total += r.n;
      if (r._id.k === 'call_me') cur.callMe += r.n;
      out.set(key, cur);
    }
    return out;
  }

  /** Claim: the row exists as `sent` from here on, so the caps already see it. */
  async claim(input: NewProviderMessage): Promise<ProviderMessageRow> {
    const created = await ProviderCustomerMessageModel.create({
      vendor_id: oid(input.vendorId),
      customer_id: oid(input.customerId),
      lead_id: oid(input.leadId),
      listing_id: oid(input.listingId),
      kind: input.kind,
      channel: input.channel,
      body: input.body,
      credits: input.credits,
      status: 'sent',
      provider_message_id: null,
      at: input.at,
    });
    return created.toObject() as ProviderMessageRow;
  }

  async markSent(id: Types.ObjectId, providerMessageId: string | null): Promise<void> {
    await ProviderCustomerMessageModel.updateOne({ _id: id }, { $set: { provider_message_id: providerMessageId } });
  }

  /** The send did not go: the row stops counting, and the credits (if any) are refunded by the caller. */
  async markFailed(id: Types.ObjectId): Promise<void> {
    await ProviderCustomerMessageModel.updateOne({ _id: id }, { $set: { status: 'failed' } });
  }
}

export const providerMessageRepository = new ProviderMessageRepository();
