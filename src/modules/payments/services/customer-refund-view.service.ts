import { Types } from 'mongoose';
import { RefundRequestModel } from '../models/refund-request.model';
import { CustomerRefundBlock, CustomerRefundSourceRow, toCustomerRefundBlock } from '../dto/customer-refund.dto';

/**
 * The refund block for a SET of orders or bookings, in one query (REFUND-FLOW-PLAN § 8).
 *
 * Batched for the same reason `CustomerOrderViewService` batches everything else: a checkout
 * group is several orders, a booking list is a page of them, and a per-row query on the
 * customer's most-visited screens is the shape that view exists to avoid.
 *
 * Reads the LATEST request per source (`refund_requests` is indexed on `{source_id, created_at}`),
 * open or closed. A source with no request is simply absent from the map — the caller projects
 * `null`.
 */
export class CustomerRefundViewService {
  async latestBySources(kind: 'order' | 'booking', sourceIds: readonly string[]): Promise<Map<string, CustomerRefundBlock>> {
    const out = new Map<string, CustomerRefundBlock>();
    const ids = [...new Set(sourceIds)].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return out;

    const rows = await RefundRequestModel.find(
      { source_kind: kind, source_id: { $in: ids } },
      { source_id: 1, status: 1, gross_amount: 1, fee_amount: 1, fee_rate: 1, net_amount: 1, currency: 1, channel: 1, destination: 1, completed_at: 1, created_at: 1 }
    )
      .sort({ created_at: -1, _id: -1 })
      .lean<Array<CustomerRefundSourceRow & { source_id: Types.ObjectId }>>()
      .exec();

    for (const row of rows) {
      const key = String(row.source_id);
      if (out.has(key)) continue; // sorted newest first: the first row per source is the latest
      const block = toCustomerRefundBlock(row);
      if (block) out.set(key, block);
    }
    return out;
  }

  async latestForSource(kind: 'order' | 'booking', sourceId: string): Promise<CustomerRefundBlock | null> {
    return (await this.latestBySources(kind, [sourceId])).get(sourceId) ?? null;
  }
}

export const customerRefundViewService = new CustomerRefundViewService();
