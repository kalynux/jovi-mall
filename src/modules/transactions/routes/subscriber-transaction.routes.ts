import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import {
  AgencyTransactionController,
  AgentTransactionController,
} from '../controllers/vendor-transaction.controller';

/**
 * Agency + agent unified transaction feeds. Mounted at `/api/agency/transactions`
 * and `/api/agent/transactions` (each a separate router with its own role guard).
 */
export const agencyTransactionRouter = Router();
agencyTransactionRouter.use(requireAuth);
agencyTransactionRouter.use(requireRole(['agency']));
agencyTransactionRouter.get('/', AgencyTransactionController.list);

export const agentTransactionRouter = Router();
agentTransactionRouter.use(requireAuth);
agentTransactionRouter.use(requireRole(['agent']));
agentTransactionRouter.get('/', AgentTransactionController.list);
