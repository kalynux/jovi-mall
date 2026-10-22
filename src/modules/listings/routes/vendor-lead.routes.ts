import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { requireVendorKind } from '../../../api/middlewares/vendor-kind.middleware';

/**
 * A provider's leads (SERVICE-LISTINGS-PLAN § C-3, walk-order steps 6, 7 and 9).
 *
 *   GET  /api/vendor/leads                    masked list, newest first
 *   POST /api/vendor/leads/:leadId/call-me    the call-me template
 *   POST /api/vendor/leads/:leadId/message    free text, window-aware
 *   POST /api/vendor/leads/:leadId/report     one LISTING_LEAD_REPORT ticket (L-31)
 *
 * Mounted by the lead in wave 0 at its OWN prefix, so the router-level provider guard is safe
 * (it never runs for another `/vendor/*` mount). The messaging builder fills it.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole(['vendor']));
// Vendor kind (SERVICE-LISTINGS-PLAN § C-1): PROVIDER — leads are a provider's.
router.use(requireVendorKind('provider'));

export default router;
