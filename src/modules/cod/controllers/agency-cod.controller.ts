import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { clearable } from '../../../core/validation/zod.helpers';
import { agentDepositService } from '../services/agent-deposit.service';
import { agencyRemittanceService } from '../services/agency-remittance.service';
import { codDiscrepancyService } from '../services/cod-discrepancy.service';
import { codSummaryService } from '../services/cod-summary.service';
import {
  CodPaginationQuerySchema,
  AgentDepositStatusSchema,
  RejectDepositSchema,
} from '../validators/cod.validators';

const RecordDepositSchema = z.object({
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid agent ID'),
  amount: z.number().int().positive('Amount must be a positive integer (minor units)'),
  note: clearable(z.string().trim().max(500)),
});

const ListDepositsQuerySchema = CodPaginationQuerySchema.extend({
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  status: AgentDepositStatusSchema.optional(),
});

const DeclareRemittanceSchema = z.object({
  amount: z.number().int().positive('Amount must be a positive integer (minor units)'),
  reference: z.string().trim().min(1, 'A transfer/receipt reference is required').max(200),
  note: clearable(z.string().trim().max(500)),
});

const ListRemittancesQuerySchema = CodPaginationQuerySchema.extend({
  status: z.enum(['declared', 'confirmed', 'rejected']).optional(),
});

const RaiseDiscrepancySchema = z.object({
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid agent ID'),
  type: z.enum(['cash_shortfall', 'other']),
  amount: z.number().int().min(0).nullable().optional().default(null),
  note: z.string().trim().min(1, 'Describe what happened').max(500),
});

const ListDiscrepanciesQuerySchema = CodPaginationQuerySchema.extend({
  status: z.enum(['open', 'resolved', 'written_off']).optional(),
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

/**
 * Agency COD Controller - the agency side of the cash chain: record cash
 * physically received from agents, and watch the agency's own cash position.
 */
export class AgencyCodController {
  /**
   * POST /api/agency/cod/deposits
   * Record cash received from one of this agency's agents — one step, because
   * the agency IS the receiving party and there is nobody to counter-sign.
   * Body: { agentId, amount, note? }
   */
  static recordDeposit = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { agentId, amount, note } = RecordDepositSchema.parse(req.body);

    const deposit = await agentDepositService.record({
      agencyId,
      agentId,
      amount,
      note,
      recordedByUserId: req.auth!.user.id,
    });

    res.status(201).json({
      success: true,
      data: {
        id: deposit._id.toString(),
        agentId,
        amount: deposit.amount,
        currency: deposit.currency,
        note: deposit.note,
        status: deposit.status,
        recordedAt: deposit.created_at,
      },
      message: 'Deposit recorded — the agent\'s outstanding cash was reduced.',
    });
  });

  /**
   * POST /api/agency/cod/deposits/:id/confirm
   * Confirm a handover THIS agency's agent declared. Money moves here: the
   * agent's liability falls and the contract's outstanding balance is drawn
   * down.
   */
  static confirmDeposit = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();

    const deposit = await agentDepositService.confirm({
      depositId: req.params.id,
      by: 'agency',
      agencyId,
      confirmedByUserId: req.auth!.user.id,
    });

    res.json({
      success: true,
      data: {
        id: deposit._id.toString(),
        agentId: deposit.agent_id.toString(),
        amount: deposit.amount,
        currency: deposit.currency,
        status: deposit.status,
        resolvedAt: deposit.resolved_at,
      },
      message: 'Deposit confirmed — the agent\'s outstanding cash was reduced.',
    });
  });

  /**
   * POST /api/agency/cod/deposits/:id/reject
   * Reject a declared handover (nothing arrived, or not that much). No money
   * moves; the agent's deposit clock resumes and an admin can see both sides.
   * Body: { reason }
   */
  static rejectDeposit = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { reason } = RejectDepositSchema.parse(req.body);

    const deposit = await agentDepositService.reject({
      depositId: req.params.id,
      by: 'agency',
      agencyId,
      reason,
      rejectedByUserId: req.auth!.user.id,
    });

    res.json({
      success: true,
      data: {
        id: deposit._id.toString(),
        agentId: deposit.agent_id.toString(),
        amount: deposit.amount,
        status: deposit.status,
        rejectionReason: deposit.rejection_reason,
        resolvedAt: deposit.resolved_at,
      },
      message: 'Deposit rejected — nothing was settled.',
    });
  });

  /**
   * GET /api/agency/cod/deposits — this agency's deposit history.
   * Query: agentId?, status?, page?, limit? — `status=declared` is the inbox of
   * handovers this agency still has to answer.
   */
  static listDeposits = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { page, limit, agentId, status } = ListDepositsQuerySchema.parse(req.query);

    const result = await agentDepositService.listForAgency(agencyId, page, limit, {
      agentId,
      status,
    });

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * GET /api/agency/cod/summary
   * The agency's cash position: what it owes the platform, cash out with each
   * agent, and collected cash not yet covered by a confirmed remittance.
   */
  static summary = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();

    const summary = await codSummaryService.agencySummary(agencyId);

    res.json({ success: true, data: summary });
  });

  /**
   * POST /api/agency/cod/remittances
   * Declare a cash transfer to the platform. An admin confirms receipt, which
   * lowers the agency's liability and settles collections FIFO.
   * Body: { amount, reference, note? }
   */
  static declareRemittance = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { amount, reference, note } = DeclareRemittanceSchema.parse(req.body);

    const remittance = await agencyRemittanceService.declare({
      agencyId,
      amount,
      reference,
      note,
      declaredByUserId: req.auth!.user.id,
    });

    res.status(201).json({
      success: true,
      data: {
        id: remittance._id.toString(),
        amount: remittance.amount,
        currency: remittance.currency,
        reference: remittance.reference,
        status: remittance.status,
        declaredAt: remittance.declared_at,
      },
      message: 'Remittance declared — awaiting platform confirmation.',
    });
  });

  /** GET /api/agency/cod/remittances — this agency's remittance history. Query: status?, page?, limit? */
  static listRemittances = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { page, limit, status } = ListRemittancesQuerySchema.parse(req.query);

    const result = await agencyRemittanceService.listForAgency(agencyId, page, limit, status);

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * POST /api/agency/cod/discrepancies
   * Flag a cash problem with one of this agency's agents (e.g. handed over
   * less than held). Applies the trust penalty; admin resolves.
   * Body: { agentId, type: 'cash_shortfall' | 'other', amount?, note }
   */
  static raiseDiscrepancy = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { agentId, type, amount, note } = RaiseDiscrepancySchema.parse(req.body);

    const discrepancy = await codDiscrepancyService.raiseByAgency({
      agencyId,
      agentId,
      type,
      amount,
      note,
      raisedByUserId: req.auth!.user.id,
    });

    res.status(201).json({
      success: true,
      data: {
        id: discrepancy._id.toString(),
        agentId,
        type: discrepancy.type,
        amount: discrepancy.amount,
        status: discrepancy.status,
        openedAt: discrepancy.opened_at,
      },
      message: 'Discrepancy raised — an admin will review and resolve it.',
    });
  });

  /** GET /api/agency/cod/discrepancies — this agency's flags. Query: status?, agentId?, page?, limit? */
  static listDiscrepancies = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { page, limit, status, agentId } = ListDiscrepanciesQuerySchema.parse(req.query);

    const result = await codDiscrepancyService.list({ agencyId, agentId, status }, page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });
}
