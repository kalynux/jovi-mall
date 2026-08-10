import { eventBus } from '../../../../core/events/event-bus';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';

/**
 * The three things an agency can do to a product it warehouses that the VENDOR has
 * to hear about. All three are one-directional — the agency took the action, so it
 * needs no telling.
 */
export type StorageProductEventType =
  | 'storage.depot_changed'
  | 'storage.product_suspended'
  | 'storage.product_unsuspended';

export interface StorageProductEventPayload {
  productId: string;
  vendorId: string;
  agencyId: string;
  note: string | null;
  /** `storage.depot_changed` only: the depot label the product moved to. */
  locationLabel?: string | null;
}

const magazins = new MagazinRepository();

/**
 * Tell the vendor. **Post-commit and fire-and-forget** — a failed notification must
 * not roll back a suspension the agency has already been told succeeded.
 *
 * `recipientRole: 'vendor'` is carried even though only the vendor stack subscribes:
 * the discriminator is the convention every two-role event here uses, and adding it
 * later would mean touching a handler that had learned to live without it.
 *
 * The agency's business name resolves from the Magazin, never the agency profile.
 */
export function emitStorageProductEvent(
  eventType: StorageProductEventType,
  payload: StorageProductEventPayload,
): void {
  void (async () => {
    const agencyName = await magazins.findNameByAgencyId(payload.agencyId);

    await eventBus.publish(eventType, {
      eventType,
      aggregateId: payload.productId,
      occurredAt: new Date(),
      payload: {
        ...payload,
        recipientRole: 'vendor',
        agencyName: agencyName ?? '',
      },
    });
  })().catch(err => console.error(`[AgencyStorage] ${eventType} emit failed:`, err));
}
