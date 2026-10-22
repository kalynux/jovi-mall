/**
 * Listings module — informational service listings (SERVICE-LISTINGS-PLAN).
 *
 * The barrel exports the module's SERVICES and its subscriber registration. Routers are
 * deliberately NOT re-exported: `src/api/index.ts` imports each router from its own file,
 * because routers depend on auth.middleware → auth.service, and a barrel that re-exports them
 * is how a require cycle crashes at boot (the note above the agent mounts in that file).
 */
import { eventBus, DomainEvent } from '../../core/events/event-bus';
import { logger } from '../../core/logging';
import { WALLET_CREDITED_EVENT } from '../billing/domain/wallet-credited.event';
import { listingFundingService } from './domain/services/listing-funding.service';

export { listingFundingService, ListingFundingService } from './domain/services/listing-funding.service';
export type { FundingOutcome } from './domain/services/listing-funding.service';
export { listingVectorisationService } from './domain/services/listing-vectorisation.service';
export { listingProviderService } from './domain/services/listing-provider.service';
export { listingReviewService } from './domain/services/listing-review.service';
export { publicListingService } from './domain/services/public-listing.service';
export { listingRepository } from './repositories/listing.repository';
export { listingContactRepository } from './repositories/listing-contact.repository';

let registered = false;

/**
 * Subscribe the listings module to the bus. Call ONCE at startup (`src/lifecycle.ts`), beside
 * the other consumers.
 *
 *   billing.wallet.credited (published by billing after EVERY credit — top-up, plan allowance,
 *   refund, adjustment; payload `{ type, ownerType, ownerId, balanceAfter, reasonCode }`) →
 *   `reconcileIfProvider(ownerId)`: a provider whose balance is back at
 *   or above the first-reveal cost has every `insufficient_credits` suspension restored to its
 *   exact previous status (L-10 "comes back live on its own"). Only `ownerType: 'vendor'`, and
 *   only provider vendors — a seller's top-up costs one projected read and moves nothing.
 *
 * The event is a NUDGE. It is in-process and lossy, so a dropped one costs latency, never
 * correctness: `listingFundingService.reconcileAllProviderFunding()` is the backstop.
 */
export function registerListingSubscribers(
  // Injectable for the live suite only (a stubbed vectoriser); production passes nothing.
  funding: Pick<typeof listingFundingService, 'reconcileIfProvider'> = listingFundingService,
): void {
  if (registered) return;
  registered = true;
  eventBus.subscribe(
    WALLET_CREDITED_EVENT,
    async (event: DomainEvent) => {
      const ownerType = event.payload?.ownerType;
      const ownerId = event.payload?.ownerId;
      if (ownerType !== 'vendor' || typeof ownerId !== 'string' || !ownerId) return;
      const outcome = await funding.reconcileIfProvider(ownerId);
      if (outcome && (outcome.resumed.length || outcome.suspended.length)) {
        logger().info(
          { vendorId: ownerId, resumed: outcome.resumed.length, suspended: outcome.suspended.length },
          'listings: funding reconciled after a wallet credit',
        );
      }
    },
    'ListingSubscribers.onWalletCredited',
  );
}
