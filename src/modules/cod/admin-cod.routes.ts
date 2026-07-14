import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { AdminCodController } from './controllers/admin-cod.controller';

/**
 * Admin COD Routes
 *
 * Path: /api/admin/cod — platform oversight of the cash-on-delivery chain.
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['admin']));

/**
 * GET /api/admin/cod/overview
 * Platform-wide cash position: cash held by agents, agency liabilities,
 * unsettled collections.
 */
router.get('/overview', AdminCodController.overview);

/** GET /api/admin/cod/remittances — all agencies' remittances. Query: status?, agencyId?, page?, limit? */
router.get('/remittances', AdminCodController.listRemittances);

/**
 * POST /api/admin/cod/remittances/:id/confirm
 * Confirm cash receipt: lowers the agency's liability, FIFO-settles its
 * collections and unlocks the earnings those collections back.
 */
router.post('/remittances/:id/confirm', AdminCodController.confirmRemittance);

/**
 * POST /api/admin/cod/remittances/:id/reject
 * Reject a declared remittance (nothing arrived / mismatch). Body: { reason }
 */
router.post('/remittances/:id/reject', AdminCodController.rejectRemittance);

/** GET /api/admin/cod/discrepancies — all flags. Query: status?, agencyId?, agentId?, page?, limit? */
router.get('/discrepancies', AdminCodController.listDiscrepancies);

/**
 * POST /api/admin/cod/discrepancies/:id/resolve
 * Close a flag ('resolved' | 'written_off'); unblocks the agency's reserve
 * releases. Body: { resolution, note }
 */
router.post('/discrepancies/:id/resolve', AdminCodController.resolveDiscrepancy);

/** GET /api/admin/cod/agents — agents currently holding cash (+ trust context). */
router.get('/agents', AdminCodController.listAgents);

/**
 * POST /api/admin/cod/agents/:id/trust-adjustment
 * Manual trust-score correction. Body: { delta: -100..100, note }
 */
router.post('/agents/:id/trust-adjustment', AdminCodController.adjustTrust);

/** GET /api/admin/cod/agencies — agencies currently owing the platform cash. */
router.get('/agencies', AdminCodController.listAgencies);

export default router;
