import { ProductRepositoryMongo } from '../../../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../../repositories/mongo/variant.repository.mongo';
import { AvailabilityService } from '../../../../booking/services/availability.service';
import { SlotGeneratorService } from '../../../../booking/services/slot-generator.service';
import { BookingService } from '../../../../booking/services/booking.service';
import { BookingPriceResolver } from './BookingPriceResolver';
import { SlotLockFacade } from './SlotLockFacade';
import { ProductBookingService } from './ProductBookingService';

/**
 * The one wired `ProductBookingService`, for callers that want the seven-dependency
 * graph rather than the class.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `ProductBookingService` takes seven collaborators, and `product-booking.routes.ts`
 * hand-assembled them at module scope. When the bot surface needed the same service
 * (MCP parity step 4), the choice was a second copy of that assembly or one shared
 * instance — and a second copy is a second chance to pass a differently-configured
 * `AvailabilityService`, which would show up as the two doors disagreeing about when a
 * product is free. That is the failure this surface's whole "everything delegates" rule
 * exists to prevent, so the assembly moved here and both callers import it.
 *
 * The class stays exported from the barrel: the two `src/scripts/` harnesses construct
 * their own with stubs, and injection is the point of taking the dependencies at all.
 *
 * Module-scope construction matches the rest of the codebase's manual DI (`reviewService`,
 * `wishlistService`, `recentlyViewedService`). Nothing here opens a connection at import —
 * the repositories resolve their Mongoose models lazily — so this is safe to pull into a
 * DB-free test's import graph.
 */
export const productBookingService = new ProductBookingService(
    new ProductRepositoryMongo(),
    new AvailabilityService(),
    new SlotGeneratorService(),
    new BookingService(),
    new BookingPriceResolver(new VariantRepositoryMongo()),
    new VariantRepositoryMongo(),
    new SlotLockFacade(),
);
