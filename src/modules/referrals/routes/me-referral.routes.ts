import { Router } from 'express';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { MeReferralController } from '../controllers/me-referral.controller';

/**
 * The referral page, shared across every role. Mounted once at `/api/me/referral`, above the
 * catch-all `/me` router; the partner is resolved from `req.auth`.
 */
const router = Router();

router.use(requireAuth);

router.get('/', MeReferralController.overview);
router.post('/application', MeReferralController.apply);
router.get('/referred', MeReferralController.referred);
router.get('/rewards', MeReferralController.rewards);
router.get('/payouts', MeReferralController.payouts);
router.post('/payout', MeReferralController.requestPayout);
router.put('/payout-method', MeReferralController.setPayoutMethod);

export default router;
