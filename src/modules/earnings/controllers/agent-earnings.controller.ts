import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { earningsAccountService } from '../services/earnings-account.service';

/**
 * Agent-facing earnings view: held (pending) vs withdrawable (available) balance
 * for the agent's own escrow account. Mirrors Vendor/AgencyEarningsController.
 * Mounted at `/api/agent` → `/agent/earnings`.
 *
 * An agent's balance is their cut of the delivery fees on runs they completed —
 * carved out of the agency's share per their contract's `fee_split`, on COD
 * collections (`splitCodCollection`) and online-paid deliveries
 * (`splitShipmentDelivery`) alike. The agency owes it under the contract, but the
 * PLATFORM pays it, through this account and the ordinary payout pipeline; nobody
 * is paid off-platform.
 */
export class AgentEarningsController {
  static getEarnings = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const balances = await earningsAccountService.getBalances('agent', agentId);
    res.status(200).json({ success: true, data: balances });
  });
}
