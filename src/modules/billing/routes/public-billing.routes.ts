import { Router } from 'express';
import { PublicBillingController } from '../controllers/public-billing.controller';

/**
 * Public billing routes — the published price list, readable without a session.
 * Mounted at `/api/public` → `/public/plans`, `/public/credit-packs`.
 *
 * ⚠️ There is **no `requireAuth`** on this router, and that is the whole point.
 * It is therefore the one billing router where a mistake is visible to the world:
 * every handler mounted here must be a read of data that is already published on
 * a marketing page. Nothing owner-scoped, nothing that reads `req.auth`, nothing
 * that writes. A new endpoint that needs to know *who* is asking does not belong
 * here — it belongs on the role router, behind `requireAuth`.
 */
const router = Router();

/** Active plan catalog; `?role=` narrows, `?includeInactive=true` adds unlaunched tiers. */
router.get('/plans', PublicBillingController.listPlans);

/** Credit top-up packs + the per-action credit costs. */
router.get('/credit-packs', PublicBillingController.listCreditPacks);

export default router;
