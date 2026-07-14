import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { cashCollectionService } from '../services/cash-collection.service';
import { codCashAccountService } from '../services/cod-cash-account.service';
import { codExposureService } from '../services/cod-exposure.service';
import { agentDepositService } from '../services/agent-deposit.service';
import { CollectCashSchema, CodPaginationQuerySchema } from '../validators/cod.validators';
import { IDeliveryAgent } from '../../delivery/delivery-agent.model';

/**
 * Agent COD Controller - the agent side of cash on delivery: submit the
 * customer's delivery code at handoff (records the cash + delivers the
 * shipment) and re-request a code for the customer.
 */
export class AgentCodController {
  /**
   * POST /api/agent/shipments/:id/cod/collect
   * Body: { code, location?: {lat,lng}, deviceInfo? }
   */
  static collect = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const agentUserId = req.auth!.user.id;
    const shipmentId = req.params.id;
    const input = CollectCashSchema.parse(req.body);

    const result = await cashCollectionService.collect(agentId, agentUserId, shipmentId, {
      code: input.code,
      location: input.location ?? null,
      deviceInfo: input.deviceInfo ?? null,
      ip: req.ip ?? null,
    });

    res.json({
      success: true,
      data: result,
      message: 'Cash collected and shipment delivered.',
    });
  });

  /**
   * POST /api/agent/shipments/:id/cod/resend-code
   * Sends a FRESH code to the customer (locked or lost code). Rate-limited.
   */
  static resendCode = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const shipmentId = req.params.id;

    const result = await cashCollectionService.resendCodeAsAgent(agentId, shipmentId);

    res.json({
      success: true,
      data: result,
      message: 'A new delivery code was sent to the customer.',
    });
  });

  /**
   * GET /api/agent/cod/balance
   * The agent's full COD position: cash held (owed to the agency), current
   * exposure (held + pending collections), effective exposure limit after
   * trust scaling, and the trust score itself.
   */
  static getBalance = asyncHandler(async (req: Request, res: Response) => {
    const agent = req.auth!.role_entity as IDeliveryAgent;
    const agentId = agent._id.toString();

    const [{ balance, currency }, exposure] = await Promise.all([
      codCashAccountService.getBalance('agent', agentId),
      codExposureService.currentExposure(agentId),
    ]);

    res.json({
      success: true,
      data: {
        cashHeld: balance,
        currency,
        currentExposure: exposure,
        effectiveExposureLimit: codExposureService.effectiveLimit(agent),
        trustScore: agent.cod?.trust_score ?? 100,
      },
    });
  });

  /** GET /api/agent/cod/ledger — append-only history of this agent's cash movements. */
  static getLedger = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);

    const result = await codCashAccountService.getLedger('agent', agentId, page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /** GET /api/agent/cod/deposits — this agent's recorded cash hand-overs. */
  static listDeposits = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);

    const result = await agentDepositService.listForAgent(agentId, page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });
}
