import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { aiCopyRateLimiter } from '../../../api/rate-limit/rate-limit.middleware';
import { VendorAiCopyController } from '../controllers/vendor-ai-copy.controller';

/**
 * `/api/vendor/ai` — the vendor dashboard's writing assistant.
 *
 * The rate limiter sits AFTER `requireRole`, so it counts per vendor (identity scope needs
 * `req.auth`) and an unauthenticated caller is refused before it spends a slot.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole(['vendor']));

router.post('/listing-copy', aiCopyRateLimiter, VendorAiCopyController.generate);

export default router;
