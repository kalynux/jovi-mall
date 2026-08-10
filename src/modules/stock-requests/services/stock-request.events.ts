import { eventBus } from '../../../core/events/event-bus';
import { StoreRepository } from '../../store/repositories/store.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import {
  IStockAdjustmentRequest,
  StockRequestParty,
} from '../models/stock-adjustment-request.model';

/** The three situations a stock request produces. */
export type StockRequestEventType =
  | 'storage.stock_request.received'
  | 'storage.stock_request.approved'
  | 'storage.stock_request.rejected';

/** What the copy needs that only the caller has already loaded. */
export interface StockRequestEventContext {
  productTitle: string;
  sku: string;
}

const stores = new StoreRepository();
const magazins = new MagazinRepository();

/**
 * Announce a stock-request outcome to the party that needs to hear it.
 *
 * **Post-commit and fire-and-forget**, the house convention: the event is never
 * inside the transaction that caused it, and a failed notification must not roll
 * back a settled negotiation.
 *
 * `recipientRole` is the discriminator both notification stacks branch on — the
 * vendor handler and the agency handler each subscribe to all three situations and
 * return early on payloads that aren't theirs, exactly as `connection.*` does.
 * There is no `withdrawn` situation: retracting a request nobody acted on is not
 * news worth pushing, which is the same call the connection flow makes.
 *
 * Only the name the **recipient** needs is looked up — the vendor is told which
 * agency, the agency which vendor — following `AgentContractService.notifyHandshake`.
 * Business names resolve from the Store / Magazin, never a role profile.
 */
export function emitStockRequestEvent(
  eventType: StockRequestEventType,
  request: IStockAdjustmentRequest,
  recipientRole: StockRequestParty,
  context: StockRequestEventContext,
): void {
  const requestId = request._id.toString();
  const vendorId = request.vendor_id.toString();
  const agencyId = request.agency_id.toString();

  void (async () => {
    const [vendorName, agencyName] = recipientRole === 'vendor'
      ? [null, await magazins.findNameByAgencyId(agencyId)]
      : [await stores.findNameByVendorId(vendorId), null];

    await eventBus.publish(eventType, {
      eventType,
      aggregateId: requestId,
      occurredAt: new Date(),
      payload: {
        requestId,
        recipientRole,
        vendorId,
        agencyId,
        productId: request.product_id.toString(),
        variantId: request.variant_id.toString(),
        requestedByRole: request.requested_by_role,
        quantityBefore: request.quantity_before,
        requestedQuantity: request.requested_quantity,
        note: request.note ?? null,
        productTitle: context.productTitle,
        sku: context.sku,
        vendorName: vendorName ?? '',
        agencyName: agencyName ?? '',
      },
    });
  })().catch(err => console.error(`[StockRequestService] ${eventType} emit failed:`, err));
}
