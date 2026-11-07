import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { AgentEarningsController } from '../controllers/agent-earnings.controller';
import { PayoutRequestController } from '../controllers/payout-request.controller';
import { EarningsExplanationsController } from '../controllers/earnings-explanations.controller';

/**
 * Agent earnings routes. Mounted at `/api/agent` → `/agent/earnings`.
 *
 * The payout endpoints are the SHARED controller, unchanged: it derives the
 * owner bucket from `req.auth!.role`, and every layer below it already handled
 * `'agent'` (PayoutRequest.owner_type, the auto-threshold sweep,
 * PayoutRequestService.resolvePreferredPayoutMethod). Only this entry point was
 * missing — agents accrued a balance they could neither see nor withdraw.
 *
 * The destination the money is paid to is set separately, via
 * `PUT /api/agent/payout-methods` (see agents/routes/agent.routes.ts) — same
 * split as vendor/agency, where the payout method lives on the profile.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['agent']));

router.get('/earnings', AgentEarningsController.getEarnings);

// Why money was taken back (a refund at the delivery's fault) — 2026-10-22.
router.get('/earnings/adjustments', EarningsExplanationsController.listMyAdjustments);

// Request a payout of the entire available balance; opens a PAYOUT_REQUEST ticket.
router.post('/earnings/payout', PayoutRequestController.requestPayout);
router.get('/earnings/payout', PayoutRequestController.getCurrent);

export default router;
