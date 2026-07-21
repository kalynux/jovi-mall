import { Router } from 'express';
import { requireAuth } from '../../api/middlewares/auth.middleware';
import { GeoController } from './controllers/geo.controller';

/**
 * Geocoding routes — the address-search workflow shared by every role. Any
 * signed-in user (customer, vendor, agency, agent, admin) can search for an
 * address to attach to their profile/order, so this is gated on auth only, not
 * on a specific role.
 */
const router = Router();

router.use(requireAuth);

/** GET /api/geo/search — free-form text → candidate locations. */
router.get('/search', GeoController.search);

/** GET /api/geo/reverse — coordinate → best-matching address. */
router.get('/reverse', GeoController.reverse);

export default router;
