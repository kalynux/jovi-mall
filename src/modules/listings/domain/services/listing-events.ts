import { eventBus } from '../../../../core/events/event-bus';
import { logger } from '../../../../core/logging';
import { LISTING_EVENTS } from '../../domain/listing.types';

/**
 * Publish a listing domain event (§ C-5) — post-commit and fire-and-forget, the bus's
 * convention. Never call this inside a transaction: a rolled-back approval must not have told
 * the vendor it was approved.
 *
 * Payload: `{ listingId, vendorId, ...extra }` — `listing.suspended` adds `{ reason }`.
 */
export type ListingEventType = (typeof LISTING_EVENTS)[keyof typeof LISTING_EVENTS];

export function publishListingEvent(
  type: ListingEventType,
  listingId: string,
  vendorId: string,
  extra: Record<string, unknown> = {},
): void {
  void eventBus
    .publish(type, {
      eventType: type,
      aggregateId: listingId,
      occurredAt: new Date(),
      payload: { listingId, vendorId, ...extra },
    })
    .catch((err) => logger().error({ err, type, listingId }, 'listings: event publish failed'));
}

/**
 * Plan-quota's "room reappeared" nudge — the payload the archive/delete paths of products and
 * files already publish (`catalog/controllers/vendor-product.controller.ts`), so the quota sweep
 * can return a quota-suspended listing when another is archived.
 */
export function publishCapacityFreed(vendorId: string): void {
  void eventBus
    .publish('quota.capacity_freed', {
      eventType: 'quota.capacity_freed',
      aggregateId: vendorId,
      occurredAt: new Date(),
      payload: { ownerType: 'vendor', ownerId: vendorId },
    })
    .catch((err) => logger().error({ err, vendorId }, 'listings: capacity_freed publish failed'));
}
